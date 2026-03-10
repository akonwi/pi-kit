import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Input, Key, Markdown, matchesKey, truncateToWidth as tuiTruncateToWidth } from "@mariozechner/pi-tui";

type KitConfig = {
  bells: {
    enabled: boolean;
    errorSound: "Funk";
  };
  speech: {
    enabled: boolean;
    maxChars: number;
    voice: string | null;
  };
  handoff: {
    maxMessages: number;
    maxSummaryChars: number;
  };
};

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "kit.json");
const FUNK_SOUND_PATH = "/System/Library/Sounds/Funk.aiff";

const DEFAULT_CONFIG: KitConfig = {
  bells: {
    enabled: true,
    errorSound: "Funk",
  },
  speech: {
    enabled: true,
    maxChars: 220,
    voice: null,
  },
  handoff: {
    maxMessages: 20,
    maxSummaryChars: 1400,
  },
};

const lastSpokenBySession = new Map<string, string>();
const lastAutoTitleAttemptBySession = new Map<string, number>();
const AUTO_TITLE_COOLDOWN_MS = 4 * 60 * 1000;
const AUTO_TITLE_MIN_USER_MESSAGES = 2;
const AUTO_TITLE_DISABLED = process.env.PI_KIT_NO_AUTO_TITLE === "1";
const LONGFORM_MIN_CHARS = 900;
const LONGFORM_MAX_SECTIONS = 12;
const LONGFORM_SECTION_MAX_CHARS = 1200;
const LONGFORM_WIDGET_MAX_LINES = 16;

type LongFormSection = {
  title: string;
  body: string;
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function asOptionalString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value : fallback;
}

function sanitizeConfig(input: unknown): KitConfig {
  const raw = isRecord(input) ? input : {};
  const bells = isRecord(raw.bells) ? raw.bells : {};
  const speech = isRecord(raw.speech) ? raw.speech : {};
  const handoff = isRecord(raw.handoff) ? raw.handoff : {};

  return {
    bells: {
      enabled: asBoolean(bells.enabled, DEFAULT_CONFIG.bells.enabled),
      errorSound: "Funk",
    },
    speech: {
      enabled: asBoolean(speech.enabled, DEFAULT_CONFIG.speech.enabled),
      maxChars: asInt(speech.maxChars, DEFAULT_CONFIG.speech.maxChars, 20, 2000),
      voice: asOptionalString(speech.voice, DEFAULT_CONFIG.speech.voice),
    },
    handoff: {
      maxMessages: asInt(handoff.maxMessages, DEFAULT_CONFIG.handoff.maxMessages, 4, 80),
      maxSummaryChars: asInt(handoff.maxSummaryChars, DEFAULT_CONFIG.handoff.maxSummaryChars, 200, 8000),
    },
  };
}

async function ensureConfigFile(): Promise<void> {
  if (existsSync(CONFIG_PATH)) return;
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const serialized = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  await writeFile(CONFIG_PATH, serialized, "utf8");
}

async function readConfig(): Promise<KitConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return sanitizeConfig(parsed);
  } catch {
    return sanitizeConfig(DEFAULT_CONFIG);
  }
}

async function writeConfig(next: KitConfig): Promise<void> {
  const safe = sanitizeConfig(next);
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  await rename(temp, CONFIG_PATH);
}

function renderStatus(config: KitConfig): string {
  const bell = config.bells.enabled ? "🔔 on" : "🔕 off";
  const speech = config.speech.enabled ? "🗣 on" : "🤫 off";
  return `${bell}  ${speech}`;
}

function getExplicitSessionName(ctx: any): string {
  return typeof ctx.sessionManager?.getSessionName === "function"
    ? String(ctx.sessionManager.getSessionName() || "").trim()
    : "";
}

function deriveFooterSessionLabel(ctx: any): string {
  const explicit = getExplicitSessionName(ctx);
  if (explicit) return explicit;

  const branch = typeof ctx.sessionManager?.getBranch === "function"
    ? ctx.sessionManager.getBranch()
    : [];

  if (Array.isArray(branch)) {
    for (const entry of branch) {
      if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "user") continue;
      const preview = messageText(entry.message as AgentMessage).replace(/\s+/g, " ").trim();
      if (preview) return clip(preview, 15);
    }
  }

  return "Untitled";
}

function visibleWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.length;
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return plain;
  return plain.slice(0, width);
}

function padBetween(left: string, right: string, width: number): string {
  const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width);
}

function withHorizontalPadding(line: string, totalWidth: number, pad: number): string {
  const safePad = Math.max(0, pad);
  const innerWidth = Math.max(1, totalWidth - safePad * 2);
  const inner = truncateToWidth(line, innerWidth);
  return `${" ".repeat(safePad)}${inner}${" ".repeat(safePad)}`;
}

function fmtCount(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function writeBell(): void {
  try {
    process.stdout.write("\u0007");
  } catch {
    // best effort
  }
}

async function runCommand(pi: ExtensionAPI, command: string, args: string[]): Promise<void> {
  try {
    await pi.exec(command, args, { timeout: 15_000 });
  } catch {
    // best effort
  }
}

async function playErrorAlert(pi: ExtensionAPI, config: KitConfig): Promise<void> {
  if (process.platform === "darwin" && config.bells.errorSound === "Funk") {
    await runCommand(pi, "afplay", [FUNK_SOUND_PATH]);
    return;
  }

  writeBell();
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenForSpeech(text: string, maxChars: number): string {
  const cleaned = cleanForSpeech(text);
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;

  const sentence = cleaned.match(/(.+?[.!?])(\s|$)/)?.[1]?.trim();
  if (sentence && sentence.length <= maxChars) return sentence;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3))}...`;
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

function buildHandoffSummary(messages: AgentMessage[], maxMessages: number, maxChars: number): string {
  const items = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = messageText(m).replace(/\s+/g, " ").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .slice(-maxMessages);

  if (items.length === 0) {
    return "No prior user/assistant context available.";
  }

  return clip(items.join("\n"), maxChars);
}

function sanitizeGeneratedTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] || "";
  const cleaned = firstLine
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  const compact = words.join(" ").replace(/[.!,;:]+$/g, "").trim();
  if (!compact) return "";
  if (/^untitled$/i.test(compact)) return "";
  return clip(compact, 48);
}

async function maybeAutoNameSession(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (AUTO_TITLE_DISABLED) return;
  if (!ctx.sessionManager?.getSessionId) return;
  if (getExplicitSessionName(ctx)) return;

  const sessionId = ctx.sessionManager.getSessionId();
  const now = Date.now();
  const lastAttempt = lastAutoTitleAttemptBySession.get(sessionId) || 0;
  if (now - lastAttempt < AUTO_TITLE_COOLDOWN_MS) return;

  const context = ctx.sessionManager?.buildSessionContext?.();
  const messages = Array.isArray(context?.messages) ? context.messages as AgentMessage[] : [];
  const userCount = messages.filter((m) => m.role === "user").length;
  if (userCount < AUTO_TITLE_MIN_USER_MESSAGES) return;

  const summary = buildHandoffSummary(messages, 10, 900);
  if (!summary || /No prior user\/assistant context available\./.test(summary)) return;

  lastAutoTitleAttemptBySession.set(sessionId, now);

  const prompt = [
    "Generate a concise conversation title.",
    "Rules:",
    "- Return title only, no quotes, no markdown.",
    "- Max 5 words.",
    "- Focus on concrete task/topic.",
    "- If unclear, return Untitled.",
    "",
    "Conversation summary:",
    summary,
  ].join("\n");

  try {
    const result = await pi.exec("env", ["PI_KIT_NO_AUTO_TITLE=1", "pi", "-p", "--no-session", prompt], {
      timeout: 25_000,
    });
    const title = sanitizeGeneratedTitle(result.stdout || "");
    if (!title) return;
    if (getExplicitSessionName(ctx)) return;

    pi.setSessionName(title);
  } catch {
    // best effort
  }
}

function parseToggleArg(args: string | undefined): "on" | "off" | "toggle" | undefined {
  const raw = (args || "").trim().toLowerCase();
  if (raw === "on" || raw === "off" || raw === "toggle") return raw;
  return undefined;
}

function parseHandoffArgs(args: string | undefined): { stay: boolean; prompt: string } {
  const raw = (args || "").trim();
  if (!raw) return { stay: false, prompt: "Continue from this handoff context." };

  const parts = raw.split(/\s+/);
  let stay = false;
  if (parts[0] === "--stay") {
    stay = true;
    parts.shift();
  }

  const prompt = parts.join(" ").trim() || "Continue from this handoff context.";
  return { stay, prompt };
}

type GuidedQuestion = {
  id: string;
  kind?: "text" | "select" | "boolean";
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
};

type GuidedQuestionnaireInput = {
  title?: string;
  intro?: string;
  questions: GuidedQuestion[];
};

const GUIDED_QUESTIONS_POLICY = [
  "When you need clarification from the user and there are 2 or more missing inputs, call guided_questions instead of asking a long list in plain chat.",
  "Keep questions short and concrete.",
  "Prefer select/boolean questions when possible, and only use free text when necessary.",
  "After guided_questions returns, proceed using details.answers as source-of-truth.",
].join("\n");

function normalizeQuestion(raw: GuidedQuestion, index: number): GuidedQuestion {
  const kind = raw.kind === "select" || raw.kind === "boolean" || raw.kind === "text"
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
      ? raw.options.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 24)
      : undefined,
  };
}

function extractQuestionsFromAssistantText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const cleaned = value
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^q:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return;
    if (!cleaned.includes("?")) return;
    const canonical = cleaned.toLowerCase();
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(cleaned);
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/\?$/.test(trimmed) || /^[-*+]\s+.*\?$/.test(trimmed) || /^\d+[.)]\s+.*\?$/.test(trimmed)) {
      push(trimmed);
      continue;
    }

    const sentenceMatches = trimmed.match(/[^?\n]{3,220}\?/g) || [];
    for (const candidate of sentenceMatches) push(candidate);
  }

  if (out.length === 0) {
    const paragraphMatches = text.replace(/\s+/g, " ").match(/[^?]{3,220}\?/g) || [];
    for (const candidate of paragraphMatches) push(candidate);
  }

  return out.slice(0, 10);
}

function buildWizardFromLastAssistant(ctx: any): GuidedQuestionnaireInput | null {
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
  if (!text) return null;

  const questions = extractQuestionsFromAssistantText(text).map((label, idx) => ({
    id: `q${idx + 1}`,
    kind: "text" as const,
    label,
    required: true,
  }));

  if (questions.length === 0) return null;

  return {
    title: "Clarify missing details",
    intro: "Answer the assistant's pending questions using the wizard.",
    questions,
  };
}

function splitLongFormSections(text: string): LongFormSection[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const headingChunks = normalized
    .split(/\n(?=#+\s+)/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const sections: LongFormSection[] = [];

  const pushSection = (title: string, body: string) => {
    const cleanBody = body.trim();
    if (!cleanBody) return;
    sections.push({
      title: clip(title.trim() || "Section", 64),
      body: clip(cleanBody, LONGFORM_SECTION_MAX_CHARS),
    });
  };

  const candidateBlocks = headingChunks.length > 1 ? headingChunks : normalized.split(/\n\n+/g);

  for (let idx = 0; idx < candidateBlocks.length; idx++) {
    const block = candidateBlocks[idx].trim();
    if (!block) continue;

    const lines = block.split("\n");
    const first = lines[0]?.trim() || "";
    const isHeading = /^#+\s+/.test(first);

    if (isHeading) {
      const title = first.replace(/^#+\s+/, "").trim() || `Section ${idx + 1}`;
      pushSection(title, lines.slice(1).join("\n"));
    } else {
      const sentence = block.replace(/\s+/g, " ").match(/^[^.!?\n]{4,80}[.!?]?/)?.[0]?.trim() || `Section ${idx + 1}`;
      pushSection(sentence, block);
    }

    if (sections.length >= LONGFORM_MAX_SECTIONS) break;
  }

  if (sections.length <= 1) {
    const paragraphs = normalized.split(/\n\n+/g).map((p) => p.trim()).filter(Boolean);
    const chunked: LongFormSection[] = [];
    let cursor = 0;
    while (cursor < paragraphs.length && chunked.length < LONGFORM_MAX_SECTIONS) {
      let body = "";
      while (cursor < paragraphs.length && `${body}\n\n${paragraphs[cursor]}`.trim().length <= LONGFORM_SECTION_MAX_CHARS) {
        body = `${body}\n\n${paragraphs[cursor]}`.trim();
        cursor += 1;
      }
      const title = body.match(/^[^.!?\n]{4,70}/)?.[0]?.trim() || `Section ${chunked.length + 1}`;
      if (body) chunked.push({ title, body });
      if (!body) cursor += 1;
    }
    return chunked.length > 0 ? chunked : sections;
  }

  return sections;
}

function buildLongFormPagerFromLastAssistant(ctx: any): LongFormSection[] | null {
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

  const sections = splitLongFormSections(text);
  return sections.length >= 2 ? sections : null;
}

async function runGuidedQuestionnaire(
  ctx: any,
  params: GuidedQuestionnaireInput,
): Promise<{
  contentText: string;
  details: Record<string, unknown>;
}> {
  if (!ctx.hasUI) {
    return {
      contentText: "guided_questions requires interactive mode with UI.",
      details: { cancelled: true, reason: "no-ui" },
    };
  }

  const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Guided questionnaire";
  const intro = typeof params.intro === "string" && params.intro.trim() ? params.intro.trim() : "";
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(normalizeQuestion);

  if (questions.length === 0) {
    return {
      contentText: "No questions were provided.",
      details: { cancelled: true, reason: "empty" },
    };
  }

  type AnswerValue = string | boolean;

  const interaction = await ctx.ui.custom<{ cancelled: boolean; answers: Record<string, AnswerValue> } | null>(
    (tui, theme, _kb, done) => {
      class WizardComponent {
        private _focused = false;
        private index = 0;
        private selectIndex = 0;
        private mode: "select" | "text" | "otherText" = "select";
        private answers: Record<string, AnswerValue> = {};
        private input = new Input();

        get focused(): boolean {
          return this._focused;
        }

        set focused(value: boolean) {
          this._focused = value;
          this.input.focused = value;
        }

        constructor() {
          if (intro) {
            ctx.ui.notify(`${title}: ${intro}`, "info");
          }
          this.loadQuestionState();
        }

        private getQuestion() {
          return questions[this.index]!;
        }

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
            return;
          }
          if (this.index === 0) {
            ctx.ui.notify("Already at first question.", "info");
            return;
          }
          this.index -= 1;
          this.loadQuestionState();
        }

        private moveNext(): void {
          const q = this.getQuestion();

          if (q.kind === "text") {
            const value = this.input.getValue().trim();
            if (!value && q.required !== false) {
              ctx.ui.notify("This question is required.", "warning");
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
              ctx.ui.notify("This question is required.", "warning");
              return;
            }
            this.answers[q.id] = value;
            this.advance();
            return;
          }

          if (this.mode === "otherText") {
            const value = this.input.getValue().trim();
            if (!value && q.required !== false) {
              ctx.ui.notify("Please provide your custom option.", "warning");
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
            return;
          }

          this.answers[q.id] = choice;
          this.advance();
        }

        private advance(): void {
          if (this.index >= questions.length - 1) {
            done({ cancelled: false, answers: this.answers });
            return;
          }
          this.index += 1;
          this.loadQuestionState();
        }

        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            done({ cancelled: true, answers: this.answers });
            return;
          }

          if (matchesKey(data, Key.shift("tab"))) {
            this.movePrevious();
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.tab)) {
            this.moveNext();
            tui.requestRender();
            return;
          }

          const q = this.getQuestion();
          const isTextMode = q.kind === "text" || this.mode === "text" || this.mode === "otherText";

          if (isTextMode) {
            if (matchesKey(data, Key.enter)) {
              this.moveNext();
              tui.requestRender();
              return;
            }
            this.input.handleInput(data);
            tui.requestRender();
            return;
          }

          const opts = this.getSelectOptions(q);
          if (matchesKey(data, Key.up)) {
            if (opts.length > 0) this.selectIndex = Math.max(0, this.selectIndex - 1);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down)) {
            if (opts.length > 0) this.selectIndex = Math.min(opts.length - 1, this.selectIndex + 1);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            this.moveNext();
            tui.requestRender();
          }
        }

        render(width: number): string[] {
          const q = this.getQuestion();
          const lines: string[] = [];

          const panelInside = Math.max(24, width - 2);
          const ansiLen = (s: string) => s
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
            .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
            .replace(/[\x00-\x1F\x7F]/g, "")
            .length;
          const fit = (s: string) => {
            const truncated = tuiTruncateToWidth(s, panelInside);
            const len = ansiLen(truncated);
            return len >= panelInside ? truncated : `${truncated}${" ".repeat(panelInside - len)}`;
          };
          const row = (content = "") => `${theme.fg("border", "│")}${fit(content)}${theme.fg("border", "│")}`;

          const answeredCount = questions.filter((question) => {
            const value = this.answers[question.id];
            if (typeof value === "boolean") return true;
            return typeof value === "string" && value.trim().length > 0;
          }).length;

          const progressDots = questions
            .map((_, idx) => {
              if (idx === this.index) return theme.fg("accent", "●");
              return idx < this.index ? theme.fg("success", "●") : theme.fg("dim", "○");
            })
            .join(" ");

          const prevValue = this.answers[q.id];
          const prevAnswer = typeof prevValue === "boolean"
            ? (prevValue ? "Yes" : "No")
            : (typeof prevValue === "string" && prevValue.trim() ? prevValue.trim() : "");

          lines.push(`${theme.fg("borderAccent", "╭")}${theme.fg("borderAccent", "─".repeat(panelInside))}${theme.fg("borderAccent", "╮")}`);
          lines.push(row(`${theme.fg("accent", theme.bold(title))}`));
          lines.push(row(`${theme.fg("dim", `Question ${this.index + 1}/${questions.length} • ${answeredCount} answered`)}  ${progressDots}`));
          lines.push(row(theme.fg("text", q.label)));
          if (q.help) lines.push(row(theme.fg("muted", q.help)));
          if (prevAnswer) lines.push(row(theme.fg("dim", `Current: ${clip(prevAnswer, 80)}`)));
          lines.push(row());

          const isTextMode = q.kind === "text" || this.mode === "text" || this.mode === "otherText";

          if (isTextMode) {
            const prompt = this.mode === "otherText"
              ? theme.fg("accent", "Specify Other")
              : theme.fg("dim", "Answer");
            lines.push(row(`${prompt}${theme.fg("dim", ":")}`));
            for (const line of this.input.render(Math.max(10, panelInside - 2))) {
              lines.push(row(` ${line}`));
            }
          } else {
            const opts = this.getSelectOptions(q);
            for (let i = 0; i < opts.length; i++) {
              const selected = i === this.selectIndex;
              const prefix = selected ? theme.fg("accent", "› ") : "  ";
              const text = selected ? theme.fg("accent", opts[i]!) : opts[i]!;
              lines.push(row(`${prefix}${text}`));
            }
          }

          lines.push(row());
          lines.push(row(theme.fg("dim", "↑/↓ move • Enter/Tab next • Shift+Tab previous • Esc cancel")));
          lines.push(`${theme.fg("borderAccent", "╰")}${theme.fg("borderAccent", "─".repeat(panelInside))}${theme.fg("borderAccent", "╯")}`);
          return lines;
        }

        invalidate(): void {
          this.input.invalidate();
        }
      }

      return new WizardComponent();
    },
  );

  const answers = interaction?.answers || {};
  if (!interaction || interaction.cancelled) {
    return {
      contentText: "Questionnaire cancelled.",
      details: {
        cancelled: true,
        answers,
        answeredCount: Object.keys(answers).length,
        totalQuestions: questions.length,
      },
    };
  }

  const summaryLines = questions.map((q) => {
    const value = answers[q.id];
    const rendered = typeof value === "boolean" ? (value ? "Yes" : "No") : (String(value || "").trim() || "(skipped)");
    return `- ${q.label}: ${rendered}`;
  });

  return {
    contentText: [`${title} complete.`, "", ...summaryLines].join("\n"),
    details: {
      title,
      answers,
      answeredCount: Object.keys(answers).length,
      totalQuestions: questions.length,
      completed: true,
    },
  };
}

export default function piKitExtension(pi: ExtensionAPI): void {
  let currentConfig: KitConfig = sanitizeConfig(DEFAULT_CONFIG);
  let activePagerOverlay: { setHidden: (h: boolean) => void; hide: () => void } | null = null;

  function openLongFormPager(ctx: any, sections: LongFormSection[], startIndex = 0): void {
    if (!ctx.hasUI || sections.length < 2) return;

    if (activePagerOverlay) {
      activePagerOverlay.hide();
      activePagerOverlay = null;
    }

    ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        let index = Math.max(0, Math.min(sections.length - 1, startIndex));

        return {
          handleInput(data: string): void {
            if (matchesKey(data, Key.escape)) {
              done();
              return;
            }
            if (matchesKey(data, Key.right) || matchesKey(data, Key.ctrl("shift+right"))) {
              if (index < sections.length - 1) index += 1;
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.left) || matchesKey(data, Key.ctrl("shift+left"))) {
              if (index > 0) index -= 1;
              tui.requestRender();
              return;
            }
          },

          render(width: number): string[] {
            const inside = Math.max(24, width - 2);
            const section = sections[index]!;

            const stripAnsi = (s: string) => s
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
              .replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "")
              .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
              .replace(/[\x00-\x1F\x7F]/g, "");
            const fit = (s: string) => {
              const truncated = tuiTruncateToWidth(s, inside);
              const plain = stripAnsi(truncated);
              return plain.length >= inside ? truncated : `${truncated}${" ".repeat(inside - plain.length)}`;
            };
            const bc = (s: string) => theme.fg("borderAccent", s);
            const row = (content = "") => `${bc("│")}${fit(content)}${bc("│")}`;

            const dots = sections
              .map((_, idx) => idx === index ? theme.fg("accent", "●") : theme.fg("dim", "○"))
              .join(" ");

            const md = new Markdown(section.body, 0, 0, getMarkdownTheme(), {
              color: (text: string) => theme.fg("text", text),
            });
            const bodyLines = md.render(Math.max(12, inside - 4));

            const termRows = process.stdout.rows || 40;
            const reservedForComposer = 7;
            const availableRows = Math.max(12, termRows - reservedForComposer);

            const content = [
              `${bc("╭")}${bc("─".repeat(inside))}${bc("╮")}`,
              row(theme.fg("accent", theme.bold(`Long response • ${index + 1}/${sections.length}`))),
              row(`${dots}`),
              row(theme.fg("text", section.title)),
              row(),
              ...bodyLines.map((line) => row(` ${line}`)),
              row(),
              row(theme.fg("dim", "← previous • → next • Esc close")),
            ];

            while (content.length < availableRows - 1) {
              content.push(row());
            }

            content.push(`${bc("╰")}${bc("─".repeat(inside))}${bc("╯")}`);
            return content;
          },

          invalidate(): void {},
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "100%",
          height: "100%",
          anchor: "top-left" as any,
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        },
        onHandle: (handle) => {
          activePagerOverlay = handle;
        },
      },
    );
  }

  function closeLongFormPager(_ctx: any): void {
    if (activePagerOverlay) {
      activePagerOverlay.hide();
      activePagerOverlay = null;
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (!pi.getActiveTools().includes("guided_questions")) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${GUIDED_QUESTIONS_POLICY}`,
    };
  });

  function installFooter(ctx: any): void {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const branch = ctx.sessionManager.getBranch();
          let input = 0;
          let output = 0;
          let cost = 0;

          for (const e of branch) {
            if (e.type === "message" && e.message.role === "assistant") {
              const usage = (e.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
              input += usage?.input || 0;
              output += usage?.output || 0;
              cost += usage?.cost?.total || 0;
            }
          }

          const home = homedir();
          const cwd = typeof ctx.cwd === "string" && ctx.cwd.startsWith(home)
            ? `~${ctx.cwd.slice(home.length)}`
            : (ctx.cwd || "");
          const sessionName = deriveFooterSessionLabel(ctx);
          const row1Left = theme.fg("muted", `${cwd} • ${sessionName}`);
          const row1Right = theme.fg("dim", renderStatus(currentConfig));

          const usageText = `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(3)}`;
          const contextUsage = ctx.getContextUsage?.();
          const maxTokens =
            (contextUsage && typeof contextUsage.maxTokens === "number" ? contextUsage.maxTokens : undefined) ||
            (typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined);
          const usedTokens =
            contextUsage && typeof contextUsage.tokens === "number"
              ? contextUsage.tokens
              : 0;
          const contextSuffix =
            typeof maxTokens === "number" && maxTokens > 0
              ? ` ${((usedTokens / maxTokens) * 100).toFixed(1)}%/${fmtCount(maxTokens)} (auto)`
              : " 0.0%/unknown (auto)";
          const row2Left = theme.fg("dim", `${usageText}${contextSuffix}`);

          const modelId = ctx.model?.id || "no-model";
          const thinking = pi.getThinkingLevel?.() || "off";
          const row2Right = theme.fg("dim", `${modelId} • ${thinking}`);

          const footerPadX = 1;
          const innerWidth = Math.max(1, width - footerPadX * 2);

          return [
            withHorizontalPadding(padBetween(row1Left, row1Right, innerWidth), width, footerPadX),
            withHorizontalPadding(padBetween(row2Left, row2Right, innerWidth), width, footerPadX),
          ];
        },
      };
    });
  }

  async function refreshStatus(ctx: any): Promise<void> {
    currentConfig = await readConfig();
    installFooter(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureConfigFile();
    await refreshStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await refreshStatus(ctx);
    closeLongFormPager(ctx);
  });



  pi.registerCommand("bells", {
    description: "Toggle bells: /bells on|off|toggle",
    handler: async (args, ctx) => {
      const action = parseToggleArg(args);
      if (!action) {
        ctx.ui.notify("Usage: /bells on|off|toggle", "warning");
        return;
      }

      const config = await readConfig();
      const nextEnabled =
        action === "toggle" ? !config.bells.enabled : action === "on";

      config.bells.enabled = nextEnabled;
      await writeConfig(config);
      await refreshStatus(ctx);
      ctx.ui.notify(`Bells ${nextEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("speech", {
    description: "Toggle speech: /speech on|off|toggle",
    handler: async (args, ctx) => {
      const action = parseToggleArg(args);
      if (!action) {
        ctx.ui.notify("Usage: /speech on|off|toggle", "warning");
        return;
      }

      const config = await readConfig();
      const nextEnabled =
        action === "toggle" ? !config.speech.enabled : action === "on";

      config.speech.enabled = nextEnabled;
      await writeConfig(config);
      await refreshStatus(ctx);
      ctx.ui.notify(`Speech ${nextEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("handoff", {
    description: "Create a child thread with compact context. Use --stay to avoid switching.",
    handler: async (args, ctx) => {
      const { stay, prompt } = parseHandoffArgs(args);
      const sourceSessionPath = ctx.sessionManager.getSessionFile();
      const sourceSessionId = ctx.sessionManager.getSessionId();
      const sourceIdShort = sourceSessionId.slice(0, 8);

      if (!sourceSessionPath) {
        ctx.ui.notify("Handoff requires a persisted session.", "warning");
        return;
      }

      const config = await readConfig();
      const context = ctx.sessionManager.buildSessionContext();
      const summary = buildHandoffSummary(
        context.messages,
        config.handoff.maxMessages,
        config.handoff.maxSummaryChars,
      );

      const childName = `↳ ${clip(prompt, 48)}`;
      const seededPrompt = [
        prompt,
        "",
        "---",
        "",
        "Handoff context from parent thread:",
        summary,
        "",
        `Parent thread reference: [[thread:${sourceIdShort}]]`,
        `Parent session ID: ${sourceSessionId}`,
      ].join("\n");

      if (stay) {
        const childManager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
        childManager.newSession({ parentSession: sourceSessionPath });
        childManager.appendSessionInfo(childName);
        childManager.appendMessage({
          role: "user",
          content: [{ type: "text", text: seededPrompt }],
          timestamp: Date.now(),
        });

        const childId = childManager.getSessionId().slice(0, 8);
        pi.events.emit("thread:handoff", { stay: true, childId });
        ctx.ui.notify(`Created child thread ${childId} (stayed in current thread).`, "info");
        return;
      }

      const result = await ctx.newSession({
        parentSession: sourceSessionPath,
        setup: async (sm) => {
          sm.appendSessionInfo(childName);
        },
      });

      if (result.cancelled) return;

      pi.events.emit("thread:handoff", { stay: false });
      pi.sendUserMessage(seededPrompt);
    },
  });

  pi.registerTool({
    name: "guided_questions",
    label: "Guided Questions",
    description: "Ask the user a structured, one-question-at-a-time questionnaire in the terminal UI.",
    promptSnippet: "Collect structured user answers via an interactive questionnaire when multiple clarifying questions are needed.",
    promptGuidelines: [
      "Use this tool when you need 2+ clarifying answers from the user.",
      "Prefer short labels and constrained choices for select questions.",
      "After the tool returns, continue using the structured answers directly.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short title shown to the user" })),
      intro: Type.Optional(Type.String({ description: "Optional intro shown before the first question" })),
      questions: Type.Array(Type.Object({
        id: Type.String({ description: "Stable key for the answer" }),
        kind: Type.Optional(Type.String({ description: "text | select | boolean" })),
        label: Type.String({ description: "Question shown to the user" }),
        help: Type.Optional(Type.String({ description: "Optional helper text" })),
        placeholder: Type.Optional(Type.String({ description: "Placeholder for text input" })),
        required: Type.Optional(Type.Boolean({ description: "Whether answer is required (default true)" })),
        options: Type.Optional(Type.Array(Type.String(), { description: "Options for select questions" })),
      }), { minItems: 1, maxItems: 12 }),
    }),
    execute: async (_toolCallId, input, _signal, _onUpdate, ctx) => {
      const result = await runGuidedQuestionnaire(ctx, input as GuidedQuestionnaireInput);
      return {
        content: [{ type: "text", text: result.contentText }],
        details: result.details,
      };
    },
  });

  pi.registerCommand("pager", {
    description: "Open long-form pager for last assistant response: /pager [off]",
    handler: async (args, ctx) => {
      const action = String(args || "").trim().toLowerCase();

      if (action === "off" || action === "hide" || action === "close") {
        closeLongFormPager(ctx);
        ctx.ui.notify("Pager closed.", "info");
        return;
      }

      const sections = buildLongFormPagerFromLastAssistant(ctx);
      if (!sections) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      openLongFormPager(ctx, sections, 0);
    },
  });

  pi.registerCommand("wizard", {
    description: "Run guided questions from last assistant message (use --demo for sample)",
    handler: async (args, ctx) => {
      const raw = String(args || "").trim().toLowerCase();
      const useDemo = raw === "--demo" || raw === "demo";

      const sampleQuestions: GuidedQuestionnaireInput = {
        title: "Project intake",
        intro: "Answer a few quick questions so I can tailor implementation.",
        questions: [
          { id: "goal", kind: "text", label: "What is the primary goal?", placeholder: "e.g. add Stripe subscriptions" },
          { id: "stack", kind: "select", label: "Which stack are we working in?", options: ["Next.js", "Node", "Python", "Other"], required: true },
          { id: "strict", kind: "boolean", label: "Should I optimize for strict type safety first?", required: true },
        ],
      };

      const inferred = buildWizardFromLastAssistant(ctx);
      const questionnaire = useDemo ? sampleQuestions : (inferred || sampleQuestions);

      if (!useDemo && !inferred) {
        ctx.ui.notify("No clear questions found in last assistant message; using demo questionnaire. Use /wizard --demo anytime.", "info");
      }

      const result = await runGuidedQuestionnaire(ctx, questionnaire);
      ctx.ui.notify(result.contentText, "info");

      const answers = (result.details.answers || {}) as Record<string, unknown>;
      if (Object.keys(answers).length > 0) {
        pi.sendUserMessage([
          {
            type: "text",
            text: [
              "Questionnaire answers:",
              "```json",
              JSON.stringify(answers, null, 2),
              "```",
              "Use these answers as the source of truth and proceed.",
            ].join("\n"),
          },
        ]);
      }
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = await readConfig();

    await maybeAutoNameSession(pi, ctx);

    const lastAssistant = [...event.messages]
      .reverse()
      .find((m) => m.role === "assistant") as (AgentMessage & { stopReason?: string; errorMessage?: string }) | undefined;

    const isTerminalError = Boolean(
      lastAssistant &&
      (lastAssistant.stopReason === "error" ||
        lastAssistant.stopReason === "aborted" ||
        (typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim().length > 0)) &&
      !ctx.hasPendingMessages(),
    );

    if (!isTerminalError && lastAssistant) {
      const longText = messageText(lastAssistant as AgentMessage).trim();
      if (longText.length >= LONGFORM_MIN_CHARS) {
        const sections = splitLongFormSections(longText);
        if (sections.length >= 2) {
          openLongFormPager(ctx, sections, 0);
        }
      }
    }

    if (config.bells.enabled) {
      if (isTerminalError) {
        await playErrorAlert(pi, config);
      } else {
        writeBell();
      }
    }

    if (!config.speech.enabled) return;
    if (process.platform !== "darwin") return;
    if (!lastAssistant) return;

    const raw = messageText(lastAssistant as AgentMessage);
    const speech = shortenForSpeech(raw, config.speech.maxChars);
    if (!speech) return;

    const sessionId = ctx.sessionManager.getSessionId();
    const signature = `${(lastAssistant as { timestamp?: number }).timestamp || 0}:${speech}`;
    if (lastSpokenBySession.get(sessionId) === signature) return;

    lastSpokenBySession.set(sessionId, signature);
    const args: string[] = [];
    if (config.speech.voice) args.push("-v", config.speech.voice);
    args.push(speech);
    await runCommand(pi, "say", args);
  });
}
