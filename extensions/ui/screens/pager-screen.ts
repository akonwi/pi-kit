import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth as tuiTruncateToWidth } from "@mariozechner/pi-tui";
import type { InteractionDockController, ScreenController } from "../shell";

export type LongFormSection = {
  title: string;
  body: string;
};

export type LongFormPagerContent = {
  sessionId: string;
  entryId: string;
  sections: LongFormSection[];
};

export type PagerScreenOptions = {
  ctx: any;
  pager: LongFormPagerContent;
  notes: Map<number, string>;
  startIndex?: number;
  dock: InteractionDockController;
  formatFeedbackMessage: (pager: LongFormPagerContent, notes: Map<number, string>) => string | null;
  onSubmitMessage: (message: string) => void;
  onClosed?: () => void;
};

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "");
}

export function openPagerScreen(options: PagerScreenOptions): ScreenController {
  const { ctx, pager, notes } = options;
  const { sections } = pager;

  let index = Math.max(0, Math.min(sections.length - 1, options.startIndex ?? 0));
  let scrollOffset = 0;
  let lastRenderWidth = Math.max(24, (process.stdout.columns || 80) - 2);
  let isSubmittingNotes = false;
  const previousEditorText = ctx.ui.getEditorText();
  let pagerTui: any = null;
  let closeOverlay: (() => void) | undefined;
  let closed = false;
  let lastSectionNavDirection: "next" | "prev" | null = null;
  let lastSectionNavAt = 0;

  const persistCurrentNote = () => {
    const normalized = ctx.ui.getEditorText().trim();
    if (normalized) notes.set(index, normalized);
    else notes.delete(index);
  };

  const loadCurrentNote = () => {
    ctx.ui.setEditorText(notes.get(index) || "");
  };

  const requestRender = () => {
    pagerTui?.requestRender?.();
  };

  const getPagerMetrics = (inside: number) => {
    const section = sections[index]!;
    const md = new Markdown(section.body, 0, 0, getMarkdownTheme(), {
      color: (text: string) => ctx.ui.theme.fg("text", text),
    });
    const bodyLines = md.render(Math.max(12, inside - 4));
    const termRows = process.stdout.rows || 40;
    const availableRows = Math.max(8, termRows - 10);
    const visibleBodyRows = Math.max(4, availableRows - 9);
    const maxScroll = Math.max(0, bodyLines.length - visibleBodyRows);

    return { section, bodyLines, availableRows, visibleBodyRows, maxScroll };
  };

  const moveToSection = (nextIndex: number, direction: "next" | "prev") => {
    if (nextIndex === index) return;

    const now = Date.now();
    if (lastSectionNavDirection === direction && now - lastSectionNavAt < 75) {
      return;
    }
    lastSectionNavDirection = direction;
    lastSectionNavAt = now;

    persistCurrentNote();
    index = nextIndex;
    scrollOffset = 0;
    loadCurrentNote();
    options.dock.refresh();
    requestRender();
  };

  const close = (restoreEditor = true) => {
    if (closed) return;
    closed = true;
    persistCurrentNote();

    const tuiForClose = pagerTui;
    closeOverlay?.();
    closeOverlay = undefined;
    ctx.ui.setStatus("pager", undefined);
    if (restoreEditor) ctx.ui.setEditorText(previousEditorText);
    options.dock.refresh();
    queueMicrotask(() => {
      tuiForClose?.requestRender?.(true);
    });

    options.onClosed?.();
  };

  const getLiveNoteForCurrentSection = (): string => ctx.ui.getEditorText().trim();

  const submitSectionNotes = () => {
    if (isSubmittingNotes) return;

    persistCurrentNote();
    const message = options.formatFeedbackMessage(pager, notes);
    if (!message) {
      ctx.ui.notify("No section feedback to send yet.", "warning");
      return;
    }

    isSubmittingNotes = true;

    try {
      close(true);
      options.onSubmitMessage(message);
    } catch (error) {
      isSubmittingNotes = false;
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to send feedback: ${detail}`, "error");
      requestRender();
    }
  };


  loadCurrentNote();
  ctx.ui.setStatus(
    "pager",
    ctx.ui.theme.fg("dim", "pager: Enter send • Esc close • clear editor to clear note • Ctrl+Shift+←/→ section • Ctrl+Shift+↑/↓ scroll"),
  );

  void ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: any, done: (result: void) => void) => {
      pagerTui = tui;
      closeOverlay = () => done(undefined);

      return {
        render(width: number): string[] {
          const inside = Math.max(24, width - 2);
          lastRenderWidth = inside;

          const fit = (s: string) => {
            const truncated = tuiTruncateToWidth(s, inside);
            const plain = stripAnsi(truncated);
            return plain.length >= inside ? truncated : `${truncated}${" ".repeat(inside - plain.length)}`;
          };
          const bc = (s: string) => theme.fg("borderAccent", s);
          const row = (content = "") => `${bc("│")}${fit(content)}${bc("│")}`;

          const liveCurrentNote = getLiveNoteForCurrentSection();
          const noteCount = sections.reduce((count, _section, idx) => {
            const note = idx === index ? liveCurrentNote : (notes.get(idx)?.trim() || "");
            return count + (note ? 1 : 0);
          }, 0);
          const dots = sections
            .map((_, idx) => {
              const hasNote = idx === index ? Boolean(liveCurrentNote) : Boolean(notes.get(idx)?.trim());
              if (idx === index) return theme.fg("accent", hasNote ? "◆" : "●");
              return hasNote ? theme.fg("success", "●") : theme.fg("dim", "○");
            })
            .join(" ");

          const { section, bodyLines, availableRows, visibleBodyRows, maxScroll } = getPagerMetrics(inside);
          scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

          const visibleBodyLines = bodyLines.slice(scrollOffset, scrollOffset + visibleBodyRows);
          const firstVisibleLine = bodyLines.length === 0 ? 0 : scrollOffset + 1;
          const lastVisibleLine = bodyLines.length === 0
            ? 0
            : Math.min(bodyLines.length, scrollOffset + visibleBodyLines.length);
          const scrollStatus = maxScroll > 0
            ? `Lines ${firstVisibleLine}-${lastVisibleLine} / ${bodyLines.length}`
            : `Lines ${bodyLines.length}`;
          const currentNote = liveCurrentNote;
          const noteStatus = currentNote
            ? theme.fg("success", "Composing in the shared editor below")
            : theme.fg("dim", "Type in the shared editor below to leave feedback for this section");
          const escapeStatus = theme.fg("dim", "Esc closes pager");

          const content = [
            `${bc("╭")}${bc("─".repeat(inside))}${bc("╮")}`,
            row(theme.fg("accent", theme.bold(`Long response • ${index + 1}/${sections.length} • ${noteCount} note${noteCount === 1 ? "" : "s"}`))),
            row(theme.fg("text", theme.bold(section.title))),
            row(`${dots}`),
            row(theme.fg("dim", scrollStatus)),
            row(noteStatus),
            row(escapeStatus),
            row(),
            ...visibleBodyLines.map((line) => row(` ${line}`)),
            ...Array.from({ length: Math.max(0, visibleBodyRows - visibleBodyLines.length) }, () => row()),
            row(),
            row(theme.fg("dim", "Shared composer below • clear editor to clear note • Enter sends all notes")),
            row(theme.fg("dim", "Esc closes pager • Ctrl+Shift+←/→ section • Ctrl+Shift+↑/↓ scroll")),
            `${bc("╰")}${bc("─".repeat(inside))}${bc("╯")}`,
          ];

          return content.slice(0, availableRows);
        },

        invalidate(): void {},
        dispose(): void {
          if (pagerTui === tui) pagerTui = null;
          closeOverlay = undefined;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => {
        const metrics = options.dock.getMetrics();
        const termRows = process.stdout.rows || 40;
        const maxHeight = Math.max(8, termRows - metrics.panelLines - 2);
        return {
          row: 0,
          col: 0,
          width: "100%",
          maxHeight,
          nonCapturing: true,
        };
      },
    },
  );

  requestRender();

  return {
    id: "pager",
    activate(): void {
      options.dock.setState({
        surface: "text-composer",
        mode: "pager",
        supportsPicker: true,
      });
      options.dock.refresh();
    },
    deactivate(): void {},
    handleInput(data: string) {
      if (closed) return undefined;
      if (options.dock.blocksScreenInput()) return undefined;

      const { maxScroll } = getPagerMetrics(lastRenderWidth);

      if (matchesKey(data, Key.escape)) {
        close(true);
        return { consume: true };
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) {
        submitSectionNotes();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+right"))) {
        if (index < sections.length - 1) moveToSection(index + 1, "next");
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+left"))) {
        if (index > 0) moveToSection(index - 1, "prev");
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+up"))) {
        if (scrollOffset > 0) scrollOffset -= 1;
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+down"))) {
        if (scrollOffset < maxScroll) scrollOffset += 1;
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+home"))) {
        scrollOffset = 0;
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("shift+end"))) {
        scrollOffset = maxScroll;
        requestRender();
        return { consume: true };
      }

      return undefined;
    },
    close: () => close(true),
    requestRender,
  };
}
