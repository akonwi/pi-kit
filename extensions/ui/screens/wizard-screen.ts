import { truncateToWidth as tuiTruncateToWidth } from "@mariozechner/pi-tui";
import type { InteractionDockController, ScreenController } from "../shell";
import { WizardInputSurface, normalizeQuestion, type AnswerValue, type GuidedQuestionnaireInput } from "../input-surfaces/wizard-input";

export type WizardResult = {
  cancelled: boolean;
  answers: Record<string, AnswerValue>;
};

export type WizardScreenOptions = {
  ctx: any;
  params: GuidedQuestionnaireInput;
  dock: InteractionDockController;
  setRenderDelegate: (delegate: { render(width: number): string[] } | undefined) => void;
  onClosed?: () => void;
};

function ansiLen(text: string): number {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .length;
}

function fitLine(text: string, width: number): string {
  const truncated = tuiTruncateToWidth(text, width);
  const len = ansiLen(truncated);
  return len >= width ? truncated : `${truncated}${" ".repeat(width - len)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function openWizardScreen(options: WizardScreenOptions): {
  screen: ScreenController;
  result: Promise<WizardResult>;
} {
  const { ctx, params, dock } = options;

  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Guided questionnaire";
  const intro = typeof params.intro === "string" && params.intro.trim() ? params.intro.trim() : "";
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(normalizeQuestion);

  let resolveResult!: (result: WizardResult) => void;
  const resultPromise = new Promise<WizardResult>((resolve) => {
    resolveResult = resolve;
  });

  let closed = false;
  let screenOverlayTui: any = null;
  let closeScreenOverlay: (() => void) | undefined;
  let surface: WizardInputSurface | undefined;

  const requestRender = () => {
    screenOverlayTui?.requestRender?.();
    dock.refresh();
  };

  const close = (result: WizardResult) => {
    if (closed) return;
    closed = true;

    surface?.dispose();
    surface = undefined;
    options.setRenderDelegate(undefined);

    const overlayTui = screenOverlayTui;
    closeScreenOverlay?.();
    closeScreenOverlay = undefined;
    screenOverlayTui = null;

    ctx.ui.setStatus("wizard", undefined);
    dock.refresh();

    queueMicrotask(() => {
      overlayTui?.requestRender?.(true);
    });

    resolveResult(result);
    options.onClosed?.();
  };

  // Create the wizard input surface
  surface = new WizardInputSurface(questions, ctx.ui.theme, {
    onDone: (answers) => close({ cancelled: false, answers }),
    onCancel: (answers) => close({ cancelled: true, answers }),
    onNotify: (message, level) => ctx.ui.notify(message, level),
    requestRender,
  });

  // Mount dock render delegate
  const dockDelegate = {
    render(width: number): string[] {
      if (!surface) return [];
      return surface.renderDock(width);
    },
  };
  options.setRenderDelegate(dockDelegate);

  if (intro) {
    ctx.ui.notify(`${title}: ${intro}`, "info");
  }
  ctx.ui.setStatus(
    "wizard",
    ctx.ui.theme.fg("dim", "wizard: Tab/Enter next • Shift+Tab prev • Esc cancel"),
  );

  // Screen overlay for question context
  void ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: any, done: (result: void) => void) => {
      screenOverlayTui = tui;
      closeScreenOverlay = () => done(undefined);

      return {
        render(width: number): string[] {
          if (!surface) return [];

          const inside = Math.max(24, width - 2);
          const bc = (s: string) => theme.fg("borderAccent", s);
          const fit = (s: string) => fitLine(s, inside);
          const row = (content = "") => `${bc("│")}${fit(content)}${bc("│")}`;

          const metrics = dock.getMetrics();
          const termRows = process.stdout.rows || 40;
          const availableRows = Math.max(8, termRows - metrics.panelLines - 2);
          
          const q = surface.getQuestion();
          const prevAnswer = surface.getPreviousAnswerLabel();

          const content = [
            `${bc("╭")}${bc("─".repeat(inside))}${bc("╮")}`,
            row(theme.fg("accent", theme.bold(title))),
            row(
              `${theme.fg("dim", `Question ${surface.getQuestionIndex() + 1}/${surface.getQuestionCount()} • ${surface.getAnsweredCount()} answered`)}  ${surface.getProgressDots()}`,
            ),
            row(),
            row(theme.fg("text", theme.bold(q.label))),
          ];

          if (q.help) content.push(row(theme.fg("muted", q.help)));
          if (prevAnswer) content.push(row(theme.fg("dim", `Current: ${clip(prevAnswer, 80)}`)));
          
          // Fill remaining space with empty rows
          const usedRows = content.length + 2; // +2 for empty row and bottom border
          const emptyRows = Math.max(0, availableRows - usedRows);
          for (let i = 0; i < emptyRows; i++) {
            content.push(row());
          }
          
          content.push(row());
          content.push(`${bc("╰")}${bc("─".repeat(inside))}${bc("╯")}`);

          return content.slice(0, availableRows);
        },

        invalidate(): void {},
        dispose(): void {
          if (screenOverlayTui === tui) screenOverlayTui = null;
          closeScreenOverlay = undefined;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => {
        const metrics = dock.getMetrics();
        const termRows = process.stdout.rows || 40;
        const maxHeight = Math.max(6, termRows - metrics.panelLines - 2);
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

  const screen: ScreenController = {
    id: "wizard",

    activate(): void {
      dock.setState({
        surface: "wizard",
        mode: "wizard",
        supportsPicker: false,
      });
      dock.refresh();
    },

    deactivate(): void {},

    handleInput(data: string) {
      if (closed || !surface) return undefined;

      // Wizard captures ALL input
      surface.handleInput(data);
      return { consume: true };
    },

    close: () => close({ cancelled: true, answers: surface?.getAnswers() ?? {} }),
    requestRender,
  };

  return { screen, result: resultPromise };
}
