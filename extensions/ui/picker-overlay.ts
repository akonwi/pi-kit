import { Key, matchesKey } from "@mariozechner/pi-tui";

type PickerOverlayItem = {
  label: string;
  value: string;
};

export type PickerOverlayState = {
  items: PickerOverlayItem[];
  selected: number;
  visibleItems: number;
};

export type PickerOverlayCallbacks = {
  onUp(): void;
  onDown(): void;
  onTab(): void;
  onEnter(): void;
  onEscape(): void;
  onPassthrough(data: string): void;
};

export type PickerOverlayLayout = {
  row: number;
  col: number;
  width: number;
  maxHeight?: number;
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

class PickerOverlayComponent {
  private state: PickerOverlayState | undefined;

  constructor(
    private readonly theme: any,
    private readonly callbacks: PickerOverlayCallbacks,
    state?: PickerOverlayState,
  ) {
    this.state = state;
  }

  setState(next: PickerOverlayState | undefined): void {
    this.state = next;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.callbacks.onUp();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.callbacks.onDown();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.callbacks.onTab();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.callbacks.onEnter();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onEscape();
      return;
    }

    this.callbacks.onPassthrough(data);
  }

  render(width: number): string[] {
    const state = this.state;
    if (!state || state.items.length === 0) return [];

    const inside = Math.max(8, width - 2);
    const border = (text: string) => this.theme?.fg ? this.theme.fg("borderAccent", text) : text;
    const selectedBg = (text: string) => this.theme?.bg ? this.theme.bg("selectedBg", text) : `\x1b[7m${text}\x1b[27m`;
    const selectedFg = (text: string) => this.theme?.fg ? this.theme.fg("accent", text) : text;

    const visibleItems = Math.max(1, Math.min(state.visibleItems, state.items.length));
    const preferredStart = state.selected - Math.floor(visibleItems / 2);
    const start = Math.max(0, Math.min(preferredStart, state.items.length - visibleItems));
    const end = Math.min(state.items.length, start + visibleItems);

    const lines = [border(`╭${"─".repeat(inside)}╮`)];

    for (let index = start; index < end; index++) {
      const item = state.items[index]!;
      const selected = index === state.selected;
      const marker = selected ? selectedFg("› ") : "  ";
      const text = fitToWidth(`${marker}${item.label}`, inside);
      lines.push(`${border("│")}${selected ? selectedBg(text) : text}${border("│")}`);
    }

    lines.push(border(`╰${"─".repeat(inside)}╯`));
    return lines;
  }

  invalidate(): void {}
}

export class AnchoredPickerOverlayController {
  private handle: any;
  private component: PickerOverlayComponent | undefined;
  private open = false;
  private layoutKey = "";

  constructor(
    private readonly tui: any,
    private readonly theme: any,
    private readonly callbacks: PickerOverlayCallbacks,
    private readonly onVisibilityChange?: (open: boolean) => void,
  ) {}

  sync(state: PickerOverlayState | undefined, layout: PickerOverlayLayout | undefined): void {
    if (!state || state.items.length === 0 || !layout) {
      this.hide();
      return;
    }

    const layoutKey = JSON.stringify(layout);
    if (!this.handle || !this.component || this.layoutKey !== layoutKey) {
      this.replaceOverlay(state, layout, layoutKey);
      return;
    }

    this.component.setState(state);
  }

  hide(): void {
    if (this.handle) {
      this.handle.hide();
      this.handle = undefined;
      this.component = undefined;
      this.layoutKey = "";
    }

    if (this.open) {
      this.open = false;
      this.onVisibilityChange?.(false);
    }
  }

  dispose(): void {
    this.hide();
  }

  private replaceOverlay(state: PickerOverlayState, layout: PickerOverlayLayout, layoutKey: string): void {
    if (this.handle) {
      this.handle.hide();
      this.handle = undefined;
      this.component = undefined;
    }

    const component = new PickerOverlayComponent(this.theme, this.callbacks, state);
    this.component = component;
    this.handle = this.tui.showOverlay(component, {
      row: layout.row,
      col: layout.col,
      width: layout.width,
      maxHeight: layout.maxHeight,
      nonCapturing: true,
    });
    this.layoutKey = layoutKey;

    if (!this.open) {
      this.open = true;
      this.onVisibilityChange?.(true);
    }
  }
}
