// mcp-context.ts - Inlined pi-mcp-context companion: #server mention
// expansion, /mcp:<server> and /mcp:select commands, and TUI autocomplete.
//
// This is no longer a separate package. It is wired into the adapter's main
// extension so `#github`, `/mcp:github`, and `#`-completion work out of the box
// once the adapter is installed. The catalog comes from adapter-owned state
// (live tool/prompt metadata, falling back to the persisted mcp-cache.json)
// rather than reading the cache file independently.

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MCP_STATUS_EVENT, type McpConfig, type McpServerStatusSnapshot, type McpStatusSnapshot } from "./types.ts";
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
  type AutocompleteItem,
  type McpContextCatalog,
  type MentionRenderOptions,
  type ServerIndex,
} from "./mcp-context-lib.ts";

const SELECT_COMMAND = "mcp:select";

export interface McpContextOptions {
  /** Live catalog of cached server metadata. May be null before init. */
  getCatalog: () => McpContextCatalog | null;
  /** Effective MCP config, used to detect directTools servers and tool prefixes. */
  getConfig?: () => McpConfig | undefined;
  /** Per-server direct-tool override (e.g. from MCP_DIRECT_TOOLS env). */
  getDirectToolOverride?: () => Map<string, true | string[]> | undefined;
}

export function installMcpContext(pi: ExtensionAPI, options: McpContextOptions): void {
  let statuses = new Map<string, McpServerStatusSnapshot>();
  let index = createServerIndex([]);
  const registeredServerCommands = new Set<string>();
  let autocompleteInstalled = false;
  let removeStatusListener: (() => void) | undefined;

  const refreshInventory = (): void => {
    const cache = options.getCatalog();
    const names = new Set<string>(Object.keys(cache?.servers ?? {}));
    for (const name of statuses.keys()) names.add(name);
    index = createServerIndex([...names]);
    registerServerCommands();
  };

  const statusHandler = (value: unknown): void => {
    if (!isStatusSnapshot(value)) return;
    statuses = new Map(value.servers.map((server) => [server.name, server]));
    refreshInventory();
  };

  const subscribeStatus = (): void => {
    if (!removeStatusListener) removeStatusListener = pi.events.on(MCP_STATUS_EVENT, statusHandler);
  };
  subscribeStatus();

  pi.registerCommand(SELECT_COMMAND, {
    description: "Choose an MCP server and prepare its cached context in the editor.",
    handler: async (args, ctx) => {
      refreshInventory();
      if (!ctx.hasUI) {
        notify(ctx, "MCP server selection requires an interactive UI.", "warning");
        return;
      }
      if (index.serverNames.length === 0) {
        notify(ctx, "No MCP servers are known. Start pi-mcp-adapter or reconnect a server first.", "warning");
        return;
      }
      const choices = index.serverNames.map((name) => ({
        label: `${index.aliasByServer.get(name)} - ${name}${statusSuffix(name)}`,
        serverName: name,
      }));
      const selected = await ctx.ui.select("Choose an MCP server", choices.map((choice) => choice.label));
      if (!selected) return;
      const choice = choices.find((candidate) => candidate.label === selected);
      if (!choice) return;
      await prepareEditor(choice.serverName, args, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    subscribeStatus();
    refreshInventory();
    if (ctx.mode === "tui" && !autocompleteInstalled) {
      installAutocomplete(ctx);
      autocompleteInstalled = true;
    }
  });

  pi.on("session_shutdown", () => {
    removeStatusListener?.();
    removeStatusListener = undefined;
    statuses.clear();
    autocompleteInstalled = false;
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    refreshInventory();

    if (event.text.includes("#")) {
      const expanded = expandServerMentions(event.text, index, (serverName, opts) =>
        renderMention(serverName, opts, renderContext)
      );
      if (expanded.changed) return { action: "transform" as const, text: expanded.text };
    }

    // Race-safe fallback for a slash command typed before the adapter's first
    // status event registered the dynamic command.
    const match = event.text.match(/^\s*\/mcp:([A-Za-z0-9._-]+)(?:\s+([\s\S]*?))?\s*$/);
    if (!match) return;
    const serverName = resolveServerReference(index, match[1]!);
    if (!serverName) return;
    const parsed = parseCommandInput(match[2] ?? "");
    return {
      action: "transform" as const,
      text: buildEditorText(renderContext(serverName, parsed.includeSchemas), parsed.prompt),
    };
  });

  refreshInventory();

  function registerServerCommands(): void {
    for (const serverName of index.serverNames) {
      const alias = index.aliasByServer.get(serverName);
      if (!alias) continue;
      const commandName = `mcp:${alias}`;
      if (registeredServerCommands.has(commandName)) continue;
      registeredServerCommands.add(commandName);
      pi.registerCommand(commandName, {
        description: `Prepare cached MCP context for ${serverName}.`,
        handler: async (args, ctx) => {
          refreshInventory();
          const resolved = index.serverNames.includes(serverName) ? serverName : undefined;
          if (!resolved) {
            notify(ctx, `MCP server "${serverName}" is no longer available.`, "warning");
            return;
          }
          await prepareEditor(resolved, args, ctx);
        },
      });
    }
  }

  function installAutocomplete(ctx: ExtensionContext): void {
    const addAutocompleteProvider = ctx.ui.addAutocompleteProvider as
      | ((provider: (current: AutocompleteProviderCurrent) => unknown) => unknown)
      | undefined;
    if (typeof addAutocompleteProvider !== "function") return;

    addAutocompleteProvider((current: AutocompleteProviderCurrent) => ({
      triggerCharacters: ["#", ":"],
      async getSuggestions(lines: string[], line: number, col: number) {
        refreshInventory();
        const before = (lines[line] ?? "").slice(0, col);
        const mention = before.match(/(?:^|[ \t])#([A-Za-z0-9._-]*)$/);
        if (mention) {
          const prefix = `#${mention[1] ?? ""}`;
          return {
            prefix,
            items: index.serverNames.map((serverName) => {
              const alias = index.aliasByServer.get(serverName)!;
              return {
                value: `#${alias}`,
                label: `#${alias}`,
                description: `${serverName}${statusSuffix(serverName)}`,
              };
            }),
          };
        }

        const slash = before.match(/^\/mcp:([A-Za-z0-9._-]*)$/);
        if (slash) {
          const prefix = `/mcp:${slash[1] ?? ""}`;
          // Pi's CombinedAutocompleteProvider adds the leading slash for command items.
          const items: AutocompleteItem[] = [
            {
              value: "mcp:select",
              label: "/mcp:select",
              description: "Choose an MCP server from a UI selector",
            },
            ...index.serverNames.map((serverName) => {
              const alias = index.aliasByServer.get(serverName)!;
              return {
                value: `mcp:${alias}`,
                label: `/mcp:${alias}`,
                description: `${serverName}${statusSuffix(serverName)}`,
              };
            }),
          ];
          return {
            prefix,
            items: filterServerCompletions(items, slash[1] ?? ""),
          };
        }

        return current?.getSuggestions?.(lines, line, col, current) ?? null;
      },
      applyCompletion(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string) {
        return current?.applyCompletion?.(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
        return current?.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  }

  async function prepareEditor(serverName: string, args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parsed = parseCommandInput(args);
    const context = renderContext(serverName, parsed.includeSchemas);
    const text = buildEditorText(context, parsed.prompt);
    if (!ctx.hasUI) {
      pi.sendUserMessage(text);
      return;
    }
    ctx.ui.setEditorText(text);
    notify(ctx, `Prepared MCP context for ${serverName}. Review it in the editor and submit.`, "info");
  }

  // `#server` expands adaptively: direct-tools servers render a
  // `<direct-tools>` block (A); small proxy servers render `Known tools:`
  // (C); large proxy servers render a compact `<use-mcp>` hint with a legal
  // discovery example (B/D); `-t`/`--tools` forces the `Known tools:` form;
  // and `-f`/`--full`/`--schemas` forces the full <mcp-context> catalog.
  // The `/mcp:<server>` slash form always expands to the full catalog.
  function renderMention(
    serverName: string,
    options: MentionRenderOptions,
    renderFull: (serverName: string) => string,
  ): string {
    if (options.full) return renderFull(serverName);
    if (options.listTools) return renderUseWithTools(serverName);
    return renderUse(serverName);
  }

  function renderUse(serverName: string): string {
    const status = statuses.get(serverName);
    const catalog = options.getCatalog();
    return renderServerUse(serverName, status, {
      entry: catalog?.servers[serverName],
      config: catalog?.config ?? options.getConfig?.(),
      directToolOverride: catalog?.directToolOverride ?? options.getDirectToolOverride?.(),
    });
  }

  function renderUseWithTools(serverName: string): string {
    const entry = options.getCatalog()?.servers[serverName];
    const status = statuses.get(serverName);
    return renderServerUseWithTools(serverName, entry, status);
  }

  function renderContext(serverName: string, includeSchemas = false): string {
    const entry = options.getCatalog()?.servers[serverName];
    return renderServerContext(serverName, entry, statuses.get(serverName), { includeSchemas });
  }

  function statusSuffix(serverName: string): string {
    const status = statuses.get(serverName);
    if (!status) return " (cached)";
    return ` (${status.status}, ${status.toolCount} tools)`;
  }

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }
}

/** Minimal shape of the `current` autocomplete provider passed by Pi. */
interface AutocompleteProviderCurrent {
  getSuggestions?(lines: string[], line: number, col: number, options: unknown): unknown;
  applyCompletion?(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string): unknown;
  shouldTriggerFileCompletion?(lines: string[], line: number, col: number): boolean;
}

function isStatusSnapshot(value: unknown): value is McpStatusSnapshot {
  if (!isRecord(value) || !Array.isArray(value.servers)) return false;
  return value.servers.every((server) => {
    if (!isRecord(server)) return false;
    return typeof server.name === "string"
      && typeof server.status === "string"
      && typeof server.toolCount === "number"
      && typeof server.disabled === "boolean";
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Re-export the public types/helpers for consumers and tests.
export {
  createServerIndex,
  expandServerMentions,
  filterServerCompletions,
  parseCommandInput,
  renderServerContext,
  renderServerUse,
  renderServerUseWithTools,
  resolveServerReference,
  buildEditorText,
  escapeXml,
  resolveDirectToolMode,
  listDirectToolNames,
} from "./mcp-context-lib.ts";

export type {
  AutocompleteItem,
  McpContextCatalog,
  ServerIndex,
} from "./mcp-context-lib.ts";

// Keep an unused-import guard satisfied in environments that strip the value
// but keep the type import: McpServerStatusSnapshot is referenced in the
// statusHandler narrowing above.
export type { McpServerStatusSnapshot } from "./types.ts";
