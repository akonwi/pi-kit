/**
 * Footer extension — custom status bar.
 *
 * Displays cwd, git branch, session name, model, context usage,
 * and notification status in the Pi footer.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@mariozechner/pi-tui";
import { readConfig } from "./notifications";

// --- Helpers ---

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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

function parseContextPercent(value: string): number {
  const n = parseFloat(String(value || "0").replace(/%$/, ""));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function colorContextPercent(theme: any, contextPct: string): string {
  const pct = parseContextPercent(contextPct);
  const color = pct >= 90 ? "error" : pct >= 80 ? "warning" : "dim";
  return theme?.fg ? theme.fg(color, contextPct) : contextPct;
}

// --- Extension factory ---

export default function footerExtension(pi: ExtensionAPI): void {
  let currentConfig = {
    bells: { enabled: true },
    speech: { enabled: true },
  };

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
          const left = theme.fg("muted", `${cwd} • ${sessionName}`);

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
          const bell = currentConfig.bells.enabled ? "🔔" : "🔕";
          const speech = currentConfig.speech.enabled ? "🗣" : "🤫";
          const right = `${theme.fg("dim", `${modelId} (${thinkingLevel})`)} ${colorContextPercent(theme, contextPct)}  ${theme.fg("dim", `${bell} ${speech}`)}`;

          const footerPadX = 1;
          const innerWidth = Math.max(1, width - footerPadX * 2);

          return [withHorizontalPadding(padBetween(left, right, innerWidth), width, footerPadX)];
        },
      };
    });
  }

  async function refreshStatus(ctx: any): Promise<void> {
    const config = await readConfig();
    currentConfig = {
      bells: { enabled: config.bells.enabled },
      speech: { enabled: config.speech.enabled },
    };
    installFooter(ctx);
  }

  pi.on("session_start", async () => {
    // Footer will be installed on first context refresh
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await refreshStatus(ctx);
  });
}