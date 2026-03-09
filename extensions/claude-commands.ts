/**
 * Claude Code Commands Compatibility Layer
 *
 * Discovers `.claude/commands/*.md` in the project root and registers them as
 * Pi slash commands with a `cc:` prefix. For example, `.claude/commands/draft-pr.md`
 * becomes `/cc:draft-pr`.
 *
 * Claude command files use the same frontmatter format as Pi prompt templates
 * (`description`, `argument-hint`) and `$ARGUMENTS` for argument substitution,
 * so the mapping is straightforward.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ClaudeCommand {
  name: string;
  filePath: string;
  description: string;
  argumentHint?: string;
}

function parseFrontmatter(content: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { attributes: {}, body: content };

  const attributes: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key && value) attributes[key] = value;
  }

  return { attributes, body: match[2] };
}

function discoverCommands(cwd: string): ClaudeCommand[] {
  const commandsDir = path.join(cwd, ".claude", "commands");
  if (!existsSync(commandsDir)) return [];

  const commands: ClaudeCommand[] = [];

  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const name = entry.name.replace(/\.md$/, "");
    const filePath = path.join(commandsDir, entry.name);

    try {
      const raw = readFileSync(filePath, "utf8");
      const { attributes, body } = parseFrontmatter(raw);

      const description =
        attributes.description ||
        body
          .split("\n")
          .find((l) => l.trim().length > 0)
          ?.trim()
          .slice(0, 80) ||
        name;

      commands.push({
        name,
        filePath,
        description,
        argumentHint: attributes["argument-hint"],
      });
    } catch {
      // Skip files we can't read
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function expandArguments(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS/g, args).replace(/\$@/g, args);
}

export default function claudeCommandsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const commands = discoverCommands(ctx.cwd);
    if (commands.length === 0) return;

    for (const cmd of commands) {
      pi.registerCommand(`cc:${cmd.name}`, {
        description: cmd.description,
        handler: async (args, _ctx) => {
          // Re-read the file at invocation time so edits are picked up without reload
          let raw: string;
          try {
            raw = readFileSync(cmd.filePath, "utf8");
          } catch {
            _ctx.ui.notify(`Failed to read ${cmd.filePath}`, "error");
            return;
          }

          const { body } = parseFrontmatter(raw);
          const prompt = expandArguments(body, args?.trim() ?? "");
          pi.sendUserMessage(prompt);
        },
      });
    }

    ctx.ui.notify(
      `Loaded ${commands.length} Claude command(s) as /cc:* `,
      "info",
    );
  });
}
