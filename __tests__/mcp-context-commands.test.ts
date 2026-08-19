import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMcpContext } from "../mcp-context.ts";
import type { McpContextCatalog } from "../mcp-context-lib.ts";

const catalog: McpContextCatalog = {
  servers: {
    github: {
      configHash: "hash-1",
      tools: [{
        name: "search_code",
        description: "Search repositories",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }],
      resources: [],
      prompts: [],
      cachedAt: 0,
    },
  },
};

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
}

function createHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const inputListeners = new Map<string, (event: { source: string; text: string }) => unknown>();
  const pi = {
    events: { on: vi.fn(() => () => {}) },
    registerCommand: vi.fn((name: string, def: RegisteredCommand) => {
      commands.set(name, def);
    }),
    on: vi.fn((name: string, handler: (event: never) => unknown) => {
      if (name === "input") inputListeners.set(name, handler as never);
      return () => {};
    }),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
  };

  installMcpContext(pi as unknown as ExtensionAPI, { getCatalog: () => catalog });

  const ctx = { hasUI: true, ui: { notify: vi.fn() } };

  return {
    pi,
    commands,
    input: inputListeners.get("input")!,
    ctx,
    sentMentions: () => pi.sendMessage.mock.calls.map(([message, options]) => ({ message, options })),
  };
}

describe("/mcp: command display", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("renders registered /mcp:<server> as a collapsible mcp-mention message", async () => {
    const command = harness.commands.get("mcp:github");
    expect(command).toBeDefined();

    await command!.handler("find open issues", harness.ctx);

    const calls = harness.sentMentions();
    expect(calls.length).toBe(1);
    const { message, options } = calls[0]!;
    expect(message.customType).toBe("mcp-mention");
    expect(message.details.serverName).toBe("github");
    expect(message.details.prompt).toBe("find open issues");
    expect(message.content).toContain("<mcp-context server=\"github\"");
    expect(message.content).toContain("find open issues");
    expect(options).toEqual({ triggerTurn: true });
  });

  it("keeps the pre-registration input fallback on the same collapsible path", () => {
    const result = harness.input({ source: "user", text: "/mcp:github find open issues" });

    expect(result).toEqual({ action: "handled" });
    const calls = harness.sentMentions();
    expect(calls.length).toBe(1);
    const { message, options } = calls[0]!;
    expect(message.customType).toBe("mcp-mention");
    expect(message.details.serverName).toBe("github");
    expect(message.details.prompt).toBe("find open issues");
    expect(options).toEqual({ triggerTurn: true });
  });

  it("supports --schemas on the slash form", async () => {
    const command = harness.commands.get("mcp:github")!;
    await command.handler("--schemas find issues", harness.ctx);

    const { message } = harness.sentMentions()[0]!;
    expect(message.details.blockText).toContain("schema:");
    expect(message.details.prompt).toBe("find issues");
  });

  it("loads the selected server through /mcp:select on the same path", async () => {
    const select = harness.commands.get("mcp:select")!;
    const ctx = { ...harness.ctx, ui: { ...harness.ctx.ui, select: vi.fn().mockResolvedValue("github - github (cached)") } };

    await select.handler("find open issues", ctx);

    const calls = harness.sentMentions();
    expect(calls.length).toBe(1);
    expect(calls[0]!.message.details.serverName).toBe("github");
    expect(calls[0]!.message.details.prompt).toBe("find open issues");
  });
});
