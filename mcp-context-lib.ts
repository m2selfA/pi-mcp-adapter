// mcp-context-lib.ts - Cached MCP server context rendering and #mention expansion.
//
// Inlined from the former pi-mcp-context companion package. The pure helpers
// here operate on adapter-owned MetadataCache shapes and a lightweight
// AutocompleteItem type, with no @earendil-works/pi-tui runtime dependency:
// fuzzyFilter is a small local implementation so the adapter introduces no new
// runtime dependency. The extension wiring lives in mcp-context.ts.

import type { CachedPrompt, CachedResource, CachedTool, ServerCacheEntry } from "./types.ts";
import { formatToolName, resolveToolPrefix } from "./types.ts";
import type { McpConfig, ServerEntry, ToolPrefix } from "./types.ts";

export type { CachedPrompt, CachedResource, CachedTool, ServerCacheEntry } from "./types.ts";

/** A read-only view over the adapter's metadata cache for context rendering. */
export interface McpContextCatalog {
  version?: number;
  servers: Record<string, ServerCacheEntry>;
  /** Effective MCP config (used to detect directTools servers and tool prefixes). Optional. */
  config?: McpConfig | undefined;
  /** Per-server direct tool override (e.g. from MCP_DIRECT_TOOLS env). Optional. */
  directToolOverride?: Map<string, true | string[]> | undefined;
}

export interface AdapterServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount?: number;
  disabled: boolean;
}

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface ServerIndex {
  serverNames: string[];
  aliasByServer: Map<string, string>;
  serverByAlias: Map<string, string>;
}

export interface RenderContextOptions {
  includeSchemas?: boolean;
  maxChars?: number;
}

export interface CommandInputOptions {
  includeSchemas: boolean;
  prompt: string;
}

export interface MentionRenderOptions {
  /** --full / --schemas: expand to the full cached <mcp-context> catalog. */
  full?: boolean;
  /** -t: transition state — lightweight `use <srv> mcp, with <tools>;`. */
  listTools?: boolean;
}

const DEFAULT_MAX_CHARS = 12_000;
const SAFE_ALIAS_CHARACTER = /[A-Za-z0-9._-]/;
const MAX_TOOL_NAMES = 40;
/** Below this cached tool count, `#srv` defaults to the with-tools form (C: auto-tier). */
const SMALL_SERVER_TOOL_THRESHOLD = 6;
/** Max direct-tool names listed verbatim in a directTools server hint (E: prefix hint). */
const MAX_DIRECT_TOOL_NAMES = 12;
// Matches #server plus any trailing -t / --tools (transition) or
// -f / --full / --schema(s) (full catalog) modifiers.
const SERVER_MENTION_PATTERN = /(^|[\s])#([A-Za-z0-9._-]+)((?:\s+(?:-t|--tools|-f|--full|--schema|--schemas))*)(?![A-Za-z0-9._-])/g;

export function createServerIndex(serverNames: readonly string[]): ServerIndex {
  const unique = [...new Set(serverNames.filter((name) => name.trim().length > 0))].sort();
  const aliasByServer = new Map<string, string>();
  const serverByAlias = new Map<string, string>();

  for (const serverName of unique) {
    const base = toSafeAlias(serverName) || "server";
    let alias = base;
    let suffix = 2;
    while (serverByAlias.has(alias)) alias = `${base}-${suffix++}`;
    aliasByServer.set(serverName, alias);
    serverByAlias.set(alias, serverName);
  }

  return { serverNames: unique, aliasByServer, serverByAlias };
}

/** Lightweight fuzzy filter: preserves items whose `text` contains every
 * character of `query` in order (subsequence match), case-insensitive. Good
 * enough for server-name completion and mirrors the pi-tui fuzzy behavior the
 * companion package relied on, without adding a runtime dependency. */
export function fuzzyFilterSubsequence(items: readonly AutocompleteItem[], query: string, text: (item: AutocompleteItem) => string): AutocompleteItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...items];
  return items.filter((item) => isSubsequence(text(item).toLowerCase(), normalized));
}

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

export function filterServerCompletions(
  items: readonly AutocompleteItem[],
  query: string,
): AutocompleteItem[] {
  return fuzzyFilterSubsequence([...items], query, (item) => item.label);
}

export function resolveServerReference(index: ServerIndex, reference: string): string | undefined {
  return index.serverByAlias.get(reference) ?? (index.serverNames.includes(reference) ? reference : undefined);
}

/**
 * Resolves whether a server exposes its tools as direct (top-level) Pi tools
 * rather than only through the `mcp` proxy. Mirrors the adapter's
 * `resolveDirectTools` selection rules (env override > definition.directTools
 * > global directTools) without re-implementing the full candidate filtering.
 *
 * When `override` is present it is exclusive: only servers it lists get direct
 * tools, and every other server resolves to `{ direct: false }` regardless of
 * config (this matches `resolveDirectTools`, which `continue`s past non-listed
 * servers when an env selection is active).
 */
export function resolveDirectToolMode(
  serverName: string,
  definition: ServerEntry | undefined,
  config: McpConfig | undefined,
  override: Map<string, true | string[]> | undefined,
): { direct: true; tools: string[] | true } | { direct: false } {
  if (override) {
    if (!override.has(serverName)) return { direct: false };
    const value = override.get(serverName);
    return value === undefined
      ? { direct: false }
      : { direct: true, tools: value };
  }
  const def = definition;
  if (def?.directTools !== undefined) {
    return def.directTools === false
      ? { direct: false }
      : { direct: true, tools: def.directTools };
  }
  const global = config?.settings?.directTools;
  if (global !== undefined) {
    return global === false
      ? { direct: false }
      : { direct: true, tools: global };
  }
  return { direct: false };
}

/**
 * Lists the prefixed names a directTools server exposes, applying the
 * adapter's tool prefix so the names match what the model must call.
 * Returns the prefixed names (and a flag whether the list is complete).
 */
export function listDirectToolNames(
  serverName: string,
  entry: ServerCacheEntry | undefined,
  config: McpConfig | undefined,
): { names: string[]; truncated: boolean } {
  const prefixMode: ToolPrefix = config?.settings?.toolPrefix ?? "server";
  const effectivePrefix = resolveToolPrefix(config?.mcpServers?.[serverName], prefixMode);
  const all = (entry?.tools ?? []).map((tool) => formatToolName(tool.name, serverName, effectivePrefix)).filter(Boolean);
  if (all.length <= MAX_DIRECT_TOOL_NAMES) return { names: all, truncated: false };
  return { names: all.slice(0, MAX_DIRECT_TOOL_NAMES), truncated: true };
}

/**
 * Renders a lightweight server hint. The shape depends on how the server's
 * tools reach the model:
 *
 *  - directTools server → a `<direct-tools>` block listing prefixed names and
 *    the prefix to guess, telling the model to call them directly (A).
 *  - small proxy server (≤ SMALL_SERVER_TOOL_THRESHOLD cached tools) → the
 *    `with <tools>` transition state, so the model targets calls precisely
 *    without an extra discovery round-trip (C: auto-tier).
 *  - large proxy server → a compact `use <srv> mcp;` label plus a *legal*
 *    discovery example call (B), never the invalid `mcp({ server })` form.
 *
 * `use <srv> mcp;` is kept only as a human-readable label inside the wrapper,
 * never as something the model is asked to emit (D: label, not statement).
 */
export function renderServerUse(
  serverName: string,
  status: AdapterServerStatus | undefined,
  options: { entry?: ServerCacheEntry | undefined; config?: McpConfig | undefined; directToolOverride?: Map<string, true | string[]> | undefined } = {},
): string {
  const serializedServer = JSON.stringify(serverName) ?? "\"\"";
  const state = status?.status ?? "cached";
  const disabled = status?.disabled === true;
  const { entry, config, directToolOverride } = options;

  const directMode = resolveDirectToolMode(serverName, config?.mcpServers?.[serverName], config, directToolOverride);
  if (directMode.direct) {
    return renderDirectToolsHint(serverName, entry, config, status);
  }

  const cachedToolCount = entry?.tools?.length ?? 0;
  if (cachedToolCount > 0 && cachedToolCount <= SMALL_SERVER_TOOL_THRESHOLD) {
    return renderServerUseWithTools(serverName, entry, status);
  }

  const lines: string[] = [
    `<use-mcp server="${escapeXml(serverName)}" status="${escapeXml(state)}">`,
    `# ${serverName} — prefer this server's tools through the existing mcp proxy.`,
    `Discover on demand with mcp({ search: "", server: ${serializedServer}, limit: 12 })`,
    `(lists this server's tool names) or mcp({ search: "query", server: ${serializedServer} }),`,
    `then call with mcp({ tool: "<name>", args: {...}, server: ${serializedServer} }).`,
  ];
  if (disabled) {
    lines.push("The adapter reports this server as disabled; do not assume its tools are callable.");
  }
  lines.push("</use-mcp>");
  return lines.join("\n");
}

/**
 * Renders the directTools hint (A): names + prefix the model should use to call
 * directly, with no proxy pointer (those tools are not behind the proxy).
 */
function renderDirectToolsHint(
  serverName: string,
  entry: ServerCacheEntry | undefined,
  config: McpConfig | undefined,
  status: AdapterServerStatus | undefined,
): string {
  const state = status?.status ?? (entry ? "cached" : "not-connected");
  const disabled = status?.disabled === true;
  const { names, truncated } = listDirectToolNames(serverName, entry, config);
  const prefixMode: ToolPrefix = config?.settings?.toolPrefix ?? "server";
  const effectivePrefix = resolveToolPrefix(config?.mcpServers?.[serverName], prefixMode);
  const prefixHint = effectivePrefix === "none"
    ? "(no server prefix; call tools by their original name)"
    : `tool prefix: ${formatToolName("", serverName, effectivePrefix).replace(/_$/, "")}_`;
  const toolList = names.length === 0
    ? "(no cached tool names yet; discover via the mcp proxy if needed)"
    : names.join(", ") + (truncated ? `, +${(entry?.tools?.length ?? 0) - names.length} more` : "");
  const lines: string[] = [
    `<direct-tools server="${escapeXml(serverName)}" status="${escapeXml(state)}">`,
    `# ${serverName} exposes its tools as direct top-level Pi tools — call them directly,`,
    `not through the mcp proxy.`,
    `Direct calls: ${toolList}`,
    prefixHint,
  ];
  if (disabled) {
    lines.push("The adapter reports this server as disabled; do not assume its tools are callable.");
  }
  lines.push("</direct-tools>");
  return lines.join("\n");
}

/**
 * Renders the `-t` transition state (also used as the default for small proxy
 * servers — C): lists the server's tool names so the model can target calls
 * precisely without paying for the full catalog. The example call is always
 * a legal `mcp({ search, server })` form (B).
 */
export function renderServerUseWithTools(
  serverName: string,
  entry: ServerCacheEntry | undefined,
  status: AdapterServerStatus | undefined,
): string {
  const serializedServer = JSON.stringify(serverName) ?? "\"\"";
  const state = status?.status ?? (entry ? "cached" : "not-connected");
  const disabled = status?.disabled === true;
  const names = (entry?.tools ?? []).map((tool) => tool.name).filter(Boolean);
  let toolList: string;
  if (names.length === 0) {
    toolList = "(no cached tool names; discover via the mcp proxy)";
  } else {
    const shown = names.slice(0, MAX_TOOL_NAMES);
    const tail = names.length > MAX_TOOL_NAMES ? ` +${names.length - MAX_TOOL_NAMES} more` : "";
    toolList = shown.join(", ") + tail;
  }
  const lines: string[] = [`<use-mcp server="${escapeXml(serverName)}" status="${escapeXml(state)}">`];
  lines.push(`# ${serverName} — prefer this server's tools through the existing mcp proxy.`);
  lines.push(`Known tools: ${toolList}`);
  lines.push(`Call with mcp({ tool: "<name>", args: {...}, server: ${serializedServer} }),`);
  lines.push(`or re-discover with mcp({ search: "", server: ${serializedServer}, limit: 12 }) for full schemas.`);
  if (disabled) {
    lines.push("The adapter reports this server as disabled; do not assume its tools are callable.");
  }
  lines.push("</use-mcp>");
  return lines.join("\n");
}

export function renderServerContext(
  serverName: string,
  entry: ServerCacheEntry | undefined,
  status: AdapterServerStatus | undefined,
  options: RenderContextOptions = {},
): string {
  const includeSchemas = options.includeSchemas === true;
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const state = status?.status ?? (entry ? "cached" : "not-connected");
  const tools = entry?.tools ?? [];
  const resources = entry?.resources ?? [];
  const prompts = entry?.prompts ?? [];
  const serializedServer = JSON.stringify(serverName) ?? "\"\"";
  const lines: string[] = [
    `<mcp-context server="${escapeXml(serverName)}" status="${escapeXml(state)}">`,
    "This is cached metadata for an MCP server managed by pi-mcp-adapter.",
    `When a task matches this server, use the existing mcp proxy with server ${serializedServer}.`,
    `The metadata may be stale; use mcp({ search: "", server: ${serializedServer}, limit: 12 }) or mcp({ search: "query", server: ${serializedServer} }) when live details are needed.`,
  ];

  if (status?.disabled) {
    lines.push("The adapter currently reports this server as disabled; do not assume its tools are callable.");
  }

  if (entry?.instructions?.trim()) {
    lines.push("<instructions>", escapeXml(entry.instructions.trim()), "</instructions>");
  }

  if (tools.length > 0) {
    lines.push("<tools>");
    for (const tool of tools) {
      const description = oneLine(tool.description) || "(no description)";
      const kind = tool.uiResourceUri ? ` [resource: ${escapeXml(tool.uiResourceUri)}]` : "";
      lines.push(`- ${escapeXml(tool.name)}${kind}: ${escapeXml(description)}`);
      if (includeSchemas && tool.inputSchema !== undefined) {
        lines.push(`  schema: ${escapeXml(compactJson(tool.inputSchema, 1_600))}`);
      }
    }
    lines.push("</tools>");
  } else {
    lines.push("No cached MCP tools are available. Ask the mcp proxy to list or search this server.");
  }

  if (resources.length > 0) {
    lines.push("<resources>");
    for (const resource of resources) {
      const description = oneLine(resource.description) || resource.uri;
      lines.push(`- ${escapeXml(resource.name)}: ${escapeXml(resource.uri)} - ${escapeXml(description)}`);
    }
    lines.push("</resources>");
  }

  if (prompts.length > 0) {
    lines.push("<prompts>");
    for (const prompt of prompts) {
      const description = oneLine(prompt.description) || prompt.title || "(no description)";
      lines.push(`- ${escapeXml(prompt.name)}: ${escapeXml(description)}`);
    }
    lines.push("</prompts>");
  }

  const timestamp = formatTimestamp(entry?.cachedAt);
  if (timestamp) {
    lines.push(`Metadata cache timestamp: ${timestamp}.`);
  }

  lines.push("</mcp-context>");
  return truncateBlock(lines.join("\n"), maxChars);
}

export function expandServerMentions(
  text: string,
  index: ServerIndex,
  render: (serverName: string, options: MentionRenderOptions) => string,
): { text: string; changed: boolean; servers: string[] } {
  const servers: string[] = [];
  const seen = new Set<string>();
  const expanded = text.replace(
    SERVER_MENTION_PATTERN,
    (whole, whitespace: string, reference: string, modifiers: string) => {
      const serverName = resolveServerReference(index, reference);
      if (!serverName) return whole;
      if (!seen.has(serverName)) {
        seen.add(serverName);
        servers.push(serverName);
      }
      const full = /--(?:full|schema|schemas)|-f/.test(modifiers);
      const listTools = !full && /(?:^|\s)(?:-t|--tools)(?:\s|$)/.test(modifiers);
      return `${whitespace}${render(serverName, { full, listTools })}`;
    },
  );
  return { text: expanded, changed: expanded !== text, servers };
}

export function parseCommandInput(args: string): CommandInputOptions {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const includeSchemas = words.some((word) => word === "--schemas" || word === "--schema");
  return {
    includeSchemas,
    prompt: words.filter((word) => word !== "--schemas" && word !== "--schema").join(" "),
  };
}

export function buildEditorText(context: string, prompt: string): string {
  return prompt.trim().length > 0 ? `${context}\n\n${prompt.trim()}` : context;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toSafeAlias(value: string): string {
  return [...value].map((character) => {
    if (SAFE_ALIAS_CHARACTER.test(character)) return character;
    return `_${character.codePointAt(0)!.toString(16)}_`;
  }).join("");
}

function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const closing = "\n</mcp-context>";
  const marker = "\n[metadata truncated; use the mcp proxy for the complete catalog]";
  const end = value.endsWith("</mcp-context>") ? closing : "";
  const available = Math.max(0, maxChars - marker.length - end.length);
  return `${value.slice(0, available)}${marker}${end}`;
}

function compactJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function formatTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function oneLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
