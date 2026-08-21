// mcp-mention-renderer.ts - Collapsible TUI component for `#server` mentions.
//
// Mirrors pi's built-in SkillInvocationMessageComponent so a `#server` mention
// renders as `[mcp] "server" (ctrl+o to expand)` when collapsed while keeping
// the user's prompt visible below the folded block. Pi drives expansion via the
// global `toolOutputExpanded` toggle (ctrl+o), which CustomMessageComponent
// forwards to the renderer through `MessageRenderOptions.expanded`.

import { Box, Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";

/** Minimal CustomMessage shape the renderer needs. Keeps us independent of the
 *  internal `CustomMessage` type (not re-exported from the package root). */
interface CustomMessageLike<T> {
  customType: string;
  content: string | unknown[];
  display: boolean;
  details?: T;
  timestamp: number;
}

/** Details stored on the CustomMessage so the renderer can split the block
 *  from the user prompt without re-parsing the combined content. */
export interface McpMentionDetails {
  serverName: string;
  /** The `<use-mcp>` block text shown when expanded. */
  blockText: string;
  /** The user's prompt, shown separately from the MCP block (may be empty). */
  prompt: string;
}

/**
 * Build the component tree for an `mcp-mention` CustomMessage.
 *
 * Collapsed: `[mcp] "server" (ctrl+o to expand)`; the MCP block folds and the
 *            user prompt renders as a separate user-message box below it.
 * Expanded:  `[mcp] server` header with the `<use-mcp>` block as markdown; the
 *            user prompt again renders as a separate user-message box below.
 *
 * Returns undefined to fall back to pi's default `[mcp-mention]` box rendering
 * if the message shape is unexpected.
 */
export function renderMcpMention(
  message: CustomMessageLike<McpMentionDetails>,
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Component | undefined {
  const details = message.details;
  if (!details || typeof details.serverName !== "string") return undefined;

  const mdTheme = getMarkdownTheme();
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

  const label = theme.fg("customMessageLabel", `\x1b[1m[mcp]\x1b[22m`);

  const prompt = typeof details.prompt === "string" ? details.prompt.trim() : "";
  // Match Pi's skill invocation rendering: the user prompt is NOT part of
  // the collapsible block. It renders as a separate user-message box below,
  // exactly like UserMessageComponent does for skillBlock.userMessage.
  const addPrompt = (outer: Container): void => {
    if (!prompt) return;
    const contentBox = new Box(1, 1, (t) => theme.bg("userMessageBg", t));
    contentBox.addChild(new Markdown(prompt, 0, 0, mdTheme, {
      color: (t) => theme.fg("userMessageText", t),
    }));
    outer.addChild(new Spacer(1));
    outer.addChild(contentBox);
  };

  const outer = new Container();
  outer.addChild(box);

  if (!options.expanded) {
    const line = label +
      theme.fg("customMessageText", ` ${details.serverName}`) +
      theme.fg("dim", ` (ctrl+o to expand)`);
    box.addChild(new Text(line, 0, 0));
    // Match Pi's skill invocation behavior: the context block folds, but the
    // original user request renders as a separate user message below it.
    addPrompt(outer);
    return outer;
  }

  // Expanded: label + server name header + block body.
  box.addChild(new Text(`${label} ${theme.fg("customMessageText", details.serverName)}`, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(details.blockText, 0, 0, mdTheme, {
    color: (text) => theme.fg("customMessageText", text),
  }));

  addPrompt(outer);
  return outer;
}
