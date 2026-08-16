import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/client";
import {
  buildTasksDeclarationMeta,
  buildTasksDeclarationMetaWithCapabilities,
  CLIENT_CAPABILITIES_META_KEY,
  MCP_TASKS_EXTENSION_ID,
  installTaskMessageInterceptor,
  sendTaskRequest,
  type CreateTaskResult,
  type TaskState,
} from "../mcp-tasks-wire.ts";

function fakeTransport(overrides: Partial<Transport> = {}): Transport & {
  sentMessages: unknown[];
} {
  const sentMessages: unknown[] = [];
  return {
    start: vi.fn(async () => undefined),
    send: vi.fn(async (message: unknown) => { sentMessages.push(message); }),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as Transport & { sentMessages: unknown[] };
}

// ─── buildTasksDeclarationMeta ──────────────────────────────────────────────

describe("buildTasksDeclarationMeta", () => {
  it("declares the tasks extension under clientCapabilities", () => {
    const meta = buildTasksDeclarationMeta();
    const caps = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
    expect(caps).toBeDefined();
    expect(caps.extensions).toBeDefined();
    expect((caps.extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION_ID]).toEqual({});
  });
});

describe("buildTasksDeclarationMetaWithCapabilities", () => {
  it("merges tasks into existing capabilities without clobbering sampling/elicitation", () => {
    const capabilities = {
      sampling: {},
      elicitation: { form: {}, url: {} },
    };
    const meta = buildTasksDeclarationMetaWithCapabilities(capabilities);
    const caps = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;

    expect(caps.sampling).toEqual({});
    expect(caps.elicitation).toEqual({ form: {}, url: {} });
    expect(caps.extensions).toBeDefined();
    expect((caps.extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION_ID]).toEqual({});
  });

  it("preserves existing extensions and adds tasks", () => {
    const capabilities = {
      extensions: { "io.modelcontextprotocol/ui": {} },
    };
    const meta = buildTasksDeclarationMetaWithCapabilities(capabilities);
    const caps = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
    const extensions = caps.extensions as Record<string, unknown>;

    expect(extensions["io.modelcontextprotocol/ui"]).toEqual({});
    expect(extensions[MCP_TASKS_EXTENSION_ID]).toEqual({});
  });

  it("handles empty capabilities", () => {
    const meta = buildTasksDeclarationMetaWithCapabilities({});
    const caps = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
    expect(caps.extensions).toBeDefined();
    expect((caps.extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION_ID]).toEqual({});
  });
});

// ─── sendTaskRequest ───────────────────────────────────────────────────────

describe("sendTaskRequest", () => {
  it("sends a JSON-RPC request and resolves with the matched response", async () => {
    const transport = fakeTransport();
    const sendSpy = transport.send as ReturnType<typeof vi.fn>;

    // Simulate the server responding asynchronously after send completes.
    const originalSend = sendSpy.getMockImplementation()!;
    sendSpy.mockImplementation(async (message: unknown) => {
      const msg = message as { jsonrpc: string; id: number; method: string };
      // Defer the response to the next tick so onmessage is set first.
      queueMicrotask(() => {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: msg.id,
          result: { taskId: "t1", status: "working" },
        } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
      });
    });
    void originalSend;

    const result = await sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "t1" },
      { timeoutMs: 1000 },
    );

    expect(result.ok).toBe(true);
    expect((result as { result: { taskId: string } }).result.taskId).toBe("t1");
  });

  it("resolves with an error on a JSON-RPC error response", async () => {
    const transport = fakeTransport();
    const sendSpy = transport.send as ReturnType<typeof vi.fn>;

    sendSpy.mockImplementation(async (message: unknown) => {
      const msg = message as { id: number };
      queueMicrotask(() => {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32003, message: "missing capability" },
        } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
      });
    });

    const result = await sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "t1" },
      { timeoutMs: 1000 },
    );

    expect(result.ok).toBe(false);
    expect((result as { error: { code: number; message: string } }).error.code).toBe(-32003);
  });

  it("times out when no response arrives", async () => {
    const transport = fakeTransport();
    // send is a no-op (server never responds)

    const result = await sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "t1" },
      { timeoutMs: 50 },
    );

    expect(result.ok).toBe(false);
    expect((result as { error: { message: string } }).error.message).toContain("timed out");
  });

  it("rejects on abort signal", async () => {
    const transport = fakeTransport();
    const controller = new AbortController();

    const promise = sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "t1" },
      { timeoutMs: 5000, signal: controller.signal },
    );
    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect((result as { error: { code: number } }).error.code).toBe(-32099);
  });
});

// ─── installTaskMessageInterceptor ──────────────────────────────────────────

describe("installTaskMessageInterceptor", () => {
  it("intercepts a CreateTaskResult response and forwards to the SDK handler", () => {
    const transport = fakeTransport();
    const sdkHandler = vi.fn();
    transport.onmessage = sdkHandler;

    let captured: CreateTaskResult | undefined;
    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: (_server, _id, result) => { captured = result; },
      onTaskNotification: () => {},
    });

    const createTaskResult = {
      jsonrpc: "2.0",
      id: 42,
      result: {
        resultType: "task",
        taskId: "task-abc",
        status: "working",
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:00Z",
        ttlMs: 60000,
        pollIntervalMs: 2000,
      },
    };

    transport.onmessage?.(createTaskResult as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);

    expect(captured).toBeDefined();
    expect(captured!.taskId).toBe("task-abc");
    expect(captured!.status).toBe("working");
    expect(captured!.pollIntervalMs).toBe(2000);
    // The SDK handler must still be called (even though it will reject with
    // UnsupportedResultType — executeCall catches that).
    expect(sdkHandler).toHaveBeenCalledOnce();

    detach();
  });

  it("intercepts a notifications/tasks push", () => {
    const transport = fakeTransport();
    const sdkHandler = vi.fn();
    transport.onmessage = sdkHandler;

    let notifiedTask: TaskState | undefined;
    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: () => {},
      onTaskNotification: (_server, task) => { notifiedTask = task; },
    });

    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: {
        taskId: "task-xyz",
        status: "completed",
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:01Z",
        ttlMs: null,
        result: { content: [{ type: "text", text: "done" }] },
      },
    };

    transport.onmessage?.(notification as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);

    expect(notifiedTask).toBeDefined();
    expect(notifiedTask!.taskId).toBe("task-xyz");
    expect(notifiedTask!.status).toBe("completed");
    expect(sdkHandler).toHaveBeenCalledOnce();

    detach();
  });

  it("ignores non-task messages and forwards them", () => {
    const transport = fakeTransport();
    const sdkHandler = vi.fn();
    transport.onmessage = sdkHandler;

    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: () => {},
      onTaskNotification: () => {},
    });

    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }] },
    } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);

    expect(sdkHandler).toHaveBeenCalledOnce();

    detach();
  });

  it("detach restores the original onmessage", () => {
    const transport = fakeTransport();
    const original = vi.fn();
    transport.onmessage = original;

    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: () => {},
      onTaskNotification: () => {},
    });

    expect(transport.onmessage).not.toBe(original);

    detach();

    expect(transport.onmessage).toBe(original);
  });

  it("does not throw on malformed messages", () => {
    const transport = fakeTransport();
    const sdkHandler = vi.fn();
    transport.onmessage = sdkHandler;

    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: () => {},
      onTaskNotification: () => {},
    });

    // Malformed messages should not throw — they're silently ignored.
    expect(() => {
      transport.onmessage?.("garbage" as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
      transport.onmessage?.({ jsonrpc: "2.0", method: "unknown" } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
      transport.onmessage?.({ jsonrpc: "2.0", id: 1, result: { resultType: "task" } } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
    }).not.toThrow();

    detach();
  });
});
