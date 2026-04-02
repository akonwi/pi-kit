/**
 * Pager extension — view long assistant responses with markdown rendering
 * and per-section notes for contextualized feedback.
 *
 * Shows one section at a time. Navigate with h/l. Press n to edit note
 * for current section. Ctrl+Enter submits all notes as feedback.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { Editor, Markdown, type Focusable, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
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

function formatFeedbackMessage(sections: { title: string; body: string }[], notes: Map<number, string>): string | null {
  const blocks: string[] = [];

  sections.forEach((section, idx) => {
    const note = notes.get(idx)?.trim();
    if (!note) return;
    blocks.push(`## ${section.title}\n${note}`);
  });

  if (blocks.length === 0) return null;

  return [
    "Here is my feedback on your previous response, grouped by section.",
    "",
    ...blocks.flatMap((block, idx) => (idx === 0 ? [block] : ["", block])),
    "",
    "Please use this section-specific feedback in your revision or reply.",
  ].join("\n");
}

// --- Pager Component ---

class PagerComponent implements Focusable {
  focused = false;

  private markdown: Markdown;
  private noteEditor: Editor;
  private renderedLines: string[] = [];
  private scrollOffset = 0;
  private viewportHeight = 0;
  private mode: "navigate" | "edit" = "navigate";

  constructor(
    private theme: Theme,
    private title: string,
    private sections: { title: string; body: string }[],
    private currentIndex: number,
    private notes: Map<number, string>,
    private done: (result: undefined) => void,
    private onSubmitMessage: (message: string) => void,
    tui: any,
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

    // Create note editor with theme
    const editorTheme = {
      borderColor: (s: string) => theme.fg("border", s),
      selectList: {
        selected: (s: string) => theme.fg("accent", s),
        unselected: (s: string) => theme.fg("text", s),
        border: (s: string) => theme.fg("border", s),
        description: (s: string) => theme.fg("dim", s),
      },
    };
    this.noteEditor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.noteEditor.disableSubmit = true; // We'll handle submit ourselves
    this.noteEditor.borderColor = (s) => theme.fg("border", s);

    this.updateContent();
  }

  private updateContent(): void {
    const section = this.sections[this.currentIndex];
    if (section) {
      this.markdown.setText(section.body);
      this.scrollOffset = 0;
      // Load note for this section into editor
      this.noteEditor.setText(this.notes.get(this.currentIndex) || "");
    }
  }

  private saveCurrentNote(): void {
    const text = this.noteEditor.getText().trim();
    if (text) {
      this.notes.set(this.currentIndex, text);
    } else {
      this.notes.delete(this.currentIndex);
    }
  }

  private getNoteCount(): number {
    let count = 0;
    for (let i = 0; i < this.sections.length; i++) {
      const note = i === this.currentIndex
        ? this.noteEditor.getText().trim()
        : (this.notes.get(i)?.trim() || "");
      if (note) count++;
    }
    return count;
  }

  handleInput(data: string): void {
    // In edit mode, pass to editor
    if (this.mode === "edit") {
      // Escape exits edit mode
      if (matchesKey(data, "escape")) {
        this.saveCurrentNote();
        this.mode = "navigate";
        return;
      }
      // Ctrl+Enter submits all notes
      if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+s")) {
        this.saveCurrentNote();
        const message = formatFeedbackMessage(this.sections, this.notes);
        if (message) {
          this.done(undefined);
          this.onSubmitMessage(message);
        } else {
          // No notes, stay in edit mode
        }
        return;
      }
      // Let editor handle input
      this.noteEditor.handleInput(data);
      return;
    }

    // Navigate mode
    if (this.showHelp) {
      this.showHelp = false;
      return;
    }

    // Quit
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.saveCurrentNote();
      this.done(undefined);
      return;
    }

    // Enter edit mode
    if (matchesKey(data, "n") || matchesKey(data, "i") || matchesKey(data, "return")) {
      this.mode = "edit";
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

    // Previous section
    if (matchesKey(data, "h") || matchesKey(data, "left")) {
      if (this.currentIndex > 0) {
        this.saveCurrentNote();
        this.currentIndex--;
        this.updateContent();
      }
      return;
    }

    // Next section
    if (matchesKey(data, "l") || matchesKey(data, "right")) {
      if (this.currentIndex < this.sections.length - 1) {
        this.saveCurrentNote();
        this.currentIndex++;
        this.updateContent();
      }
      return;
    }

    // Jump to section by number
    const num = parseInt(data, 10);
    if (num >= 1 && num <= this.sections.length) {
      this.saveCurrentNote();
      this.currentIndex = num - 1;
      this.updateContent();
      return;
    }

    // Toggle help
    if (matchesKey(data, "?")) {
      this.showHelp = !this.showHelp;
      return;
    }

    // Submit notes
    if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+s")) {
      this.saveCurrentNote();
      const message = formatFeedbackMessage(this.sections, this.notes);
      if (message) {
        this.done(undefined);
        this.onSubmitMessage(message);
      }
      return;
    }
  }

  private showHelp = false;

  render(width: number): string[] {
    const th = this.theme;
    const border = th.fg("border", "│");
    const innerWidth = width - 2;

    // Render current section
    this.renderedLines = this.markdown.render(innerWidth);

    // Reserve space for header (2), footer (1), note editor (3), and status (1)
    const noteEditorHeight = 3;
    const headerLines = 2;
    const footerLines = 1;
    const statusLine = 1;
    this.viewportHeight = (process.stdout.rows || 24) - headerLines - footerLines - noteEditorHeight - statusLine - 2;
    this.viewportHeight = Math.max(5, this.viewportHeight);

    // Clamp scroll offset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.renderedLines.length - this.viewportHeight)));

    const lines: string[] = [];
    const sectionTitle = this.sections[this.currentIndex]?.title ?? "";

    // Header: section dots, position, note count
    const dots = this.sections.map((_, idx) => {
      const hasNote = idx === this.currentIndex
        ? this.mode === "edit" || Boolean(this.noteEditor.getText().trim())
        : Boolean(this.notes.get(idx)?.trim());
      if (idx === this.currentIndex) {
        return this.mode === "edit" ? th.fg("warning", "◆") : th.fg("accent", "●");
      }
      return hasNote ? th.fg("success", "●") : th.fg("dim", "○");
    }).join(" ");

    const posNotes = `${this.currentIndex + 1}/${this.sections.length} · ${this.getNoteCount()} note${this.getNoteCount() === 1 ? "" : "s"}`;
    const leftPart = `${dots}  ${th.fg("dim", posNotes)}`;
    const leftPlain = leftPart.replace(/\x1b\[[0-9;]*m/g, "");
    const rightPart = th.fg("dim", clip(sectionTitle, innerWidth - leftPlain.length - 2));
    const rightPlain = rightPart.replace(/\x1b\[[0-9;]*m/g, "");
    const headerGap = Math.max(1, innerWidth - visibleWidth(leftPart) - visibleWidth(rightPart));

    lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(`${border}${leftPart}${" ".repeat(headerGap)}${rightPart}${border}`);

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

      // Note editor
      const noteLabel = this.mode === "edit"
        ? th.fg("warning", "NOTE:")
        : th.fg("dim", "Note:");
      const noteText = this.noteEditor.getText();
      const notePreview = noteText.length > 0
        ? clip(noteText.split("\n")[0] || "", innerWidth - 10)
        : th.fg("dim", this.mode === "edit" ? "Type your note..." : "(press n to add note)");

      if (this.mode === "edit") {
        // Show editor with border
        const editorLines = this.noteEditor.render(innerWidth);
        lines.push(`${border}${th.fg("border", "─".repeat(innerWidth))}${border}`);
        for (const editorLine of editorLines.slice(0, noteEditorHeight)) {
          const linePad = Math.max(0, innerWidth - visibleWidth(editorLine));
          lines.push(`${border}${editorLine}${" ".repeat(linePad)}${border}`);
        }
        // Fill editor to height
        for (let i = editorLines.length; i < noteEditorHeight; i++) {
          lines.push(`${border}${" ".repeat(innerWidth)}${border}`);
        }
      } else {
        // Show note preview
        lines.push(`${border}${th.fg("border", "─".repeat(innerWidth))}${border}`);
        lines.push(`${border}${noteLabel} ${notePreview}${" ".repeat(Math.max(0, innerWidth - visibleWidth(noteLabel) - visibleWidth(notePreview) - 2))}${border}`);
        lines.push(`${border}${" ".repeat(innerWidth)}${border}`);
      }

      // Status line
      const status = this.mode === "edit"
        ? th.fg("warning", "EDIT MODE") + th.fg("dim", " · Esc to navigate · Ctrl+Enter submit")
        : th.fg("dim", "h/l section · n note · Ctrl+Enter submit · ? help · q quit");
      const statusPad = Math.max(0, innerWidth - visibleWidth(status));
      lines.push(`${border}${status}${" ".repeat(statusPad)}${border}`);
    } else {
      // Help screen
      const helpLines = [
        "",
        " Navigation (navigate mode):",
        "  h/←     Previous section",
        "  l/→     Next section",
        "  ↑/k     Scroll up",
        "  ↓/j     Scroll down",
        "  b/f     Page up/down",
        "  1-9     Jump to section",
        "",
        " Notes:",
        "  n/i/Enter  Edit note for current section",
        "  Esc        Exit edit mode / close pager",
        "",
        " Submit:",
        "  Ctrl+Enter Submit all notes as feedback",
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
    this.noteEditor.invalidate();
  }

  dispose(): void {}
}

// --- Extension factory ---

export default function pagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pager", {
    description: "Page through last assistant response with notes",
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

      const notes = new Map<number, string>();

      await ctx.ui.custom<undefined>(
        (tui: any, theme: any, _keybindings: any, done: (result: undefined) => void) => {
          return new PagerComponent(
            theme,
            result.title,
            result.sections,
            0,
            notes,
            done,
            (message: string) => {
              // Submit feedback message
              pi.sendUserMessage(message);
            },
            tui,
          );
        },
        { overlay: true },
      );
    },
  });
}