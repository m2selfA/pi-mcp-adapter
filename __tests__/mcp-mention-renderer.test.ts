import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { renderMcpMention, type McpMentionDetails } from "../mcp-mention-renderer.ts";

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
} as unknown as Theme;

// renderMcpMention embeds literal bold/reset codes in the label and Markdown
// autolinks URLs as OSC 8 hyperlinks (terminated by ST, not BEL), so
// assertions run on stripped output (same convention as mcp-panel tests).
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

function message(prompt: string) {
  return {
    customType: "mcp-mention",
    content: "",
    display: true,
    details: {
      serverName: "github",
      blockText: "<use-mcp server=\"github\">\nuse github mcp;\n</use-mcp>",
      prompt,
    } satisfies McpMentionDetails,
    timestamp: 0,
  };
}

describe("MCP mention renderer", () => {
  beforeAll(() => initTheme("dark"));

  it("keeps the user prompt visible when the MCP block is collapsed", () => {
    const component = renderMcpMention(
      message("了解webcodex(https://github.com/yyjeqhc/webcodex)的用法"),
      { expanded: false, outputPad: 1 },
      plainTheme,
    );

    expect(component).toBeDefined();
    const output = stripAnsi(component!.render(120).join("\n"));
    const header = "[mcp] github (ctrl+o to expand)";
    const prompt = "了解webcodex(https://github.com/yyjeqhc/webcodex)的用法";
    expect(output).toContain(header);
    expect(output).toContain(prompt);
    expect(output.indexOf(prompt)).toBeGreaterThan(output.indexOf(header));
    expect(output).not.toContain("use github mcp;");
  });

  it("renders the MCP block and prompt when expanded", () => {
    const component = renderMcpMention(
      message("了解 webcodex 的用法"),
      { expanded: true, outputPad: 1 },
      plainTheme,
    );

    expect(component).toBeDefined();
    const output = stripAnsi(component!.render(120).join("\n"));
    expect(output).toContain("[mcp] github");
    expect(output).toContain("use github mcp;");
    expect(output).toContain("了解 webcodex 的用法");
  });

  it("does not add a prompt section when there is no prompt", () => {
    const component = renderMcpMention(message(""), { expanded: false, outputPad: 1 }, plainTheme);

    expect(component).toBeDefined();
    const output = stripAnsi(component!.render(120).join("\n"));
    expect(output).toContain("[mcp] github (ctrl+o to expand)");
    expect(output).not.toContain("use github mcp;");
  });
});
