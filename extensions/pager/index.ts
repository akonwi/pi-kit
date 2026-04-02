/**
 * Pager extension — view long assistant responses with markdown rendering.
 *
 * Shows one section at a time. Navigate between sections with h/l.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, type Focusable, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { splitSections } from "./split-sections";

const LONGFORM_MIN_CHARS = 100;

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

function buildSectionsFromLastAssistant(ctx: ExtensionCommandContext): { title: string; sections: { title: string; body: string }[] } | null {
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

  return {
    title: clip(sections[0].title, 50),
    sections: sections.map(s => ({
      title: s.sectionTitle ? `${s.sectionTitle}: ${s.title}` : s.title,
      body: s.body.trim(),
    })),
  };
}

// --- Pager Component ---

class PagerComponent implements Focusable {
  focused = false;

  private markdown: Markdown;
  private renderedLines: string[] = [];
  private scrollOffset = 0;
  private viewportHeight = 0;
  private showHelp = false;

  constructor(
    private theme: Theme,
    private title: string,
    private sections: { title: string; body: string }[],
    private currentIndex: number,
    private done: (result: undefined) => void,
  ) {
    this.markdown = new Markdown("", 1, 0, {
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
    this.updateContent();
  }

  private updateContent(): void {
    const section = this.sections[this.currentIndex];
    if (section) {
      // Section body already contains content, don't duplicate title
      this.markdown.setText(section.body);
      this.scrollOffset = 0;
    }
  }

  handleInput(data: string): void {
    if (this.showHelp) {
      this.showHelp = false;
      return;
    }

    // Quit
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
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

    // Page up within section
    if (matchesKey(data, "pageup") || matchesKey(data, "b")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
      return;
    }

    // Page down within section
    if (matchesKey(data, "pagedown") || matchesKey(data, "f")) {
      this.scrollOffset = Math.min(this.renderedLines.length - this.viewportHeight, this.scrollOffset + this.viewportHeight);
      return;
    }

    // Previous section
    if (matchesKey(data, "h") || matchesKey(data, "left")) {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        this.updateContent();
      }
      return;
    }

    // Next section
    if (matchesKey(data, "l") || matchesKey(data, "right") || matchesKey(data, "return") || matchesKey(data, "space")) {
      if (this.currentIndex < this.sections.length - 1) {
        this.currentIndex++;
        this.updateContent();
      } else {
        // Last section - close pager
        this.done(undefined);
      }
      return;
    }

    // Jump to section by number
    const num = parseInt(data, 10);
    if (num >= 1 && num <= this.sections.length) {
      this.currentIndex = num - 1;
      this.updateContent();
      return;
    }

    // Toggle help
    if (matchesKey(data, "?")) {
      this.showHelp = !this.showHelp;
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const border = th.fg("border", "│");
    const innerWidth = width - 2;

    // Render current section
    this.renderedLines = this.markdown.render(innerWidth);

    // Calculate viewport height
    this.viewportHeight = process.stdout.rows ? process.stdout.rows - 5 : 20;

    // Clamp scroll offset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.renderedLines.length - this.viewportHeight)));

    const lines: string[] = [];
    const sectionTitle = this.sections[this.currentIndex]?.title ?? "";
    const headerText = this.showHelp ? " Pager Help " : ` ${clip(sectionTitle, innerWidth - 10)} `;

    // Header with section counter
    const counter = `[${this.currentIndex + 1}/${this.sections.length}]`;
    const headerLine = th.fg("accent", headerText);
    const headerPad = Math.max(0, innerWidth - visibleWidth(headerLine) - visibleWidth(counter) - 1);

    lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(`${border}${headerLine}${" ".repeat(headerPad)} ${th.fg("dim", counter)}${border}`);

    if (!this.showHelp) {
      // Content with scroll
      const visibleLines = this.renderedLines.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
      for (const line of visibleLines) {
        const linePad = Math.max(0, innerWidth - visibleWidth(line));
        lines.push(`${border}${line}${" ".repeat(linePad)}${border}`);
      }

      // Fill remaining space
      const remaining = this.viewportHeight - visibleLines.length;
      for (let i = 0; i < remaining; i++) {
        lines.push(`${border}${" ".repeat(innerWidth)}${border}`);
      }

      // Footer
      const moreBelow = this.scrollOffset < this.renderedLines.length - this.viewportHeight;
      const moreAbove = this.scrollOffset > 0;
      const scrollHint = (moreAbove || moreBelow) ? `(${moreAbove ? "↑" : ""}${moreBelow ? "↓" : ""} scroll)` : "";
      const controls = `h/l prev/next • ↑↓ scroll • 1-9 jump • ? help • q quit`;
      const controlsLine = th.fg("dim", controls);
      const controlsPad = Math.max(0, innerWidth - visibleWidth(controlsLine) - visibleWidth(scrollHint) - 1);
      lines.push(`${border}${controlsLine}${" ".repeat(controlsPad)}${scrollHint ? th.fg("dim", scrollHint) + border : " " + border}`);
    } else {
      // Help screen
      const helpLines = [
        "",
        " Navigation:",
        "  h/←     Previous section",
        "  l/→     Next section (or Enter/Space)",
        "  ↑/k     Scroll up one line",
        "  ↓/j     Scroll down one line",
        "  b       Page up within section",
        "  f       Page down within section",
        "  1-9     Jump to section N",
        "",
        " Actions:",
        "  ?       Toggle this help",
        "  q/Esc   Close pager",
        "",
        " Press any key to close",
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
    description: "Page through last assistant response",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const result = buildSectionsFromLastAssistant(ctx);
      if (!result) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      if (result.sections.length === 0) {
        ctx.ui.notify("No sections found in response.", "warning");
        return;
      }

      // Start at first section
      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) => new PagerComponent(theme, result.title, result.sections, 0, done),
        { overlay: true },
      );
    },
  });
}