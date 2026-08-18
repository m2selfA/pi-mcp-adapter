import { describe, it, expect } from "vitest";
import {
  buildEditorText,
  createServerIndex,
  expandServerMentions,
  filterServerCompletions,
  parseCommandInput,
  renderServerContext,
  renderServerUse,
  renderServerUseWithTools,
  resolveServerReference,
  resolveDirectToolMode,
  listDirectToolNames,
} from "../mcp-context-lib.ts";

describe("mcp-context-lib", () => {
  it("creates stable aliases and resolves server names", () => {
    const index = createServerIndex(["github", "a:b", "a_3a_b"]);

    const aliases = [...index.aliasByServer.values()];
    expect(new Set(aliases).size).toBe(3);
    expect(aliases).toContain("a_3a_b");
    expect(aliases).toContain("a_3a_b-2");
    for (const [serverName, alias] of index.aliasByServer) {
      expect(resolveServerReference(index, alias)).toBe(serverName);
    }
    expect(resolveServerReference(index, "github")).toBe("github");
  });

  it("filters slash completions by fuzzy server text", () => {
    const items = [
      { value: "mcp:github", label: "/mcp:github", description: "github (connected, 4 tools)" },
      { value: "mcp:gitlab", label: "/mcp:gitlab", description: "gitlab (cached)" },
      { value: "mcp:select", label: "/mcp:select", description: "Choose an MCP server" },
    ];

    expect(
      filterServerCompletions(items, "gth").map((item) => item.value),
    ).toEqual(["mcp:github"]);
    expect(
      filterServerCompletions(items, "sel").map((item) => item.value),
    ).toEqual(["mcp:select"]);
  });

  it("expands only known #server mentions", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github for this; keep #unknown unchanged.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full}>`,
    );

    expect(result.changed).toBe(true);
    expect(result.servers).toEqual(["github"]);
    expect(result.text).toBe("Use <ctx github full=false> for this; keep #unknown unchanged.");
  });

  it("expands #server --full to the full context variant", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github --full for this.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full}>`,
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe("Use <ctx github full=true> for this.");
  });

  it("expands #server -f like --full", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github -f for this.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full} tools=${!!opts.listTools}>`,
    );

    expect(result.text).toBe("Use <ctx github full=true tools=false> for this.");
  });

  it("expands #server -t to the transition state", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github -t for this.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full} tools=${!!opts.listTools}>`,
    );

    expect(result.text).toBe("Use <ctx github full=false tools=true> for this.");
  });

  it("expands #server --tools like -t", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github --tools for this.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full} tools=${!!opts.listTools}>`,
    );

    expect(result.text).toBe("Use <ctx github full=false tools=true> for this.");
  });

  it("--full wins over -t when both are given", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions(
      "Use #github -t --full for this.",
      index,
      (server, opts) => `<ctx ${server} full=${!!opts.full} tools=${!!opts.listTools}>`,
    );

    expect(result.text).toBe("Use <ctx github full=true tools=false> for this.");
  });

  it("renders a lightweight use hint by default", () => {
    const hint = renderServerUse("github", { name: "github", status: "cached", toolCount: 4, disabled: false });

    expect(hint).toMatch(/^<use-mcp server="github" status="cached">/);
    // D: no longer emits the pseudo-statement `use github mcp;`.
    expect(hint).not.toMatch(/use github mcp;/);
    // B: never emit the invalid `mcp({ server })` form.
    expect(hint).toContain('mcp({ search: "", server: "github", limit: 12 })');
    expect(hint).toContain('mcp({ tool: "<name>", args: {...}, server: "github" })');
    expect(hint).not.toMatch(/<tools>/);
  });

  it("renders the -t transition state with tool names", () => {
    const hint = renderServerUseWithTools(
      "github",
      { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      { name: "github", status: "cached", toolCount: 3, disabled: false },
    );

    expect(hint).toMatch(/^<use-mcp server="github" status="cached">/);
    expect(hint).toContain("Known tools: a, b, c");
    expect(hint).not.toMatch(/<tools>/);
  });

  it("renders transition state gracefully when no tools are cached", () => {
    const hint = renderServerUseWithTools("github", undefined, undefined);
    expect(hint).toMatch(/Known tools: \(no cached tool names; discover via the mcp proxy\)/);
  });

  it("leaves the existing @ syntax untouched", () => {
    const index = createServerIndex(["github"]);
    const result = expandServerMentions("Keep @github available for Pi's file completion.", index, () => "<unexpected>");

    expect(result.changed).toBe(false);
    expect(result.text).toBe("Keep @github available for Pi's file completion.");
  });

  it("renders bounded escaped metadata without schemas by default", () => {
    const context = renderServerContext(
      "github",
      {
        instructions: "Use <safe> metadata only.",
        tools: [{ name: "search_code", description: "Search <repositories>" }],
        resources: [{ name: "docs", uri: "file:///docs" }],
        prompts: [{ name: "review", description: "Review a change" }],
      },
      { name: "github", status: "cached", toolCount: 1, disabled: false },
    );

    expect(context).toMatch(/<mcp-context server="github" status="cached">/);
    expect(context).toMatch(/&lt;safe&gt;/);
    expect(context).toMatch(/search_code/);
    expect(context).not.toMatch(/inputSchema/);
  });

  it("includes a schema only when explicitly requested", () => {
    const context = renderServerContext(
      "github",
      { tools: [{ name: "search_code", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
      undefined,
      { includeSchemas: true },
    );

    expect(context).toMatch(/schema:/);
    expect(context).toMatch(/properties/);
  });

  it("parses schema flag and preserves the prompt", () => {
    expect(parseCommandInput("--schemas find open issues")).toEqual({
      includeSchemas: true,
      prompt: "find open issues",
    });
    expect(buildEditorText("<ctx/>", "find open issues")).toBe("<ctx/>\n\nfind open issues");
  });

  // --- A: directTools servers render a direct-call hint, not a proxy pointer ---

  it("detects directTools mode from definition.directTools=true", () => {
    const mode = resolveDirectToolMode(
      "ctx",
      { command: "x", directTools: true },
      { mcpServers: { ctx: { command: "x", directTools: true } } },
      undefined,
    );
    expect(mode).toEqual({ direct: true, tools: true });
  });

  it("detects directTools mode from global settings.directTools", () => {
    const mode = resolveDirectToolMode(
      "ctx",
      { command: "x" },
      { mcpServers: { ctx: { command: "x" } }, settings: { directTools: true } },
      undefined,
    );
    expect(mode.direct).toBe(true);
  });

  it("treats definition.directTools=false as non-direct even when global is true", () => {
    const mode = resolveDirectToolMode(
      "ctx",
      { command: "x", directTools: false },
      { mcpServers: { ctx: { command: "x", directTools: false } }, settings: { directTools: true } },
      undefined,
    );
    expect(mode.direct).toBe(false);
  });

  it("treats an env override as exclusive: non-listed servers are non-direct", () => {
    const override = new Map<string, true | string[]>([["only", true]]);
    const mode = resolveDirectToolMode(
      "other",
      { command: "x", directTools: true },
      { mcpServers: { other: { command: "x", directTools: true } }, settings: { directTools: true } },
      override,
    );
    expect(mode.direct).toBe(false);
  });

  it("renders a direct-tools hint for a directTools server (A + E)", () => {
    const config = { mcpServers: { ctx: { command: "x", directTools: true } }, settings: { toolPrefix: "server" } };
    const hint = renderServerUse(
      "ctx",
      { name: "ctx", status: "connected", toolCount: 2, disabled: false },
      { entry: { tools: [{ name: "grok_search" }, { name: "grok_deep" }] }, config },
    );
    expect(hint).toMatch(/^<direct-tools server="ctx" status="connected">/);
    expect(hint).toContain("direct top-level Pi tools");
    expect(hint).toContain("ctx_grok_search, ctx_grok_deep");
    expect(hint).toContain("tool prefix: ctx_");
    expect(hint).not.toMatch(/prefer.*mcp proxy/);
  });

  it("lists prefixed direct tool names using the configured prefix (E)", () => {
    const { names } = listDirectToolNames(
      "ctx",
      { tools: [{ name: "a" }, { name: "b" }] },
      { mcpServers: { ctx: {} }, settings: { toolPrefix: "none" } },
    );
    expect(names).toEqual(["a", "b"]);
  });

  // --- C: small proxy servers default to the with-tools form ---

  it("defaults small proxy servers to the with-tools form (C)", () => {
    const hint = renderServerUse(
      "small",
      { name: "small", status: "cached", toolCount: 3, disabled: false },
      { entry: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } },
    );
    expect(hint).toMatch(/^<use-mcp server="small" status="cached">/);
    expect(hint).toContain("Known tools: a, b, c");
  });

  it("renders the compact proxy hint for large servers (B + D)", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` }));
    const hint = renderServerUse(
      "big",
      { name: "big", status: "cached", toolCount: 10, disabled: false },
      { entry: { tools: many } },
    );
    expect(hint).toMatch(/^<use-mcp server="big" status="cached">/);
    // D: no pseudo-statement.
    expect(hint).not.toMatch(/use big mcp;/);
    // B: legal discovery example, not `mcp({ server })`.
    expect(hint).toContain('mcp({ search: "", server: "big", limit: 12 })');
    expect(hint).not.toMatch(/mcp\(\{ server: "big" \}\)/);
  });
});
