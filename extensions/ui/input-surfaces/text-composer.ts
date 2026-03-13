import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { AnchoredPickerOverlayController, type PickerOverlayState } from "../picker-overlay";
import type { DockMetrics, DockState } from "../shell";

export type TextComposerPickerKind = "slash" | "file" | "bash" | "thread";

export type TextComposerPickerItem = {
  label: string;
  value: string;
};

export type TextComposerSuggestionProviders = {
  getSlashSuggestions(query: string): string[];
  getFileSuggestions(query: string): string[];
  getThreadSuggestions(query: string): TextComposerPickerItem[];
  getBashSuggestions(query: string): string[];
};

export type TextComposerSurfaceOptions = {
  pickerMaxItems?: number;
  dockFooterRows?: number;
  panelMargin?: (width: number) => number;
  getTransientBadge?: () => string | undefined;
  onThreadInserted?: () => void;
  onPickerVisibilityChange?: (open: boolean) => void;
  onLayoutChange?: (metrics: DockMetrics) => void;
};

type PickerState = {
  kind: TextComposerPickerKind;
  prefix: string;
  items: TextComposerPickerItem[];
  selected: number;
};

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x90-\x9f][\s\S]*?\x9c/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/pi:c(?:ursor)?/gi, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function fitToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length >= width) return plain.slice(0, width);
  return plain + " ".repeat(width - plain.length);
}

function wrapPlainText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const source = stripAnsi(text);
  if (source.length === 0) return [""];

  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    out.push(source.slice(i, i + width));
    i += width;
  }
  return out;
}

function paintCursorBlock(text: string, width: number, cursorCol: number): string {
  const fitted = fitToWidth(text, width);
  const idx = Math.max(0, Math.min(width - 1, cursorCol));
  const ch = fitted[idx] || " ";
  return `${fitted.slice(0, idx)}\x1b[7m${ch}\x1b[27m${fitted.slice(idx + 1)}`;
}

export class TextComposerSurface extends CustomEditor {
  private suppressDetection = false;
  private picker: PickerState | undefined;
  private lastPanelLayout: { margin: number; panelWidth: number; panelLines: number } | undefined;
  private lastReportedLayoutKey: string | undefined;
  private readonly pickerOverlay: AnchoredPickerOverlayController;
  private readonly pickerMaxItems: number;
  private readonly dockFooterRows: number;
  private readonly panelMargin: (width: number) => number;
  private readonly getTransientBadge: () => string | undefined;
  private readonly onThreadInserted: () => void;
  private readonly onLayoutChange: (metrics: DockMetrics) => void;
  private renderDelegate?: { render(width: number): string[] };
  private dockState: DockState = {
    surface: "text-composer",
    mode: "thread",
    supportsPicker: true,
  };

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    private readonly providers: TextComposerSuggestionProviders,
    options: TextComposerSurfaceOptions = {},
  ) {
    super(tui, theme, keybindings);
    this.pickerOverlay = new AnchoredPickerOverlayController(
      tui,
      theme,
      {
        onUp: () => {
          if (!this.picker) return;
          this.picker.selected = Math.max(0, this.picker.selected - 1);
          this.syncPickerOverlay();
          this.tui.requestRender();
        },
        onDown: () => {
          if (!this.picker) return;
          this.picker.selected = Math.min(this.picker.items.length - 1, this.picker.selected + 1);
          this.syncPickerOverlay();
          this.tui.requestRender();
        },
        onTab: () => {
          this.applyPickerSelection({ submitAfter: false });
          this.tui.requestRender();
        },
        onEnter: () => {
          this.applyPickerSelection({ submitAfter: this.picker?.kind === "slash" || this.picker?.kind === "bash" });
          this.tui.requestRender();
        },
        onEscape: () => {
          this.setPicker(undefined);
          this.tui.requestRender();
        },
        onPassthrough: (data: string) => {
          this.passThroughWhilePickerOpen(data);
        },
      },
      options.onPickerVisibilityChange,
    );
    this.pickerMaxItems = options.pickerMaxItems ?? 8;
    this.dockFooterRows = options.dockFooterRows ?? 2;
    this.panelMargin = options.panelMargin ?? (() => 0);
    this.getTransientBadge = options.getTransientBadge ?? (() => undefined);
    this.onThreadInserted = options.onThreadInserted ?? (() => {});
    this.onLayoutChange = options.onLayoutChange ?? (() => {});
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.pickerOverlay.dispose();
  }

  setRenderDelegate(delegate: { render(width: number): string[] } | undefined): void {
    this.renderDelegate = delegate;
    if (delegate) {
      this.setPicker(undefined);
    }
    this.tui.requestRender();
  }

  setDockState(next: DockState): void {
    this.dockState = next;
    if (!this.canUsePicker()) {
      this.setPicker(undefined);
    }
    this.tui.requestRender();
  }

  getDockState(): DockState {
    return this.dockState;
  }

  hasOpenPicker(): boolean {
    return Boolean(this.picker && this.picker.items.length > 0);
  }

  shouldCapturePickerKey(data: string): boolean {
    if (!this.canUsePicker() || !this.hasOpenPicker()) return false;
    return (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape)
    );
  }

  private canUsePicker(): boolean {
    return this.dockState.surface === "text-composer" && this.dockState.supportsPicker;
  }

  private getPickerOverlayState(): PickerOverlayState | undefined {
    if (!this.picker || this.picker.items.length === 0) return undefined;
    return {
      items: this.picker.items,
      selected: this.picker.selected,
      visibleItems: this.pickerMaxItems,
    };
  }

  private syncPickerOverlay(): void {
    const state = this.getPickerOverlayState();
    if (!state) {
      this.pickerOverlay.hide();
      return;
    }

    const layout = this.lastPanelLayout;
    if (!layout) return;

    const overlayHeight = Math.min(state.items.length, state.visibleItems) + 2;
    const termRows = process.stdout.rows || 40;
    const row = Math.max(0, termRows - this.dockFooterRows - layout.panelLines - overlayHeight);

    this.pickerOverlay.sync(state, {
      row,
      col: layout.margin,
      width: layout.panelWidth,
      maxHeight: overlayHeight,
    });
  }

  private setPicker(next: PickerState | undefined): void {
    this.picker = next;
    this.syncPickerOverlay();
  }

  private cursorOffset(): number {
    const cursor = this.getCursor();
    const lines = this.getLines();
    let offset = 0;
    for (let i = 0; i < cursor.line; i++) {
      offset += (lines[i] || "").length + 1;
    }
    return offset + cursor.col;
  }

  private updatePickerState(): void {
    if (!this.canUsePicker()) {
      this.setPicker(undefined);
      return;
    }

    const beforeCursor = this.getText().slice(0, this.cursorOffset());

    const slashMatch = beforeCursor.match(/(?:^|\s)(\/[\w:-]*)$/);
    if (slashMatch) {
      const prefix = slashMatch[1] || "/";
      const query = prefix.slice(1);
      const items = this.providers.getSlashSuggestions(query)
        .map((value) => ({ label: value, value }));
      this.setPicker(items.length > 0 ? { kind: "slash", prefix, items, selected: 0 } : undefined);
      return;
    }

    const threadMatch = beforeCursor.match(/(?:^|\s)(@@[\w.-]*)$/);
    if (threadMatch) {
      const prefix = threadMatch[1] || "@@";
      const query = prefix.slice(2);
      const items = this.providers.getThreadSuggestions(query);
      this.setPicker(items.length > 0 ? { kind: "thread", prefix, items, selected: 0 } : undefined);
      return;
    }

    const fileMatch = beforeCursor.match(/(?:^|\s)(@[^@\s]*)$/);
    if (fileMatch) {
      const prefix = fileMatch[1] || "@";
      const query = prefix.slice(1);
      const items = this.providers.getFileSuggestions(query)
        .map((value) => ({ label: value, value }));
      this.setPicker(items.length > 0 ? { kind: "file", prefix, items, selected: 0 } : undefined);
      return;
    }

    const bashMatch = beforeCursor.match(/(?:^|\s)(!(?!\!)[^\s]*)$/);
    if (bashMatch) {
      const prefix = bashMatch[1] || "!";
      const query = prefix.slice(1);
      const items = this.providers.getBashSuggestions(query)
        .map((value) => ({ label: `!${value}`, value }));
      this.setPicker(items.length > 0 ? { kind: "bash", prefix, items, selected: 0 } : undefined);
      return;
    }

    this.setPicker(undefined);
  }

  private replaceTypedPrefix(prefix: string, replacement: string): void {
    this.suppressDetection = true;
    for (let i = 0; i < prefix.length; i++) {
      super.handleInput("\x7f");
    }
    this.insertTextAtCursor(replacement);
    this.suppressDetection = false;
  }

  private passThroughWhilePickerOpen(data: string): void {
    this.setPicker(undefined);
    super.handleInput(data);
    if (!this.suppressDetection) {
      this.updatePickerState();
    }
    this.tui.requestRender();
  }

  private applyPickerSelection(options?: { submitAfter?: boolean }): void {
    if (!this.picker) return;
    const picker = this.picker;
    const item = picker.items[picker.selected];
    if (!item) return;

    if (picker.kind === "thread") {
      this.replaceTypedPrefix(picker.prefix, `[[thread:${item.value}]] `);
      this.onThreadInserted();
      this.setPicker(undefined);
      return;
    }

    if (picker.kind === "slash") {
      this.replaceTypedPrefix(picker.prefix, item.value);
      this.setPicker(undefined);
      if (options?.submitAfter) {
        super.handleInput("\r");
      }
      return;
    }

    if (picker.kind === "bash") {
      const suffix = options?.submitAfter ? "" : " ";
      this.replaceTypedPrefix(picker.prefix, `!${item.value}${suffix}`);
      this.setPicker(undefined);
      if (options?.submitAfter) {
        super.handleInput("\r");
      }
      return;
    }

    this.replaceTypedPrefix(picker.prefix, `${item.value} `);
    this.setPicker(undefined);
  }

  override render(width: number): string[] {
    if (this.renderDelegate) {
      const margin = this.panelMargin(width);
      const panelWidth = Math.max(24, width - margin * 2);
      const delegateLines = this.renderDelegate.render(panelWidth);
      const pad = " ".repeat(margin);
      const padded = delegateLines.map((line) => `${pad}${line}${pad}`);
      this.lastPanelLayout = { margin, panelWidth, panelLines: padded.length };
      const layoutKey = JSON.stringify(this.lastPanelLayout);
      if (this.lastReportedLayoutKey !== layoutKey) {
        this.lastReportedLayoutKey = layoutKey;
        this.onLayoutChange(this.lastPanelLayout);
      }
      this.pickerOverlay.hide();
      return padded;
    }

    const margin = this.panelMargin(width);
    const panelWidth = Math.max(24, width - margin * 2);
    const panelInside = Math.max(10, panelWidth - 2);

    const logicalLines = this.getLines();
    const cursor = this.getCursor();

    const interior: string[] = [];
    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i] || "";
      const wrapped = wrapPlainText(line, panelInside);

      let cursorChunkIndex = -1;
      let cursorColInChunk = 0;
      if (this.focused && i === cursor.line) {
        const safeCol = Math.max(0, cursor.col);
        cursorChunkIndex = Math.floor(safeCol / panelInside);
        if (cursorChunkIndex >= wrapped.length) cursorChunkIndex = wrapped.length - 1;
        if (cursorChunkIndex < 0) cursorChunkIndex = 0;
        cursorColInChunk = safeCol - cursorChunkIndex * panelInside;
      }

      for (let chunkIndex = 0; chunkIndex < wrapped.length; chunkIndex++) {
        const chunk = wrapped[chunkIndex] || "";
        if (this.focused && i === cursor.line && chunkIndex === cursorChunkIndex) {
          interior.push(`│${paintCursorBlock(chunk, panelInside, cursorColInChunk)}│`);
        } else {
          interior.push(`│${fitToWidth(chunk, panelInside)}│`);
        }
      }
    }

    while (interior.length < 3) {
      interior.push(`│${" ".repeat(panelInside)}│`);
    }

    const top = `╭${"─".repeat(panelInside)}╮`;
    const badge = this.getTransientBadge();
    const badgeLabel = badge ? ` ${badge} ` : "";
    let bottomInside = "─".repeat(panelInside);
    if (badgeLabel && badgeLabel.length < panelInside) {
      bottomInside = "─".repeat(panelInside - badgeLabel.length) + badgeLabel;
    }
    const bottom = `╰${bottomInside}╯`;

    const pad = " ".repeat(margin);
    const panelLines = [top, ...interior, bottom].map((line) => `${pad}${line}${pad}`);

    this.lastPanelLayout = {
      margin,
      panelWidth,
      panelLines: panelLines.length,
    };
    const layoutKey = JSON.stringify(this.lastPanelLayout);
    if (this.lastReportedLayoutKey !== layoutKey) {
      this.lastReportedLayoutKey = layoutKey;
      this.onLayoutChange(this.lastPanelLayout);
    }
    this.syncPickerOverlay();

    return panelLines;
  }

  override handleInput(data: string): void {
    if (this.picker) {
      if (matchesKey(data, Key.up)) {
        this.picker.selected = Math.max(0, this.picker.selected - 1);
        this.syncPickerOverlay();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.picker.selected = Math.min(this.picker.items.length - 1, this.picker.selected + 1);
        this.syncPickerOverlay();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        this.applyPickerSelection({ submitAfter: false });
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.applyPickerSelection({ submitAfter: this.picker.kind === "slash" || this.picker.kind === "bash" });
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.setPicker(undefined);
        this.tui.requestRender();
        return;
      }

      this.setPicker(undefined);
    }

    super.handleInput(data);

    if (!this.suppressDetection) {
      this.updatePickerState();
    }
    this.tui.requestRender();
  }
}
