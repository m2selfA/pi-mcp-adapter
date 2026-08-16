import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/client";
import { McpTasksManager } from "../mcp-tasks-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ServerConnection } from "../server-manager.ts";

// A fake transport that records sent messages and lets tests inject
// responses by calling transport.onmessage directly.
function fakeTransport(): Transport & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = [];
  return {
    start: vi.fn(async () => undefined),
    send: vi.fn(async (message: unknown) => { sentMessages.push(message); }),
    close: vi.fn(async () => undefined),
    sentMessages,
  } as Transport & { sentMessages: unknown[] };
}

function createManager(transport: Transport & { sentMessages: unknown[] }): {
  manager: McpTasksManager;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn();
  const connection: Partial<ServerConnection> = {
    status: "connected",
    transport,
  };
  const state = {
    manager: {
      getConnection: vi.fn(() => connection as ServerConnection),
    },
    ui: { confirm: vi.fn(async () => true) },
  } as unknown as McpExtensionState;

  const manager = new McpTasksManager({
    getState: () => state,
    pi: { sendMessage } as unknown as never,
  });

  return { manager, sendMessage };
}

const SAMPLE_CREATE_TASK = {
  resultType: "task" as const,
  taskId: "task-001",
  status: "working" as const,
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttlMs: 60000,
  pollIntervalMs: 1000,
};

// Helper: respond to the next tasks/get request on the transport with a given
// task state. Returns a promise that resolves when the response is sent.
function respondToTasksGet(
  transport: Transport & { sentMessages: unknown[] },
  taskState: Record<string, unknown>,
): void {
  (transport.send as ReturnType<typeof vi.fn>).mockImplementation(async (message: unknown) => {
    const msg = message as { jsonrpc: string; id?: number; method: string };
    if (msg.method === "tasks/get" && msg.id !== undefined) {
      // Defer to allow sendTaskRequest to install its onmessage handler.
      setTimeout(() => {
        transport.onmessage?.({
          jsonrpc: "2.0",
          id: msg.id,
          result: taskState,
        } as unknown as import("@modelcontextprotocol/client").JSONRPCMessage);
      }, 0);
    }
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1500));
}

describe("McpTasksManager", () => {
  it("trackTask returns a handle text immediately without blocking", () => {
    const transport = fakeTransport();
    const { manager } = createManager(transport);

    const handle = manager.trackTask("demo", SAMPLE_CREATE_TASK, "run_pipeline");

    expect(handle).toContain("task-001");
    expect(handle).toContain("demo");
    expect(handle).toContain("run_pipeline");
    expect(handle).toContain("background");
  });

  it("polls tasks/get and wakes the agent on completion", async () => {
    const transport = fakeTransport();
    const { manager, sendMessage } = createManager(transport);

    respondToTasksGet(transport, {
      taskId: "task-001",
      status: "completed",
      createdAt: "2026-01-01T00:00:00Z",
      lastUpdatedAt: "2026-01-01T00:00:01Z",
      ttlMs: null,
      result: { content: [{ type: "text", text: "Pipeline succeeded" }] },
    });

    manager.trackTask("demo", SAMPLE_CREATE_TASK, "run_pipeline");
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0]!;
    expect(call[1]).toEqual({ triggerTurn: true });
    expect(call[0].customType).toBe("mcp-task-completed");
    expect(call[0].content[0].text).toContain("task-001");
    expect(call[0].content[0].text).toContain("Pipeline succeeded");
  });

  it("wakes with an error message on failure", async () => {
    const transport = fakeTransport();
    const { manager, sendMessage } = createManager(transport);

    respondToTasksGet(transport, {
      taskId: "task-001",
      status: "failed",
      createdAt: "2026-01-01T00:00:00Z",
      lastUpdatedAt: "2026-01-01T00:00:01Z",
      ttlMs: null,
      error: { code: -32603, message: "Something went wrong" },
    });

    manager.trackTask("demo", SAMPLE_CREATE_TASK, "run_pipeline");
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0]!;
    expect(call[0].customType).toBe("mcp-task-failed");
    expect(call[0].content[0].text).toContain("failed");
    expect(call[0].content[0].text).toContain("Something went wrong");
  });

  it("shutdown aborts all pending polls", async () => {
    const transport = fakeTransport();
    const { manager, sendMessage } = createManager(transport);

    manager.trackTask("demo", SAMPLE_CREATE_TASK, "run_pipeline");
    manager.shutdown();
    await flush();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends a subscriptions/listen request on attachServer", () => {
    const transport = fakeTransport();
    const { manager } = createManager(transport);

    manager.attachServer("demo");

    const listenRequests = transport.sentMessages.filter(
      (m) => (m as { method?: string }).method === "subscriptions/listen",
    );
    expect(listenRequests).toHaveLength(1);
    const params = (listenRequests[0] as { params: Record<string, unknown> }).params;
    expect(params._meta).toBeDefined();
  });
});
