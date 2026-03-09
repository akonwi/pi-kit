import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

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

export default function piKitExtension(pi: ExtensionAPI): void {
  let currentConfig: KitConfig = sanitizeConfig(DEFAULT_CONFIG);

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
          const sessionName = ctx.sessionManager.getSessionName() || "Init Pi";
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

  pi.on("agent_end", async (event, ctx) => {
    const config = await readConfig();

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
