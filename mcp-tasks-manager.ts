// mcp-tasks-manager.ts - Background task lifecycle manager for MCP Tasks
// (SEP-2663, io.modelcontextprotocol/tasks).
//
// Receives a CreateTaskResult from executeCall (when a tools/call returns
// resultType: "task"), tracks the task in the background, polls tasks/get at
// the server-suggested interval (or accepts notifications/tasks pushes), and
// wakes the agent via pi.sendMessage({ triggerTurn: true }) when the task
// reaches a terminal state.
//
// The tool call that produced the task returns immediately to the agent with a
// compact task-handle summary — it does NOT block until completion. This is
// the core value of the Tasks extension: long-running operations don't tie up
// the connection or the agent's turn.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import type { McpExtensionState } from "./state.ts";
import type { ServerConnection } from "./server-manager.ts";
import type { Transport } from "./types.ts";
import {
  buildTasksDeclarationMeta,
  generateListenRequestId,
  installTaskMessageInterceptor,
  sendTaskRequest,
  type CreateTaskResult,
  type TaskState,
  type TaskStatus,
} from "./mcp-tasks-wire.ts";

interface TrackedTask {
  serverName: string;
  taskId: string;
  status: TaskStatus;
  pollIntervalMs: number;
  createdAt: number;
  lastPolledAt: number;
  /** Set of inputRequest keys already presented (for dedup). */
  resolvedInputKeys: Set<string>;
  /** The original tool name that produced this task, for the wake-up message. */
  toolName: string | undefined;
  /** Whether a terminal wake-up message has been sent. */
  woke: boolean;
  /** Abort controller for the polling loop. */
  abortController: AbortController;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_INPUT_ROUNDS = 10;

const TASKS_FILE = "mcp-tasks.json";

interface PersistedTask {
  serverName: string;
  taskId: string;
  status: TaskStatus;
  pollIntervalMs: number;
  toolName: string | undefined;
  createdAt: number;
}

function getTasksFilePath(): string {
  return getAgentPath(TASKS_FILE);
}

function loadPersistedTasks(): PersistedTask[] {
  const path = getTasksFilePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw.tasks)) return [];
    return raw.tasks.filter((t: unknown): t is PersistedTask =>
      isRecord(t)
      && typeof t.serverName === "string"
      && typeof t.taskId === "string"
      && typeof t.status === "string"
      && typeof t.pollIntervalMs === "number"
      && typeof t.createdAt === "number",
    );
  } catch {
    return [];
  }
}

function savePersistedTasks(tasks: Iterable<TrackedTask>): void {
  const path = getTasksFilePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const persisted: PersistedTask[] = [...tasks]
    .filter((t) => !isTerminal(t.status))
    .map((t) => ({
      serverName: t.serverName,
      taskId: t.taskId,
      status: t.status,
      pollIntervalMs: t.pollIntervalMs,
      toolName: t.toolName,
      createdAt: t.createdAt,
    }));
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ tasks: persisted }, null, 2), "utf8");
  renameSync(tmpPath, path);
}

export interface TaskManagerOptions {
  getState: () => McpExtensionState | null;
  pi: ExtensionAPI;
}

export class McpTasksManager {
  private tasks = new Map<string, TrackedTask>();
  /** Interceptors keyed by serverName, so we don't double-install on reconnect. */
  private interceptors = new Map<string, () => void>();
  private options: TaskManagerOptions;
  private samplingBridge: ((serverName: string, params: unknown) => Promise<unknown>) | undefined;

  constructor(options: TaskManagerOptions) {
    this.options = options;
  }

  /**
   * Set the sampling bridge for sampling/createMessage input requests inside
   * tasks. Called by the host during session_start when the ExtensionContext
   * (modelRegistry, currentModel) becomes available.
   */
  setSamplingBridge(bridge: (serverName: string, params: unknown) => Promise<unknown>): void {
    this.samplingBridge = bridge;
  }

  /**
   * Install the transport message interceptor for a connected server. Called
   * when a server connects (or reconnects). Idempotent per serverName.
   */
  attachServer(serverName: string): void {
    const state = this.options.getState();
    if (!state) return;
    const connection = state.manager.getConnection(serverName);
    if (!connection || connection.status !== "connected") return;

    // Detach any previous interceptor for this server (reconnect case).
    this.interceptors.get(serverName)?.();
    this.interceptors.delete(serverName);

    const detach = installTaskMessageInterceptor(
      connection.transport,
      serverName,
      {
        onCreateTaskResult: (srv, _reqId, result) => {
          // If executeCall registered a capture callback for this server, fire it.
          const capture = this.captureCallbacks.get(srv);
          if (capture) {
            this.captureCallbacks.delete(srv);
            capture(result);
          }
        },
        onTaskNotification: (srv, task) => {
          this.handleTaskNotification(srv, task);
        },
      },
    );
    this.interceptors.set(serverName, detach);

    // Start a task-filtered subscriptions/listen on the transport so the server
    // can push notifications/tasks instead of relying on polling alone.
    this.startListening(serverName, connection.transport);

    // Resume polling any non-terminal tasks persisted from a previous session
    // that belong to this server.
    this.resumePersistedTasks(serverName);
  }

  /**
   * Resume polling for tasks that were still running when Pi shut down.
   * Called after attachServer installs the interceptor + listen.
   */
  private resumePersistedTasks(serverName: string): void {
    const persisted = loadPersistedTasks();
    for (const p of persisted) {
      if (p.serverName !== serverName) continue;
      if (this.tasks.has(p.taskId)) continue; // already tracked
      const tracked: TrackedTask = {
        serverName: p.serverName,
        taskId: p.taskId,
        status: p.status,
        pollIntervalMs: p.pollIntervalMs,
        createdAt: p.createdAt,
        lastPolledAt: Date.now(),
        resolvedInputKeys: new Set(),
        toolName: p.toolName,
        woke: false,
        abortController: new AbortController(),
      };
      this.tasks.set(p.taskId, tracked);
      void this.pollLoop(tracked).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.wakeAgent(tracked, `Resumed MCP task ${p.taskId} on ${p.serverName} encountered an error: ${message}`, true);
      });
    }
  }

  detachServer(serverName: string): void {
    this.interceptors.get(serverName)?.();
    this.interceptors.delete(serverName);
    this.stopListening(serverName);
    // Cancel all tasks for this server — they can't be polled without a connection.
    for (const task of this.tasks.values()) {
      if (task.serverName === serverName) {
        task.abortController.abort();
      }
    }
  }

  shutdown(): void {
    for (const detach of this.interceptors.values()) detach();
    this.interceptors.clear();
    this.listenIds.clear();
    for (const task of this.tasks.values()) task.abortController.abort();
    this.tasks.clear();
  }

  private captureCallbacks = new Map<string, (result: CreateTaskResult) => void>();

  /**
   * Register a one-shot callback for the next CreateTaskResult from a server.
   * Used by executeCall to recover the task handle when the SDK's callTool
   * rejects a resultType: "task" response with UnsupportedResultType.
   */
  captureNextCreateTask(serverName: string, callback: (result: CreateTaskResult) => void): void {
    this.captureCallbacks.set(serverName, callback);
  }

  /** Active listen request ids per server, for cleanup on detach. */
  private listenIds = new Map<string, number>();

  /**
   * Start a task-filtered subscriptions/listen on the transport. The listen
   * request is sent directly via transport.send (bypassing the SDK funnel)
   * with the tasks declaration in _meta. The transport interceptor (installed
   * in attachServer) handles notifications/tasks pushes that arrive on the
   * stream. We don't wait for the listen response — it only arrives when the
   * stream closes. The request id is tracked for cancellation.
   */
  private startListening(serverName: string, transport: Transport): void {
    const id = generateListenRequestId();
    this.listenIds.set(serverName, id);

    const params: Record<string, unknown> = {
      notifications: { notifications: ["notifications/tasks"] },
      _meta: buildTasksDeclarationMeta(),
    };

    const request = { jsonrpc: "2.0" as const, id, method: "subscriptions/listen", params };
    transport.send(request as import("@modelcontextprotocol/client").JSONRPCMessage).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Listen failures are non-fatal — we fall back to polling.
      void message;
      this.listenIds.delete(serverName);
    });
  }

  /**
   * Cancel a server's subscriptions/listen by sending notifications/cancelled
   * referencing the listen request id. Best-effort — failures are ignored.
   */
  private stopListening(serverName: string): void {
    const id = this.listenIds.get(serverName);
    if (id === undefined) return;
    this.listenIds.delete(serverName);

    const state = this.options.getState();
    const connection = state?.manager.getConnection(serverName);
    if (!connection || connection.status !== "connected") return;

    const cancel = {
      jsonrpc: "2.0" as const,
      method: "notifications/cancelled",
      params: { requestId: id, reason: "tasks manager detach" },
    };
    connection.transport.send(cancel as import("@modelcontextprotocol/client").JSONRPCMessage).catch(() => {
      // Best-effort cleanup.
    });
  }

  /**
   * Called from executeCall when a tools/call returns a CreateTaskResult.
   * Returns the compact text to show the agent immediately (the task handle),
   * and starts the background polling loop.
   */
  trackTask(
    serverName: string,
    task: CreateTaskResult,
    toolName?: string,
  ): string {
    const pollIntervalMs = clampPollInterval(task.pollIntervalMs);
    const tracked: TrackedTask = {
      serverName,
      taskId: task.taskId,
      status: task.status,
      pollIntervalMs,
      createdAt: Date.now(),
      lastPolledAt: Date.now(),
      resolvedInputKeys: new Set(),
      toolName,
      woke: false,
      abortController: new AbortController(),
    };
    this.tasks.set(task.taskId, tracked);
    savePersistedTasks(this.tasks.values());

    // Start polling in the background. Do not await — the caller returns the
    // handle text to the agent immediately.
    void this.pollLoop(tracked).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.wakeAgent(tracked, `Background task ${task.taskId} on ${serverName} encountered an error: ${message}`, true);
    });

    return this.formatTaskHandle(task, serverName, toolName);
  }

  /**
   * Handle a notifications/tasks push (from the transport interceptor).
   * Updates the task state; if terminal, wakes the agent.
   */
  private handleTaskNotification(serverName: string, task: TaskState): void {
    const tracked = this.tasks.get(task.taskId);
    if (!tracked || tracked.serverName !== serverName) return;
    this.applyTaskState(tracked, task);
  }

  /**
   * Background polling loop. Polls tasks/get at pollIntervalMs until the task
   * reaches a terminal state or is aborted.
   */
  private async pollLoop(task: TrackedTask): Promise<void> {
    let inputRounds = 0;
    while (!task.abortController.signal.aborted) {
      await sleep(task.pollIntervalMs, task.abortController.signal);
      if (task.abortController.signal.aborted) return;

      const state = this.options.getState();
      if (!state) return;
      const connection = state.manager.getConnection(task.serverName);
      if (!connection || connection.status !== "connected") {
        // Connection lost; the task handle is durable, so we could resume
        // polling after reconnect. For now, wake the agent with a notice.
        if (!task.woke) {
          this.wakeAgent(task, `MCP task ${task.taskId} on ${task.serverName}: connection lost before task completed. The task may still be running on the server; reconnect and poll tasks/get to check.`, true);
        }
        return;
      }

      task.lastPolledAt = Date.now();
      const result = await this.fetchTaskState(connection, task.taskId, task.abortController.signal);
      if (!result.ok) {
        // A transient error; back off and retry on the next interval.
        if (result.error.code === -32099) return; // aborted
        continue;
      }

      const taskState = result.result as unknown;
      if (!isTaskState(taskState)) continue;

      this.applyTaskState(task, taskState);

      // Handle input_required.
      if (task.status === "input_required" && taskState.inputRequests) {
        if (++inputRounds > MAX_INPUT_ROUNDS) {
          if (!task.woke) {
            this.wakeAgent(task, `MCP task ${task.taskId} on ${task.serverName} stayed in input_required for too many rounds (${MAX_INPUT_ROUNDS}). The server may be stuck.`, true);
          }
          return;
        }
        await this.handleInputRequired(task, taskState.inputRequests, connection);
        continue;
      }

      if (isTerminal(task.status)) {
        return;
      }
    }
  }

  /**
   * Fetch the current task state via tasks/get (raw JSON-RPC over transport).
   */
  private async fetchTaskState(
    connection: ServerConnection,
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: number | string; message: string } }> {
    const params: Record<string, unknown> = {
      taskId,
      _meta: buildTasksDeclarationMeta(),
    };
    return sendTaskRequest(
      connection.transport,
      "tasks/get",
      params,
      { signal, timeoutMs: 30_000 },
    );
  }

  /**
   * Apply a fetched task state to a tracked task. If terminal, wake the agent.
   */
  private applyTaskState(task: TrackedTask, state: TaskState): void {
    task.status = state.status;
    if (state.pollIntervalMs) {
      task.pollIntervalMs = clampPollInterval(state.pollIntervalMs);
    }
    if (isTerminal(task.status) && !task.woke) {
      const resultText = formatTaskResult(task, state);
      this.wakeAgent(task, resultText, task.status === "failed");
      this.tasks.delete(task.taskId);
      savePersistedTasks(this.tasks.values());
    }
  }

  /**
   * Handle input_required by presenting inputRequests to the user via Pi's
   * elicitation UI, then submitting responses via tasks/update.
   */
  private async handleInputRequired(
    task: TrackedTask,
    inputRequests: Record<string, { method: string; params: unknown }>,
    connection: ServerConnection,
  ): Promise<void> {
    const state = this.options.getState();
    if (!state?.ui) return;

    const inputResponses: Record<string, unknown> = {};
    for (const [key, request] of Object.entries(inputRequests)) {
      if (task.resolvedInputKeys.has(key)) continue;
      task.resolvedInputKeys.add(key);

      // Bridge elicitation/create and sampling/createMessage through Pi's
      // existing UI. Other methods are surfaced as a generic confirmation.
      if (request.method === "elicitation/create") {
        // The adapter already has an elicitation handler; for now, surface a
        // generic prompt so the user can respond. A deeper integration would
        // route through the elicitation-handler's form/URL dialogs.
        const params = isRecord(request.params) ? request.params : {};
        const message = params.message ?? `Server ${task.serverName} requests input for task ${task.taskId}.`;
        const accepted = await state.ui.confirm("MCP Task Input Required", typeof message === "string" ? message : JSON.stringify(message));
        inputResponses[key] = { result: accepted ? "accepted" : "declined" };
      } else if (request.method === "sampling/createMessage") {
        // Bridge through the adapter's sampling handler (same one that handles
        // server-initiated sampling/createMessage JSON-RPC requests).
        if (this.samplingBridge) {
          try {
            const samplingResult = await this.samplingBridge(task.serverName, request.params);
            inputResponses[key] = { result: samplingResult };
          } catch (samplingError) {
            const message = samplingError instanceof Error ? samplingError.message : String(samplingError);
            inputResponses[key] = { error: { code: -32603, message: `sampling failed: ${message}` } };
          }
        } else {
          inputResponses[key] = { error: { code: -32601, message: "sampling within tasks not supported on this instance" } };
        }
      } else {
        inputResponses[key] = { error: { code: -32601, message: `unsupported input method: ${request.method}` } };
      }
    }

    // Submit the responses via tasks/update (raw JSON-RPC).
    await sendTaskRequest(
      connection.transport,
      "tasks/update",
      { taskId: task.taskId, inputResponses, _meta: buildTasksDeclarationMeta() },
      { signal: task.abortController.signal, timeoutMs: 30_000 },
    );
  }

  /**
   * Wake the agent with a message and trigger a new turn.
   */
  private wakeAgent(task: TrackedTask, text: string, isError: boolean): void {
    if (task.woke) return;
    task.woke = true;

    const display = isError
      ? `❌ MCP task failed: ${task.toolName ?? task.taskId} (${task.serverName})`
      : `✅ MCP task completed: ${task.toolName ?? task.taskId} (${task.serverName})`;

    const customType = isError ? "mcp-task-failed" : "mcp-task-completed";

    (this.options.pi as { sendMessage: (message: unknown, options?: { triggerTurn?: boolean }) => void }).sendMessage(
      {
        customType,
        content: [{ type: "text", text }],
        display,
        details: { serverName: task.serverName, taskId: task.taskId, toolName: task.toolName, isError },
      },
      { triggerTurn: true },
    );
  }

  /**
   * Format the compact task-handle text returned to the agent immediately
   * (instead of blocking for the result).
   */
  private formatTaskHandle(task: CreateTaskResult, serverName: string, toolName?: string): string {
    const lines = [
      `MCP background task started on server "${serverName}".`,
      ...(toolName ? [`Tool: ${toolName}`] : []),
      `Task ID: ${task.taskId}`,
      `Status: ${task.status}`,
      ...(task.pollIntervalMs ? [`Polling every ${task.pollIntervalMs}ms`] : []),
      ``,
      `The task is running in the background. You will be notified when it completes, fails, or needs input.`,
      `Do not block waiting for this task — continue with other work.`,
    ];
    return lines.join("\n");
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function clampPollInterval(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.round(ms)));
}

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTaskState(value: unknown): value is TaskState {
  if (!isRecord(value)) return false;
  return typeof value.taskId === "string" && typeof value.status === "string";
}

function formatTaskResult(task: TrackedTask, state: TaskState): string {
  if (task.status === "completed") {
    const resultText = state.result !== undefined ? JSON.stringify(state.result, null, 2) : "(no result)";
    return `MCP background task ${task.taskId} on ${task.serverName} completed.${task.toolName ? ` Tool: ${task.toolName}.` : ""}\n\nResult:\n${resultText}`;
  }
  if (task.status === "failed") {
    const errorText = state.error ? `${state.error.code}: ${state.error.message}` : "(no error details)";
    return `MCP background task ${task.taskId} on ${task.serverName} failed.\nError: ${errorText}`;
  }
  // cancelled
  return `MCP background task ${task.taskId} on ${task.serverName} was cancelled.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
