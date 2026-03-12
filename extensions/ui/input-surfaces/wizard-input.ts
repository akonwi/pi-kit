import { Input, Key, matchesKey, truncateToWidth as tuiTruncateToWidth } from "@mariozechner/pi-tui";

export type GuidedQuestion = {
  id: string;
  kind: "text" | "select" | "boolean";
  label: string;
  help?: string;
  placeholder?: string;
  required: boolean;
  options?: string[];
};

export type GuidedQuestionnaireInput = {
  title?: string;
  intro?: string;
  questions: GuidedQuestion[];
};

export type AnswerValue = string | boolean;

export type WizardSurfaceCallbacks = {
  onDone(answers: Record<string, AnswerValue>): void;
  onCancel(answers: Record<string, AnswerValue>): void;
  onNotify(message: string, level: "info" | "warning"): void;
  requestRender(): void;
};

export function normalizeQuestion(raw: any, index: number): GuidedQuestion {
  const kind =
    raw.kind === "select" || raw.kind === "boolean" || raw.kind === "text"
      ? raw.kind
      : "text";

  const id = String(raw.id || `q${index + 1}`).trim() || `q${index + 1}`;
  const label = String(raw.label || "").trim() || `Question ${index + 1}`;

  return {
    id,
    kind,
    label,
    help: typeof raw.help === "string" ? raw.help.trim() : undefined,
    placeholder: typeof raw.placeholder === "string" ? raw.placeholder : undefined,
    required: raw.required !== false,
    options: Array.isArray(raw.options)
      ? raw.options.map((s: unknown) => String(s || "").trim()).filter(Boolean).slice(0, 24)
      : undefined,
  };
}

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

export class WizardInputSurface {
  private index = 0;
  private selectIndex = 0;
  private mode: "select" | "text" | "otherText" = "select";
  private answers: Record<string, AnswerValue> = {};
  private input = new Input();

  constructor(
    private readonly questions: GuidedQuestion[],
    private readonly theme: any,
    private readonly callbacks: WizardSurfaceCallbacks,
  ) {
    this.input.focused = true;
    this.loadQuestionState();
  }

  // -- State queries for screen overlay --

  getQuestionIndex(): number {
    return this.index;
  }

  getQuestion(): GuidedQuestion {
    return this.questions[this.index]!;
  }

  getQuestionCount(): number {
    return this.questions.length;
  }

  getAnsweredCount(): number {
    return this.questions.filter((q) => {
      const v = this.answers[q.id];
      if (typeof v === "boolean") return true;
      return typeof v === "string" && v.trim().length > 0;
    }).length;
  }

  getAnswers(): Record<string, AnswerValue> {
    return { ...this.answers };
  }

  getPreviousAnswerLabel(): string {
    const v = this.answers[this.getQuestion().id];
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return typeof v === "string" && v.trim() ? v.trim() : "";
  }

  getProgressDots(): string {
    return this.questions
      .map((_, idx) => {
        if (idx === this.index) return this.theme.fg("accent", "●");
        return idx < this.index ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
      })
      .join(" ");
  }

  // -- Internal helpers --

  private isOtherOption(value: string): boolean {
    return /^other(\b|\s|:)/i.test(value);
  }

  private getSelectOptions(q: GuidedQuestion): string[] {
    if (q.kind === "boolean") {
      return q.required === false ? ["Yes", "No", "Skip"] : ["Yes", "No"];
    }
    if (q.kind === "select") {
      const provided = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
      return q.required === false ? [...provided, "Skip"] : provided;
    }
    return [];
  }

  private loadQuestionState(): void {
    const q = this.getQuestion();
    const existing = this.answers[q.id];

    if (q.kind === "text") {
      this.mode = "text";
      this.input.setValue(typeof existing === "string" ? existing : "");
      return;
    }

    if (q.kind === "boolean") {
      this.mode = "select";
      const opts = this.getSelectOptions(q);
      if (existing === true) this.selectIndex = opts.indexOf("Yes");
      else if (existing === false) this.selectIndex = opts.indexOf("No");
      else if (typeof existing === "string" && existing === "") this.selectIndex = Math.max(0, opts.indexOf("Skip"));
      else this.selectIndex = 0;
      if (this.selectIndex < 0) this.selectIndex = 0;
      return;
    }

    const opts = this.getSelectOptions(q);
    if (opts.length === 0) {
      this.mode = "text";
      this.input.setValue(typeof existing === "string" ? existing : "");
      return;
    }

    this.mode = "select";
    this.selectIndex = 0;
    if (typeof existing === "string") {
      const exactIdx = opts.indexOf(existing);
      if (exactIdx >= 0) {
        this.selectIndex = exactIdx;
        return;
      }
      const otherIdx = opts.findIndex((o) => this.isOtherOption(o));
      if (otherIdx >= 0 && existing.trim()) {
        this.mode = "otherText";
        this.selectIndex = otherIdx;
        this.input.setValue(existing);
        return;
      }
    }
  }

  private movePrevious(): void {
    if (this.mode === "otherText") {
      this.mode = "select";
      this.callbacks.requestRender();
      return;
    }
    if (this.index === 0) {
      this.callbacks.onNotify("Already at first question.", "info");
      return;
    }
    this.index -= 1;
    this.loadQuestionState();
    this.callbacks.requestRender();
  }

  private moveNext(): void {
    const q = this.getQuestion();

    if (q.kind === "text") {
      const value = this.input.getValue().trim();
      if (!value && q.required !== false) {
        this.callbacks.onNotify("This question is required.", "warning");
        return;
      }
      this.answers[q.id] = value;
      this.advance();
      return;
    }

    if (q.kind === "boolean") {
      const opts = this.getSelectOptions(q);
      const choice = opts[this.selectIndex];
      if (!choice) return;
      if (choice === "Skip") this.answers[q.id] = "";
      else this.answers[q.id] = choice === "Yes";
      this.advance();
      return;
    }

    const opts = this.getSelectOptions(q);
    if (opts.length === 0 || this.mode === "text") {
      const value = this.input.getValue().trim();
      if (!value && q.required !== false) {
        this.callbacks.onNotify("This question is required.", "warning");
        return;
      }
      this.answers[q.id] = value;
      this.advance();
      return;
    }

    if (this.mode === "otherText") {
      const value = this.input.getValue().trim();
      if (!value && q.required !== false) {
        this.callbacks.onNotify("Please provide your custom option.", "warning");
        return;
      }
      this.answers[q.id] = value || "Other";
      this.advance();
      return;
    }

    const choice = opts[this.selectIndex];
    if (!choice) return;

    if (choice === "Skip") {
      this.answers[q.id] = "";
      this.advance();
      return;
    }

    if (this.isOtherOption(choice)) {
      this.mode = "otherText";
      const existing = this.answers[q.id];
      this.input.setValue(typeof existing === "string" && opts.indexOf(existing) === -1 ? existing : "");
      this.callbacks.requestRender();
      return;
    }

    this.answers[q.id] = choice;
    this.advance();
  }

  private advance(): void {
    if (this.index >= this.questions.length - 1) {
      this.callbacks.onDone(this.answers);
      return;
    }
    this.index += 1;
    this.loadQuestionState();
    this.callbacks.requestRender();
  }

  // -- Input handling --

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onCancel(this.answers);
      return;
    }

    if (matchesKey(data, Key.shift("tab"))) {
      this.movePrevious();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.moveNext();
      return;
    }

    const q = this.getQuestion();
    const isTextMode = q.kind === "text" || this.mode === "text" || this.mode === "otherText";

    if (isTextMode) {
      if (matchesKey(data, Key.enter)) {
        this.moveNext();
        return;
      }
      this.input.handleInput(data);
      this.callbacks.requestRender();
      return;
    }

    const opts = this.getSelectOptions(q);
    if (matchesKey(data, Key.up)) {
      if (opts.length > 0) this.selectIndex = Math.max(0, this.selectIndex - 1);
      this.callbacks.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (opts.length > 0) this.selectIndex = Math.min(opts.length - 1, this.selectIndex + 1);
      this.callbacks.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.moveNext();
    }
  }

  // -- Dock rendering (complete panel with borders) --

  renderDock(width: number): string[] {
    const margin = 0;
    const panelWidth = Math.max(24, width);
    const inside = Math.max(10, panelWidth - 2);

    const bc = (s: string) => this.theme.fg("borderAccent", s);
    const fit = (s: string) => fitLine(s, inside);
    const row = (content = "") => `${bc("│")}${fit(content)}${bc("│")}`;

    const q = this.getQuestion();
    const isTextMode = q.kind === "text" || this.mode === "text" || this.mode === "otherText";
    const lines: string[] = [];

    lines.push(`${bc("╭")}${bc("─".repeat(inside))}${bc("╮")}`);

    if (isTextMode) {
      const prompt =
        this.mode === "otherText"
          ? this.theme.fg("accent", "Specify Other")
          : this.theme.fg("dim", "Answer");
      lines.push(row(`${prompt}${this.theme.fg("dim", ":")}`));
      for (const line of this.input.render(Math.max(10, inside - 2))) {
        lines.push(row(` ${line}`));
      }
    } else {
      const opts = this.getSelectOptions(q);
      for (let i = 0; i < opts.length; i++) {
        const selected = i === this.selectIndex;
        const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
        const text = selected ? this.theme.fg("accent", opts[i]!) : opts[i]!;
        lines.push(row(`${prefix}${text}`));
      }
    }

    lines.push(row());
    lines.push(row(this.theme.fg("dim", "↑/↓ move • Enter/Tab next • Shift+Tab prev • Esc cancel")));
    lines.push(`${bc("╰")}${bc("─".repeat(inside))}${bc("╯")}`);

    return lines;
  }

  dispose(): void {
    this.input.invalidate();
  }
}
