// mcp-tasks-wire.ts - Raw JSON-RPC over transport for the MCP Tasks extension
// (SEP-2663, io.modelcontextprotocol/tasks).
//
// The official @modelcontextprotocol/client 2.0.0 does not implement the
// SEP-2663 tasks extension: it treats tasks/* as deprecated 2025-11-25 wire
// vocabulary with no runtime, its outbound era gate refuses to send them on a
// 2026-07-28 connection, and decodeResult rejects resultType: "task" with
// UnsupportedResultType.
//
// This module bypasses the SDK's request funnel entirely and speaks directly
// to the transport (transport.send + transport.onmessage), which are public
// transport-interface members. The pattern mirrors mcp-trace.ts's
// wrapTransportWithMcpTrace: we chain onto transport.onmessage to intercept
// inbound messages, and use transport.send() to emit raw JSON-RPC requests.
//
// Three responsibilities:
//   1. sendTaskRequest — send a raw JSON-RPC request over transport and match
//      the response by id (with timeout + abort). Used for tasks/get,
//      tasks/update, tasks/cancel, and the task-augmented tools/call.
//   2. installTaskMessageInterceptor — chain onto transport.onmessage to
//      intercept resultType: "task" results and notifications/tasks pushes
//      before the SDK's decodeResult can reject them.
//   3. buildTasksDeclarationMeta — the _meta fragment declaring
//      io.modelcontextprotocol/tasks eligibility for a per-request opt-in.

import type { Transport } from "./types.ts";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";

/** SEP-2133 extension identifier for the Tasks extension (SEP-2663). */
export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** The _meta key under which a client declares its capabilities (2026-07-28). */
export const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Extension request methods (no tasks/list, no tasks/result in SEP-2663). */
export const TASKS_GET_METHOD = "tasks/get";
export const TASKS_UPDATE_METHOD = "tasks/update";
export const TASKS_CANCEL_METHOD = "tasks/cancel";

/** Optional server→client task notification (delivered via subscriptions/listen). */
export const TASKS_NOTIFICATION_METHOD = "notifications/tasks";

/** The three extension request methods as a list. */
export const TASKS_REQUEST_METHODS = [
  TASKS_GET_METHOD,
  TASKS_UPDATE_METHOD,
  TASKS_CANCEL_METHOD,
] as const;

/** Task lifecycle status values (SEP-2663). Terminal: completed/failed/cancelled. */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** A create-task result returned by a task-augmented tools/call (SEP-2663 flat shape). */
export interface CreateTaskResult {
  resultType: "task";
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, InputRequest>;
}

/** A tasks/get response carrying the current task state. */
export interface TaskState {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  /** Present on completed. */
  result?: unknown;
  /** Present on failed (JSON-RPC error shape). */
  error?: { code: number | string; message: string; data?: unknown };
  /** Present on input_required. */
  inputRequests?: Record<string, InputRequest>;
}

/** An embedded server→client request surfaced inside an input_required task. */
export interface InputRequest {
  method: string;
  params: unknown;
}

export interface TaskMessageHandler {
  /** Called when a tools/call result carries resultType: "task". */
  onCreateTaskResult?(serverName: string, requestId: string | number, result: CreateTaskResult): void;
  /** Called when a notifications/tasks push arrives (full task state). */
  onTaskNotification?(serverName: string, task: TaskState): void;
}

export interface TaskMessageInterceptor extends TaskMessageHandler {
  /** Remove the interceptor from the transport's onmessage chain. */
  detach(): void;
}

/**
 * Chain an interceptor onto a transport's onmessage without disrupting the
 * SDK's own message handler. Returns a detach function.
 *
 * The SDK's ProbeWindow and mcp-trace.ts both use this pattern: save the
 * current onmessage, install a new one that inspects (and possibly consumes)
 * the message, then forwards to the saved handler. We NEVER consume a message
 * here — the SDK still needs to see its results, even if it will reject some
 * with UnsupportedResultType. The rejection is caught upstream in executeCall.
 */
export function installTaskMessageInterceptor(
  transport: Transport,
  serverName: string,
  handler: TaskMessageHandler,
): () => void {
  let savedOnMessage = transport.onmessage;
  let active = true;

  const wrappedOnMessage = (message: JSONRPCMessage, extra?: unknown): void => {
    try {
      if (active && isJSONRPCResponse(message)) {
        const result = (message as { result?: unknown }).result;
        if (isRecord(result) && (result as { resultType?: string }).resultType === "task") {
          const createTask = extractCreateTaskResult(result);
          if (createTask) {
            handler.onCreateTaskResult?.(serverName, message.id!, createTask);
          }
        }
      }
      if (active && isJSONRPCNotification(message) && message.method === TASKS_NOTIFICATION_METHOD) {
        const task = extractTaskState(message.params);
        if (task) handler.onTaskNotification?.(serverName, task);
      }
    } catch {
      // Interceptor failures must never disrupt the SDK's message flow.
    }
    // Always forward to the SDK's handler (even after detach, to be safe).
    if (typeof savedOnMessage === "function") {
      (savedOnMessage as (msg: JSONRPCMessage, extra?: unknown) => void)(message, extra);
    }
  };

  transport.onmessage = wrappedOnMessage;

  return () => {
    active = false;
    if (transport.onmessage === wrappedOnMessage) {
      transport.onmessage = savedOnMessage;
    }
    savedOnMessage = undefined;
  };
}

/**
 * Send a raw JSON-RPC request over the transport and wait for the matching
 * response by id. Bypasses the SDK's era gate and decodeResult entirely.
 *
 * The caller is responsible for building a complete _meta envelope if the
 * request needs one (use buildTasksDeclarationMeta + envelope helpers).
 */
export async function sendTaskRequest<T = unknown>(
  transport: Transport,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; result: T } | { ok: false; error: { code: number | string; message: string; data?: unknown } }> {
  const id = generateRequestId();
  const request: JSONRPCMessage = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  } as JSONRPCMessage;

  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Temporarily chain onmessage to intercept the response by id.
    const savedOnMessage = transport.onmessage;
    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      if (transport.onmessage === responseHandler) {
        transport.onmessage = savedOnMessage;
      }
    };

    const responseHandler = (message: JSONRPCMessage): void => {
      if (settled) return;
      if (!isJSONRPCResponse(message) || message.id !== id) return;
      cleanup();
      if ("error" in message && message.error) {
        resolve({ ok: false, error: message.error as { code: number | string; message: string; data?: unknown } });
      } else {
        resolve({ ok: true, result: (message as { result: unknown }).result as T });
      }
    };

    transport.onmessage = responseHandler;
    options.signal?.addEventListener("abort", () => {
      if (settled) return;
      cleanup();
      resolve({ ok: false, error: { code: -32099, message: "aborted" } });
    }, { once: true });

    if (options.signal?.aborted) {
      cleanup();
      resolve({ ok: false, error: { code: -32099, message: "aborted" } });
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve({ ok: false, error: { code: -32000, message: `tasks request '${method}' timed out after ${timeoutMs}ms` } });
    }, timeoutMs);
    timer.unref?.();

    transport.send(request).catch((error) => {
      if (settled) return;
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      resolve({ ok: false, error: { code: -32603, message: `transport send failed: ${message}` } });
    });
  });
}

/**
 * Build the _meta fragment that declares io.modelcontextprotocol/tasks
 * eligibility for a single request. Merged into the request's _meta by the
 * caller; the SDK's auto-envelope (protocolVersion/clientInfo/clientCapabilities)
 * is NOT touched because we bypass the SDK funnel for tasks requests.
 *
 * For tools/call via the SDK's callTool (when we want the SDK to handle the
 * request but still declare task eligibility), the caller must merge this into
 * the per-request _meta carefully — see the executeCall integration.
 */
export function buildTasksDeclarationMeta(): Record<string, unknown> {
  return {
    [CLIENT_CAPABILITIES_META_KEY]: {
      extensions: {
        [MCP_TASKS_EXTENSION_ID]: {},
      },
    },
  };
}

// ─── internal helpers ──────────────────────────────────────────────────────

let requestCounter = 0;

function generateRequestId(): number {
  // Use a large offset to avoid collisions with the SDK's own request ids
  // (which are typically small sequential integers starting from 0 or 1).
  // Tasks requests bypass the SDK funnel, so id collision would cause the SDK
  // to receive a response it didn't expect.
  return 0x7fff_0000 + (++requestCounter);
}

function isJSONRPCResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: number | string; result?: unknown; error?: unknown } {
  return "id" in message && (message as { id?: unknown }).id !== undefined && ("result" in message || "error" in message);
}

function isJSONRPCNotification(message: JSONRPCMessage): message is JSONRPCMessage & { method: string; params?: unknown } {
  return "method" in message && !("id" in message);
}

function extractCreateTaskResult(value: unknown): CreateTaskResult | undefined {
  if (!isRecord(value)) return undefined;
  const taskId = value.taskId;
  if (typeof taskId !== "string") return undefined;
  const status = value.status;
  if (!isTaskStatus(status)) return undefined;
  return {
    resultType: "task",
    taskId,
    status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    lastUpdatedAt: typeof value.lastUpdatedAt === "string" ? value.lastUpdatedAt : new Date().toISOString(),
    ttlMs: value.ttlMs === null ? null : (typeof value.ttlMs === "number" ? value.ttlMs : null),
    ...(typeof value.pollIntervalMs === "number" ? { pollIntervalMs: value.pollIntervalMs } : {}),
    ...(isRecord(value.inputRequests) ? { inputRequests: value.inputRequests as Record<string, InputRequest> } : {}),
  };
}

function extractTaskState(params: unknown): TaskState | undefined {
  if (!isRecord(params)) return undefined;
  const taskId = params.taskId;
  if (typeof taskId !== "string") return undefined;
  const status = params.status;
  if (!isTaskStatus(status)) return undefined;
  return {
    taskId,
    status,
    createdAt: typeof params.createdAt === "string" ? params.createdAt : new Date().toISOString(),
    lastUpdatedAt: typeof params.lastUpdatedAt === "string" ? params.lastUpdatedAt : new Date().toISOString(),
    ttlMs: params.ttlMs === null ? null : (typeof params.ttlMs === "number" ? params.ttlMs : null),
    ...(typeof params.pollIntervalMs === "number" ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.result !== undefined ? { result: params.result } : {}),
    ...(isRecord(params.error) ? { error: params.error as { code: number | string; message: string; data?: unknown } } : {}),
    ...(isRecord(params.inputRequests) ? { inputRequests: params.inputRequests as Record<string, InputRequest> } : {}),
  };
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "working" || value === "input_required" || value === "completed" || value === "failed" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
