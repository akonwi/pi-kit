import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { InteractionDockController, ScreenController } from "../shell";

export type TextInputScreenOptions = {
  ctx: any;
  dock: InteractionDockController;
  title: string;
  initialValue?: string;
  placeholder?: string;
  onClosed?: () => void;
};

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function fitToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length >= width) return plain.slice(0, width);
  return plain + " ".repeat(width - plain.length);
}

export function openTextInputScreen(options: TextInputScreenOptions): {
  screen: ScreenController;
  result: Promise<string | undefined>;
} {
  const { ctx, dock } = options;
  const previousEditorText = ctx.ui.getEditorText();
  let value = options.initialValue || "";
  let closed = false;
  let overlayTui: any = null;
  let closeOverlay: (() => void) | undefined;

  let resolveResult!: (value: string | undefined) => void;
  const result = new Promise<string | undefined>((resolve) => {
    resolveResult = resolve;
  });

  const syncEditor = () => {
    ctx.ui.setEditorText(value);
  };

  const requestRender = () => {
    overlayTui?.requestRender?.();
    dock.refresh();
  };

  const close = (nextValue: string | undefined, restoreEditor = true) => {
    if (closed) return;
    closed = true;

    if (restoreEditor) {
      ctx.ui.setEditorText(previousEditorText);
    }

    const tuiForClose = overlayTui;
    closeOverlay?.();
    closeOverlay = undefined;
    overlayTui = null;
    ctx.ui.setStatus("picker", undefined);
    dock.refresh();

    queueMicrotask(() => {
      tuiForClose?.requestRender?.(true);
    });

    resolveResult(nextValue);
    options.onClosed?.();
  };

  syncEditor();
  ctx.ui.setStatus(
    "picker",
    ctx.ui.theme.fg("dim", `${options.title}: type name • Enter save • Esc cancel`),
  );

  void ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: any, done: (value: void) => void) => {
      overlayTui = tui;
      closeOverlay = () => done(undefined);

      return {
        render(_width: number): string[] {
          const metrics = dock.getMetrics();
          const width = metrics.panelWidth;
          const inside = Math.max(12, width - 2);
          const termRows = process.stdout.rows || 40;
          const availableRows = termRows - 2 - metrics.panelLines;
          if (availableRows < 4) return [];

          const border = (text: string) => theme?.fg ? theme.fg("borderMuted", text) : text;
          const text = (text: string) => theme?.fg ? theme.fg("text", text) : text;
          const dim = (text: string) => theme?.fg ? theme.fg("dim", text) : text;
          const selectedBg = (text: string) => theme?.bg ? theme.bg("selectedBg", text) : `\x1b[7m${text}\x1b[27m`;
          const selectedFg = (text: string) => theme?.fg ? theme.fg("pickerFocusedText", text) : text;
          const row = (content = "") => `${border("│")}${content}${border("│")}`;

          const display = value || options.placeholder || "";
          const paintedInput = selectedBg(selectedFg(fitToWidth(display, inside)));
          const title = fitToWidth(text(options.title), inside);
          const hint = fitToWidth(value ? dim("Press Enter to save") : dim(options.placeholder || "Type a value"), inside);

          return [
            border(`┌${"─".repeat(inside)}┐`),
            row(title),
            row(paintedInput),
            row(hint),
            border(`└${"─".repeat(inside)}┘`),
          ].slice(0, availableRows);
        },
        invalidate(): void {},
        dispose(): void {
          if (overlayTui === tui) overlayTui = null;
          closeOverlay = undefined;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => {
        const metrics = dock.getMetrics();
        const termRows = process.stdout.rows || 40;
        const overlayHeight = 4;
        return {
          row: Math.max(0, termRows - 2 - metrics.panelLines - overlayHeight),
          col: metrics.margin,
          width: metrics.panelWidth,
          maxHeight: overlayHeight,
          nonCapturing: true,
        };
      },
    },
  );

  requestRender();

  const screen: ScreenController = {
    id: "text-input",
    activate(): void {
      dock.setState({
        surface: "text-composer",
        mode: "text-input",
        supportsPicker: false,
      });
      dock.refresh();
      requestRender();
    },
    deactivate(): void {},
    handleInput(data: string) {
      if (closed) return undefined;

      if (matchesKey(data, Key.escape)) {
        close(undefined, true);
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        close(value, true);
        return { consume: true };
      }
      if (data === "\x7f") {
        value = value.slice(0, -1);
        syncEditor();
        requestRender();
        return { consume: true };
      }
      if (/^[\x20-\x7E]$/.test(data)) {
        value += data;
        syncEditor();
        requestRender();
        return { consume: true };
      }

      return { consume: true };
    },
    close: () => close(undefined, true),
    requestRender,
  };

  return { screen, result };
}
