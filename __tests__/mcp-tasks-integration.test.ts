import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/client";
import {
  installTaskMessageInterceptor,
  sendTaskRequest,
  buildTasksDeclarationMetaWithCapabilities,
  MCP_TASKS_EXTENSION_ID,
  CLIENT_CAPABILITIES_META_KEY,
} from "../mcp-tasks-wire.ts";

/**
 * Integration test: interceptor + sendTaskRequest working together over a
 * shared transport. This is the wire-level scenario the tasks manager relies
 * on: the interceptor is installed (for notifications/tasks), then
 * sendTaskRequest sends tasks/get and receives the response through the
 * same onmessage chain without the interceptor eating it.
 */
function fakeTransport(): Transport & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = [];
  return {
    start: vi.fn(async () => undefined),
    send: vi.fn(async (message: unknown) => { sentMessages.push(message); }),
    close: vi.fn(async () => undefined),
    sentMessages,
  } as Transport & { sentMessages: unknown[] };
}

describe("tasks wire integration", () => {
  it("interceptor and sendTaskRequest coexist on the same transport", async () => {
    const transport = fakeTransport();
    const sdkHandler = vi.fn();
    transport.onmessage = sdkHandler;

    // Install the persistent interceptor (as the manager does on attachServer).
    let notified = false;
    const detach = installTaskMessageInterceptor(transport, "demo", {
      onCreateTaskResult: () => {},
      onTaskNotification: () => { notified = true; },
    });

    // Now sendTaskRequest sends tasks/get. The mock server responds by
    // calling transport.onmessage with a matching response. The interceptor
    // must NOT eat this response — sendTaskRequest's onmessage chain must
    // receive it.
    (transport.send as ReturnType<typeof vi.fn>).mockImplementation(async (message: unknown) => {
      const msg = message as { id?: number; method: string };
      if (msg.method === "tasks/get" && msg.id !== undefined) {
        setTimeout(() => {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              taskId: "int-task-1",
              status: "completed",
              createdAt: "2026-01-01T00:00:00Z",
              lastUpdatedAt: "2026-01-01T00:00:01Z",
              ttlMs: null,
              result: { content: [{ type: "text", text: "done" }] },
            },
          } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
        }, 0);
      }
    });

    const result = await sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "int-task-1", _meta: buildTasksDeclarationMetaWithCapabilities({}) },
      { timeoutMs: 1000 },
    );

    expect(result.ok).toBe(true);
    const taskResult = (result as { result: { taskId: string; status: string } }).result;
    expect(taskResult.taskId).toBe("int-task-1");
    expect(taskResult.status).toBe("completed");

    // The SDK handler should also have received the response (forwarded by
    // the interceptor — even though the SDK will reject resultType on its
    // own messages, it still needs to see them for its own bookkeeping).
    expect(sdkHandler).toHaveBeenCalled();

    // A notifications/tasks push should be caught by the interceptor.
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: {
        taskId: "int-task-1",
        status: "completed",
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:01Z",
        ttlMs: null,
      },
    } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);

    expect(notified).toBe(true);

    detach();
  });

  it("tasks/get request carries the tasks declaration in _meta", async () => {
    const transport = fakeTransport();
    const sendSpy = transport.send as ReturnType<typeof vi.fn>;

    sendSpy.mockImplementation(async (message: unknown) => {
      transport.sentMessages.push(message);
      const msg = message as { id?: number; method: string };
      if (msg.method === "tasks/get" && msg.id !== undefined) {
        setTimeout(() => {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: msg.id,
            result: { taskId: "t", status: "working", createdAt: "", lastUpdatedAt: "", ttlMs: null },
          } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
        }, 0);
      }
    });

    await sendTaskRequest(
      transport,
      "tasks/get",
      { taskId: "t", _meta: buildTasksDeclarationMetaWithCapabilities({ sampling: {} }) },
      { timeoutMs: 1000 },
    );

    const sentRequest = transport.sentMessages[0] as { params: { _meta: Record<string, unknown> } };
    const meta = sentRequest.params._meta;
    const caps = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown>;
    expect(caps).toBeDefined();
    expect(caps.sampling).toEqual({});
    expect((caps.extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION_ID]).toEqual({});
  });

  it("multiple concurrent sendTaskRequest calls each get their own response", async () => {
    const transport = fakeTransport();
    transport.onmessage = vi.fn();

    (transport.send as ReturnType<typeof vi.fn>).mockImplementation(async (message: unknown) => {
      const msg = message as { id?: number; method: string };
      if (msg.method === "tasks/get" && msg.id !== undefined) {
        setTimeout(() => {
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: msg.id,
            result: { taskId: `task-${msg.id}`, status: "working", createdAt: "", lastUpdatedAt: "", ttlMs: null },
          } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
        }, 0);
      }
    });

    const [r1, r2, r3] = await Promise.all([
      sendTaskRequest(transport, "tasks/get", { taskId: "a" }, { timeoutMs: 1000 }),
      sendTaskRequest(transport, "tasks/get", { taskId: "b" }, { timeoutMs: 1000 }),
      sendTaskRequest(transport, "tasks/get", { taskId: "c" }, { timeoutMs: 1000 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect((r1 as { result: { taskId: string } }).result.taskId).toContain("task-");
    expect((r2 as { result: { taskId: string } }).result.taskId).toContain("task-");
    expect((r3 as { result: { taskId: string } }).result.taskId).toContain("task-");
    // Each response matched its own request id.
    expect((r1 as { result: { taskId: string } }).result.taskId).not.toEqual((r2 as { result: { taskId: string } }).result.taskId);
  });
});
