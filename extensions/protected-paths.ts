import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const PROTECTED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock"
]);

const PROTECTED_DIR_SEGMENTS = ["/.ssh/", "/secrets/", "/private-keys/"];

function normalizeInputPath(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

function getProtectionReason(rawPath: string, cwd: string): string | undefined {
  const inputPath = normalizeInputPath(rawPath);
  const abs = path.resolve(cwd, inputPath);
  const normalized = abs.split(path.sep).join("/").toLowerCase();
  const base = path.basename(abs).toLowerCase();

  if (PROTECTED_BASENAMES.has(base)) {
    return `protected file: ${base}`;
  }

  if (base.startsWith(".env.")) {
    return `protected env file: ${base}`;
  }

  if (base.endsWith(".pem") || base.endsWith(".key")) {
    return `protected key material: ${base}`;
  }

  for (const seg of PROTECTED_DIR_SEGMENTS) {
    if (normalized.includes(seg)) {
      return `protected directory: ${seg}`;
    }
  }

  return undefined;
}

function looksLikeMutatingBash(command: string): boolean {
  return (
    />{1,2}\s*\S/.test(command) ||
    /\btee\b/.test(command) ||
    /\bsed\s+-i\b/.test(command) ||
    /\bperl\s+-i\b/.test(command) ||
    /\btouch\b/.test(command) ||
    /\brm\b/.test(command) ||
    /\bmv\b/.test(command) ||
    /\bcp\b/.test(command) ||
    /\btruncate\b/.test(command)
  );
}

function mentionsProtectedTarget(command: string): boolean {
  const c = command.toLowerCase();
  return (
    c.includes(".env") ||
    c.includes(".ssh/") ||
    c.includes("secrets/") ||
    c.includes("private-keys/") ||
    c.includes("id_rsa") ||
    c.includes("id_ed25519") ||
    c.includes(".pem") ||
    c.includes(".key") ||
    c.includes("package-lock.json") ||
    c.includes("pnpm-lock.yaml") ||
    c.includes("yarn.lock") ||
    c.includes("bun.lock")
  );
}

export default function protectedPathsExtension(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Emergency bypass if explicitly set:
    // PI_ALLOW_PROTECTED_WRITES=1
    if (process.env.PI_ALLOW_PROTECTED_WRITES === "1") return;

    if (isToolCallEventType("write", event)) {
      const reason = getProtectionReason(event.input.path, ctx.cwd);
      if (reason) {
        return {
          block: true,
          reason: `Blocked write to ${event.input.path} (${reason}).`
        };
      }
      return;
    }

    if (isToolCallEventType("edit", event)) {
      const reason = getProtectionReason(event.input.path, ctx.cwd);
      if (reason) {
        return {
          block: true,
          reason: `Blocked edit of ${event.input.path} (${reason}).`
        };
      }
      return;
    }

    // Light protection for obvious mutating bash commands targeting protected paths.
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command ?? "";
      if (looksLikeMutatingBash(cmd) && mentionsProtectedTarget(cmd)) {
        return {
          block: true,
          reason:
            "Blocked bash command that appears to mutate a protected path/file. " +
            "Set PI_ALLOW_PROTECTED_WRITES=1 only if you intentionally want to bypass."
        };
      }
    }
  });
}
