/**
 * Pager extension — view long assistant responses with markdown rendering.
 *
 * Uses ctx.ui.custom() with Pi's Markdown component for proper
 * markdown rendering, section navigation, and keyboard controls.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, type Focusable, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { splitSections } from "./split-sections";

const LONGFORM_MIN_CHARS = 500;

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function messageText(msg: AgentMessage): string {
  const content: unknown = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildLongFormContentFromLastAssistant(ctx: ExtensionCommandContext): { title: string; content: string; sections: { title: string; line: number }[] } | null {
  const branch = Array.isArray(ctx.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];

  let lastAssistant: AgentMessage | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    lastAssistant = entry.message as AgentMessage;
    break;
  }

  if (!lastAssistant) return null;

  const text = messageText(lastAssistant).trim();
  if (!text || text.length < LONGFORM_MIN_CHARS) return null;

  const sections = splitSections(text);
  if (sections.length === 0) return null;

  // Build content with section markers
  const lines: string[] = [];
  const sectionMarkers: { title: string; line: number }[] = [];

  for (const section of sections) {
    const title = section.sectionTitle
      ? `${section.sectionTitle}: ${section.title}`
      : section.title;

    sectionMarkers.push({ title: clip(title, 50), line: lines.length });
    lines.push(`\n## ${title}`);
    lines.push(section.body.trim());
  }

  return {
    title: clip(sections[0].title, 50),
    content: lines.join("\n"),
    sections: sectionMarkers,
  };
}

// --- Pager Component ---

class PagerComponent implements Focusable {
  focused = false;

  private markdown: Markdown;
  private scrollOffset = 0;
  private renderedLines: string[] = [];
  private viewportHeight = 0;
  private showHelp = false;

  constructor(
    private theme: Theme,
    private title: string,
    private content: string,
    private sections: { title: string; line: number }[],
    private done: (result: undefined) => void,
  ) {
    this.markdown = new Markdown(content, 1, 0, {
      heading: (text) => theme.fg("accent", text),
      link: (text) => theme.fg("accent", text),
      linkUrl: (text) => theme.fg("dim", text),
      code: (text) => theme.fg("warning", text),
      codeBlock: (text) => theme.fg("text", text),
      codeBlockBorder: (text) => theme.fg("border", text),
      quote: (text) => theme.fg("dim", text),
      quoteBorder: (text) => theme.fg("border", text),
      hr: (text) => theme.fg("border", text),
      listBullet: (text) => theme.fg("dim", text),
      bold: (text) => theme.fg("accent", text),
      italic: (text) => theme.fg("dim", text),
      strikethrough: (text) => theme.fg("dim", text),
      underline: (text) => text,
    });
  }

  handleInput(data: string): void {
    if (this.showHelp) {
      this.showHelp = false;
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "space")) {
      this.done(undefined);
      return;
    }

    // Scroll up
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return;
    }

    // Scroll down
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(this.renderedLines.length - this.viewportHeight, this.scrollOffset + 1);
      return;
    }

    // Page up
    if (matchesKey(data, "pageup") || matchesKey(data, "b")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
      return;
    }

    // Page down
    if (matchesKey(data, "pagedown") || matchesKey(data, "f")) {
      this.scrollOffset = Math.min(this.renderedLines.length - this.viewportHeight, this.scrollOffset + this.viewportHeight);
      return;
    }

    // Go to top
    if (matchesKey(data, "g")) {
      this.scrollOffset = 0;
      return;
    }

    // Go to bottom
    if (matchesKey(data, "G")) {
      this.scrollOffset = Math.max(0, this.renderedLines.length - this.viewportHeight);
      return;
    }

    // Jump to section by number
    const num = parseInt(data, 10);
    if (num >= 1 && num <= this.sections.length) {
      const section = this.sections[num - 1];
      if (section) {
        this.scrollOffset = Math.max(0, section.line);
      }
      return;
    }

    // Show help
    if (matchesKey(data, "h") || matchesKey(data, "?")) {
      this.showHelp = !this.showHelp;
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const border = th.fg("border", "│");
    const innerWidth = width - 2;

    // Render markdown content at inner width
    this.renderedLines = this.markdown.render(innerWidth);

    // Calculate viewport height (leave room for header/footer)
    this.viewportHeight = process.stdout.rows ? process.stdout.rows - 4 : 20;

    // Clamp scroll offset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.renderedLines.length - this.viewportHeight)));

    const lines: string[] = [];

    // Header
    const headerText = this.showHelp ? " Pager Help " : ` Pager: ${this.title} `;
    const headerPad = Math.max(0, innerWidth - visibleWidth(headerText));
    lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(`${border}${th.fg("accent", headerText)}${" ".repeat(headerPad)}${border}`);

    if (!this.showHelp) {
      // Section navigation hint
      if (this.sections.length > 1) {
        const sectionHint = this.sections.slice(0, 5).map((s, i) => `${i + 1}:${clip(s.title, 15)}`).join(" ");
        const moreCount = this.sections.length > 5 ? ` +${this.sections.length - 5}` : "";
        const sectionLine = th.fg("dim", `Sections: ${sectionHint}${moreCount}`);
        const sectionLinePad = Math.max(0, innerWidth - visibleWidth(sectionLine));
        lines.push(`${border}${sectionLine}${" ".repeat(sectionLinePad)}${border}`);
      }

      // Content with scroll
      const visibleLines = this.renderedLines.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight - 3);
      for (const line of visibleLines) {
        const linePad = Math.max(0, innerWidth - visibleWidth(line));
        lines.push(`${border}${line}${" ".repeat(linePad)}${border}`);
      }

      // Fill remaining space
      const remaining = this.viewportHeight - 3 - visibleLines.length;
      for (let i = 0; i < remaining; i++) {
        lines.push(`${border}${" ".repeat(innerWidth)}${border}`);
      }

      // Footer with controls
      const position = `${this.scrollOffset + 1}/${this.renderedLines.length}`;
      const controls = "↑↓/jk scroll • f/b page • g/G top/bot • 1-9 section • h help • q quit";
      const controlsLine = th.fg("dim", controls);
      const controlsPad = Math.max(0, innerWidth - visibleWidth(controlsLine) - visibleWidth(position) - 1);
      lines.push(`${border}${controlsLine}${" ".repeat(controlsPad)} ${th.fg("dim", position)}${border}`);
    } else {
      // Help screen
      const helpLines = [
        "",
        " Navigation:",
        "  ↑/k     Scroll up one line",
        "  ↓/j     Scroll down one line",
        "  b       Page up",
        "  f       Page down",
        "  g       Go to top",
        "  G       Go to bottom",
        "  1-9     Jump to section",
        "",
        " Actions:",
        "  h/?     Toggle this help",
        "  q/Esc   Close pager",
        "  Enter   Close pager",
        "",
        " Press any key to close help",
        "",
      ];
      for (const line of helpLines) {
        const styledLine = th.fg("text", line);
        const linePad = Math.max(0, innerWidth - visibleWidth(styledLine));
        lines.push(`${border}${styledLine}${" ".repeat(linePad)}${border}`);
      }
    }

    lines.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  dispose(): void {}
}

// --- Extension factory ---

export default function pagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pager", {
    description: "Open pager for last assistant response",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const result = buildLongFormContentFromLastAssistant(ctx);
      if (!result) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) => new PagerComponent(theme, result.title, result.content, result.sections, done),
        { overlay: true },
      );
    },
  });
}