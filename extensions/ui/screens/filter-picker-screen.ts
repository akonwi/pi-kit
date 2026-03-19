import { Key, matchesKey } from "@mariozechner/pi-tui";
import { scoreMatch } from "../../indexing/score";
import { renderPickerBox, type PickerOverlayItem, type PickerOverlayState } from "../picker-overlay";
import type { InteractionDockController, ScreenController } from "../shell";

export type FilterPickerOption<T> = PickerOverlayItem & {
  value: T;
  searchText?: string;
};

export type FilterPickerScreenOptions<T> = {
  ctx: any;
  dock: InteractionDockController;
  title: string;
  items: FilterPickerOption<T>[];
  initialQuery?: string;
  visibleItems?: number;
  onClosed?: () => void;
};

export function openFilterPickerScreen<T>(options: FilterPickerScreenOptions<T>): {
  screen: ScreenController;
  result: Promise<T | undefined>;
} {
  const { ctx, dock } = options;
  const previousEditorText = ctx.ui.getEditorText();
  let query = (options.initialQuery || "").trim();
  let selected = 0;
  let closed = false;
  let overlayTui: any = null;
  let closeOverlay: (() => void) | undefined;

  let resolveResult!: (value: T | undefined) => void;
  const result = new Promise<T | undefined>((resolve) => {
    resolveResult = resolve;
  });

  const visibleItems = Math.max(1, options.visibleItems ?? 8);

  const getFiltered = () => {
    const normalizedQuery = query.trim().toLowerCase();
    return options.items
      .map((item, index) => {
        const haystack = item.searchText || `${item.label} ${item.description || ""}`;
        const score = normalizedQuery ? scoreMatch(haystack, normalizedQuery) : 1;
        return { item, index, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (!normalizedQuery) return a.index - b.index;
        return b.score - a.score || a.index - b.index;
      });
  };

  const syncEditor = () => {
    ctx.ui.setEditorText(query);
  };

  const requestRender = () => {
    overlayTui?.requestRender?.();
    dock.refresh();
  };

  const clampSelected = () => {
    const filtered = getFiltered();
    if (filtered.length === 0) {
      selected = 0;
      return filtered;
    }
    selected = Math.max(0, Math.min(selected, filtered.length - 1));
    return filtered;
  };

  const close = (value: T | undefined, restoreEditor = true) => {
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

    resolveResult(value);
    options.onClosed?.();
  };

  syncEditor();
  ctx.ui.setStatus(
    "picker",
    ctx.ui.theme.fg("dim", `${options.title}: type to filter • ↑/↓ move • Enter select • Esc cancel`),
  );

  void ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: any, done: (value: void) => void) => {
      overlayTui = tui;
      closeOverlay = () => done(undefined);

      return {
        render(_width: number): string[] {
          const filtered = clampSelected();
          const metrics = dock.getMetrics();
          const termRows = process.stdout.rows || 40;
          const availableRows = termRows - 2 - metrics.panelLines;
          if (availableRows < 3 || filtered.length === 0) return [];

          const state: PickerOverlayState = {
            items: filtered.map((entry) => ({
              label: entry.item.label,
              value: String(entry.index),
              description: entry.item.description,
            })),
            selected,
            visibleItems: Math.max(1, Math.min(visibleItems, filtered.length, availableRows - 2)),
          };

          return renderPickerBox(theme, state, metrics.panelWidth);
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
        const filtered = clampSelected();
        const availableRows = termRows - 2 - metrics.panelLines;
        const overlayHeight = Math.max(3, Math.min(filtered.length, visibleItems, Math.max(1, availableRows - 2)) + 2);
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
    id: "filter-picker",
    activate(): void {
      dock.setState({
        surface: "text-composer",
        mode: "filter-picker",
        supportsPicker: false,
      });
      dock.refresh();
      requestRender();
    },
    deactivate(): void {},
    handleInput(data: string) {
      if (closed) return undefined;

      const filtered = clampSelected();
      if (matchesKey(data, Key.escape)) {
        close(undefined, true);
        return { consume: true };
      }
      if (matchesKey(data, Key.up)) {
        if (filtered.length > 0) selected = Math.max(0, selected - 1);
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.down)) {
        if (filtered.length > 0) selected = Math.min(filtered.length - 1, selected + 1);
        requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
        const chosen = filtered[selected]?.item;
        close(chosen?.value, true);
        return { consume: true };
      }
      if (data === "\x7f") {
        query = query.slice(0, -1);
        selected = 0;
        syncEditor();
        requestRender();
        return { consume: true };
      }
      if (/^[\x20-\x7E]$/.test(data)) {
        query += data;
        selected = 0;
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
