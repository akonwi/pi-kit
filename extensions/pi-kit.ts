import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { isKeyRelease, truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@mariozechner/pi-tui";
import { ensureThreadReferenceEditorInstalled, handleThreadReferenceHandoff, handleThreadReferenceUserBash, refreshThreadReferenceComposer, setActiveEditorRenderDelegate, setThreadReferenceDockState } from "./ui/thread-reference-shell";
import { openPagerScreen, type LongFormPagerContent, type LongFormSection } from "./ui/screens/pager-screen";
import { createThreadScreen } from "./ui/screens/thread-screen";
import { openWizardScreen } from "./ui/screens/wizard-screen";
import { normalizeQuestion, type GuidedQuestion, type GuidedQuestionnaireInput } from "./ui/input-surfaces/wizard-input";
import { sharedInteractionDock, sharedScreenManager, UI_EVENT_KEYS } from "./ui/shell";

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

const pagerNotesByEntryId = new Map<string, Map<number, string>>();

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
  return tuiVisibleWidth(text);
}

function truncateToWidth(text: string, width: number, pad = false): string {
  if (width <= 0) return "";
  return tuiTruncateToWidth(text, width, "", pad);
}

function padBetween(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, true);
}

function withHorizontalPadding(line: string, totalWidth: number, pad: number): string {
  if (totalWidth <= 0) return "";
  const safePad = Math.max(0, Math.min(pad, Math.floor(totalWidth / 2)));
  const innerWidth = Math.max(0, totalWidth - safePad * 2);
  const inner = innerWidth > 0 ? truncateToWidth(line, innerWidth, true) : "";
  return `${" ".repeat(safePad)}${inner}${" ".repeat(safePad)}`;
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

const GUIDED_QUESTIONS_POLICY = [
  "When you need clarification from the user and there are 2 or more missing inputs, call guided_questions instead of asking a long list in plain chat.",
  "Keep questions short and concrete.",
  "Prefer select/boolean questions when possible, and only use free text when necessary.",
  "After guided_questions returns, proceed using details.answers as source-of-truth.",
].join("\n");

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
      pushSection(title, block);
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

function getPagerNotes(sessionId: string, entryId: string): Map<number, string> {
  const key = `${sessionId}:${entryId}`;
  let notes = pagerNotesByEntryId.get(key);
  if (!notes) {
    notes = new Map<number, string>();
    pagerNotesByEntryId.set(key, notes);
  }
  return notes;
}

function countPagerNotes(notes: Map<number, string>): number {
  return Array.from(notes.values()).filter((note) => note.trim().length > 0).length;
}

function formatPagerFeedbackMessage(pager: LongFormPagerContent, notes: Map<number, string>): string | null {
  const blocks: string[] = [];

  pager.sections.forEach((section, idx) => {
    const note = notes.get(idx)?.trim();
    if (!note) return;
    blocks.push(`## Section ${idx + 1}: ${section.title}\n${note}`);
  });

  if (blocks.length === 0) return null;

  return [
    "Here is my feedback on your previous response, grouped by section.",
    "",
    ...blocks.flatMap((block, idx) => idx === 0 ? [block] : ["", block]),
    "",
    "Please use this section-specific feedback in your revision or reply.",
  ].join("\n");
}

function buildLongFormPagerFromLastAssistant(ctx: any): LongFormPagerContent | null {
  const branch = Array.isArray(ctx.sessionManager?.getBranch?.()) ? ctx.sessionManager.getBranch() : [];
  const sessionId = typeof ctx.sessionManager?.getSessionId?.() === "string"
    ? ctx.sessionManager.getSessionId()
    : "unknown-session";
  let lastAssistant: AgentMessage | undefined;
  let lastAssistantEntryId: string | null = null;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    lastAssistant = entry.message as AgentMessage;
    lastAssistantEntryId = typeof entry.id === "string" && entry.id.trim()
      ? entry.id
      : `assistant-${Date.now()}`;
    break;
  }

  if (!lastAssistant || !lastAssistantEntryId) return null;

  const text = messageText(lastAssistant).trim();
  if (!text || text.length < LONGFORM_MIN_CHARS) return null;

  const sections = splitLongFormSections(text);
  return sections.length >= 2 ? { sessionId, entryId: lastAssistantEntryId, sections } : null;
}

export default function piKitExtension(pi: ExtensionAPI): void {
  let currentConfig: KitConfig = sanitizeConfig(DEFAULT_CONFIG);
  let removeScreenInputRouter: (() => void) | undefined;
  const screenManager = sharedScreenManager;
  const dockController = sharedInteractionDock;

  dockController.configure({
    onRefresh: () => {
      refreshThreadReferenceComposer();
      pi.events.emit(UI_EVENT_KEYS.dockRefresh);
    },
    onStateChange: (state) => {
      setThreadReferenceDockState(state);
      pi.events.emit(UI_EVENT_KEYS.dockStateChanged, state);
    },
    onMetricsChange: (metrics) => {
      pi.events.emit(UI_EVENT_KEYS.dockMetricsChanged, metrics);
    },
  });

  const activateThreadScreen = () => {
    screenManager.activate(createThreadScreen(dockController));
  };

  function openLongFormPager(ctx: any, pager: LongFormPagerContent, startIndex = 0): void {
    const { sections } = pager;
    if (!ctx.hasUI || sections.length < 2) return;

    const notes = getPagerNotes(pager.sessionId, pager.entryId);
    let screen: ReturnType<typeof openPagerScreen>;
    screen = openPagerScreen({
      ctx,
      pager,
      notes,
      startIndex,
      dock: dockController,
      formatFeedbackMessage: formatPagerFeedbackMessage,
      onSubmitMessage: (message: string) => {
        pagerNotesByEntryId.delete(`${pager.sessionId}:${pager.entryId}`);
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: "followUp" });
          ctx.ui.notify("Grouped section feedback queued.", "info");
        }
      },
      onClosed: () => {
        screenManager.clearIfActive(screen);
        activateThreadScreen();
      },
    });
    screenManager.activate(screen);
  }

  function closeLongFormPager(_ctx: any): void {
    screenManager.closeActive();
    activateThreadScreen();
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

    const questions = (Array.isArray(params.questions) ? params.questions : []).map(normalizeQuestion);
    if (questions.length === 0) {
      return {
        contentText: "No questions were provided.",
        details: { cancelled: true, reason: "empty" },
      };
    }

    const { screen, result } = openWizardScreen({
      ctx,
      params: { ...params, questions },
      dock: dockController,
      setRenderDelegate: setActiveEditorRenderDelegate,
      onClosed: () => {
        screenManager.clearIfActive(screen);
        activateThreadScreen();
      },
    });
    screenManager.activate(screen);

    const wizardResult = await result;

    const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Guided questionnaire";
    const answers = wizardResult.answers;

    if (wizardResult.cancelled) {
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

  pi.events.on(UI_EVENT_KEYS.dockMetricsChanged, (metrics) => {
    if (!metrics) return;
    dockController.setMetrics(metrics);
  });

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
          const home = homedir();
          const cwdBase = typeof ctx.cwd === "string" && ctx.cwd.startsWith(home)
            ? `~${ctx.cwd.slice(home.length)}`
            : (ctx.cwd || "");
          const gitBranch = footerData.getGitBranch?.();
          const cwd = gitBranch ? `${cwdBase} (${gitBranch})` : cwdBase;
          const sessionName = deriveFooterSessionLabel(ctx);
          const row1Left = theme.fg("muted", `${cwd} • ${sessionName}`);
          const row1Right = theme.fg("dim", renderStatus(currentConfig));

          const contextUsage = ctx.getContextUsage?.();
          const maxTokens =
            (contextUsage && typeof contextUsage.maxTokens === "number" ? contextUsage.maxTokens : undefined) ||
            (typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined);
          const usedTokens =
            contextUsage && typeof contextUsage.tokens === "number"
              ? contextUsage.tokens
              : 0;
          const contextPct =
            typeof maxTokens === "number" && maxTokens > 0
              ? `${((usedTokens / maxTokens) * 100).toFixed(1)}%`
              : "0%";
          const modelId = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel?.() || "off";
          const thinkingEmoji =
            thinkingLevel === "high" ? "🔥" :
            thinkingLevel === "medium" ? "💡" :
            thinkingLevel === "low" ? "💤" : "⛔";
          const row2Left = theme.fg("dim", `[${modelId}][${thinkingEmoji}] 🪟${contextPct}`);
          const row2Right = theme.fg("dim", "");

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

  function installScreenInputRouter(ctx: any): void {
    if (!ctx.hasUI) return;
    removeScreenInputRouter?.();
    removeScreenInputRouter = ctx.ui.onTerminalInput((data: string) => {
      if (isKeyRelease(data)) {
        return undefined;
      }

      const dockResult = dockController.handleInput(data);
      if (dockResult?.consume) return dockResult;

      const nextData = dockResult?.data !== undefined ? dockResult.data : data;

      if (dockController.blocksScreenInput()) {
        return undefined;
      }

      return screenManager.handleInput(nextData);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureConfigFile();
    await refreshStatus(ctx);
    installScreenInputRouter(ctx);
    await ensureThreadReferenceEditorInstalled(pi, ctx);
    activateThreadScreen();
  });

  pi.on("session_switch", async (_event, ctx) => {
    await refreshStatus(ctx);
    installScreenInputRouter(ctx);
    await ensureThreadReferenceEditorInstalled(pi, ctx);
    closeLongFormPager(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    await ensureThreadReferenceEditorInstalled(pi, ctx);
  });

  pi.on("user_bash", async (event, ctx) => {
    handleThreadReferenceUserBash(event, ctx);
  });

  pi.events.on("thread:handoff", (data?: { stay?: boolean }) => {
    handleThreadReferenceHandoff(data);
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

      const pager = buildLongFormPagerFromLastAssistant(ctx);
      if (!pager) {
        ctx.ui.notify("No long assistant response found to paginate.", "warning");
        return;
      }

      openLongFormPager(ctx, pager, 0);
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
