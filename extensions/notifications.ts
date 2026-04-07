/**
 * Notifications extension — bells and speech commands.
 *
 * Manages notification preferences in ~/.pi/agent/kit.json
 * and provides /bells and /speech commands.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type NotificationConfig = {
  bells: {
    enabled: boolean;
    errorSound: "Funk";
  };
  speech: {
    enabled: boolean;
    maxChars: number;
    voice: string | null;
  };
};

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "kit.json");
const FUNK_SOUND_PATH = "/System/Library/Sounds/Funk.aiff";

const DEFAULT_CONFIG: NotificationConfig = {
  bells: {
    enabled: true,
    errorSound: "Funk",
  },
  speech: {
    enabled: true,
    maxChars: 220,
    voice: null,
  },
};

// --- Config helpers ---

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

export function sanitizeConfig(input: unknown): NotificationConfig {
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
    // Include handoff in sanitization for config file compatibility
    ...(isRecord(handoff) ? { handoff: {
      maxMessages: asInt((handoff as Record<string, unknown>).maxMessages, 20, 4, 80),
      maxSummaryChars: asInt((handoff as Record<string, unknown>).maxSummaryChars, 1400, 200, 8000),
    }} : {}),
  } as NotificationConfig & { handoff?: { maxMessages: number; maxSummaryChars: number } };
}

export async function ensureConfigFile(): Promise<void> {
  if (existsSync(CONFIG_PATH)) return;
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const serialized = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
  await writeFile(CONFIG_PATH, serialized, "utf8");
}

export async function readConfig(): Promise<NotificationConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return sanitizeConfig(parsed);
  } catch {
    return sanitizeConfig(DEFAULT_CONFIG);
  }
}

export async function writeConfig(next: NotificationConfig): Promise<void> {
  const safe = sanitizeConfig(next);
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  await rename(temp, CONFIG_PATH);
}

// --- Bell helpers ---

export function writeBell(): void {
  try {
    process.stdout.write("\u0007");
  } catch {
    // best effort
  }
}

export async function runCommand(pi: ExtensionAPI, command: string, args: string[]): Promise<void> {
  try {
    await pi.exec(command, args, { timeout: 15_000 });
  } catch {
    // best effort
  }
}

export async function playErrorAlert(pi: ExtensionAPI, config: NotificationConfig): Promise<void> {
  if (process.platform === "darwin" && config.bells.errorSound === "Funk") {
    await runCommand(pi, "afplay", [FUNK_SOUND_PATH]);
    return;
  }

  writeBell();
}

// --- Speech helpers ---

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortenForSpeech(text: string, maxChars: number): string {
  const cleaned = cleanForSpeech(text);
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;

  const sentence = cleaned.match(/(.+?[.!?])(\s|$)/)?.[1]?.trim();
  if (sentence && sentence.length <= maxChars) return sentence;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3))}...`;
}

// --- Command argument parsing ---

function parseToggleArg(
  args: string | undefined,
  options?: { emptyDefaultsToToggle?: boolean },
): "on" | "off" | "toggle" | undefined {
  const raw = (args || "").trim().toLowerCase();
  if (!raw) return options?.emptyDefaultsToToggle ? "toggle" : undefined;
  if (raw === "on" || raw === "off" || raw === "toggle") return raw;
  return undefined;
}

// --- Extension factory ---

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const content: unknown = (msg as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && typeof p === "object" && (p as any).type === "text" ? (p as any).text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }
  return "";
}

export default function notificationsExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    await ensureConfigFile();
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = await readConfig();

    const text = lastAssistantText(event.messages);

    if (config.bells.enabled) {
      writeBell();
    }

    if (config.speech.enabled && text && process.platform === "darwin") {
      const spoken = shortenForSpeech(text, config.speech.maxChars);
      if (spoken) {
        const args = config.speech.voice ? ["-v", config.speech.voice, spoken] : [spoken];
        await runCommand(pi, "say", args);
      }
    }
  });

  pi.registerCommand("bells", {
    description: "Toggle bell notifications on/off",
    handler: async (args, ctx) => {
      const action = parseToggleArg(args, { emptyDefaultsToToggle: true });
      if (!action) {
        ctx.ui.notify("Usage: /bells [on|off|toggle]", "warning");
        return;
      }

      const config = await readConfig();
      const nextEnabled =
        action === "toggle" ? !config.bells.enabled : action === "on";

      config.bells.enabled = nextEnabled;
      await writeConfig(config);
      ctx.ui.notify(`Bells ${nextEnabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("speech", {
    description: "Toggle speech notifications on/off",
    handler: async (args, ctx) => {
      const action = parseToggleArg(args, { emptyDefaultsToToggle: true });
      if (!action) {
        ctx.ui.notify("Usage: /speech [on|off|toggle]", "warning");
        return;
      }

      const config = await readConfig();
      const nextEnabled =
        action === "toggle" ? !config.speech.enabled : action === "on";

      config.speech.enabled = nextEnabled;
      await writeConfig(config);
      ctx.ui.notify(`Speech ${nextEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}