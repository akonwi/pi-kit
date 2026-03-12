export const UI_LAYER_KEYS = {
  picker: "interaction-dock:picker",
  pager: "screen:pager",
} as const;

export const UI_EVENT_KEYS = {
  dockRefresh: "interaction-dock:refresh",
  dockStateChanged: "interaction-dock:state-changed",
  dockMetricsChanged: "interaction-dock:metrics-changed",
} as const;

export type UiLayerKey = (typeof UI_LAYER_KEYS)[keyof typeof UI_LAYER_KEYS] | string;
export type InputRouteResult = { consume?: boolean; data?: string } | undefined;

export class UiLayerStack {
  private readonly stack: string[] = [];

  setOpen(key: UiLayerKey, open: boolean): void {
    const normalized = String(key || "").trim();
    if (!normalized) return;

    const idx = this.stack.indexOf(normalized);
    if (open) {
      if (idx >= 0) this.stack.splice(idx, 1);
      this.stack.push(normalized);
      return;
    }

    if (idx >= 0) this.stack.splice(idx, 1);
  }

  isTop(key: UiLayerKey): boolean {
    const normalized = String(key || "").trim();
    return this.stack.length === 0 || this.stack[this.stack.length - 1] === normalized;
  }

  top(): string | undefined {
    return this.stack[this.stack.length - 1];
  }

  clear(): void {
    this.stack.length = 0;
  }
}

export type InputSurfaceKind = "text-composer" | "wizard" | "hidden";
export type ScreenKind = "thread" | "pager" | "wizard";

export type DockState = {
  surface: InputSurfaceKind;
  mode: ScreenKind | string;
  supportsPicker: boolean;
};

export type DockMetrics = {
  margin: number;
  panelWidth: number;
  panelLines: number;
};

export interface ScreenController {
  id: ScreenKind | string;
  activate?(): void;
  deactivate?(): void;
  handleInput?(data: string): InputRouteResult;
  close(): void;
  requestRender(): void;
}

export class ScreenManager {
  private active: ScreenController | null = null;

  activate(screen: ScreenController): void {
    if (this.active === screen) {
      screen.activate?.();
      return;
    }

    if (this.active) {
      this.active.deactivate?.();
      this.active.close();
    }

    this.active = screen;
    screen.activate?.();
  }

  closeActive(): void {
    if (!this.active) return;
    const current = this.active;
    this.active = null;
    current.deactivate?.();
    current.close();
  }

  requestRender(): void {
    this.active?.requestRender();
  }

  handleInput(data: string): InputRouteResult {
    return this.active?.handleInput?.(data);
  }

  getActive(): ScreenController | null {
    return this.active;
  }

  clearIfActive(screen: ScreenController): void {
    if (this.active === screen) {
      this.active = null;
    }
  }
}

export class InteractionDockController {
  private state: DockState = {
    surface: "text-composer",
    mode: "thread",
    supportsPicker: true,
  };
  private metrics: DockMetrics = {
    margin: 0,
    panelWidth: 80,
    panelLines: 5,
  };
  private inputHandler?: (data: string) => InputRouteResult;
  private screenInputBlocker?: () => boolean;
  private onRefresh?: () => void;
  private onStateChange?: (state: DockState) => void;
  private onMetricsChange?: (metrics: DockMetrics) => void;

  constructor(
    onRefresh?: () => void,
    onStateChange?: (state: DockState) => void,
    onMetricsChange?: (metrics: DockMetrics) => void,
  ) {
    this.onRefresh = onRefresh;
    this.onStateChange = onStateChange;
    this.onMetricsChange = onMetricsChange;
  }

  configure(options: {
    onRefresh?: () => void;
    onStateChange?: (state: DockState) => void;
    onMetricsChange?: (metrics: DockMetrics) => void;
  }): void {
    this.onRefresh = options.onRefresh;
    this.onStateChange = options.onStateChange;
    this.onMetricsChange = options.onMetricsChange;
  }

  setState(next: DockState): void {
    const changed =
      this.state.surface !== next.surface ||
      this.state.mode !== next.mode ||
      this.state.supportsPicker !== next.supportsPicker;

    this.state = next;
    if (changed) {
      this.onStateChange?.(this.state);
    }
    this.refresh();
  }

  setSurface(surface: InputSurfaceKind): void {
    this.setState({
      ...this.state,
      surface,
    });
  }

  getSurface(): InputSurfaceKind {
    return this.state.surface;
  }

  getState(): DockState {
    return this.state;
  }

  setMetrics(next: DockMetrics): void {
    const changed =
      this.metrics.margin !== next.margin ||
      this.metrics.panelWidth !== next.panelWidth ||
      this.metrics.panelLines !== next.panelLines;

    this.metrics = next;
    if (changed) {
      this.onMetricsChange?.(this.metrics);
      this.refresh();
    }
  }

  getMetrics(): DockMetrics {
    return this.metrics;
  }

  setInputHandler(handler: ((data: string) => InputRouteResult) | undefined): void {
    this.inputHandler = handler;
  }

  setScreenInputBlocker(blocker: (() => boolean) | undefined): void {
    this.screenInputBlocker = blocker;
  }

  blocksScreenInput(): boolean {
    return Boolean(this.screenInputBlocker?.());
  }

  handleInput(data: string): InputRouteResult {
    return this.inputHandler?.(data);
  }

  refresh(): void {
    this.onRefresh?.();
  }
}

export const sharedUiLayerStack = new UiLayerStack();
export const sharedScreenManager = new ScreenManager();
export const sharedInteractionDock = new InteractionDockController();
