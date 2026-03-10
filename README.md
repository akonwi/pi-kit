# @akonwi/pi-kit

Source-of-truth Pi package for my setup.

## Includes

- Extensions:
  - `extensions/protected-paths.ts`
  - `extensions/pi-kit.ts`
  - `extensions/thread-references.ts`
  - `extensions/subagent/index.ts`
- Prompt templates:
  - `prompts/plan.md`
  - `prompts/implement.md`
- Theme:
  - `themes/akonwi-dark.json`
- Bundled subagent profile:
  - `extensions/subagent/agents/ard-expert.md`

## Local install

```bash
pi install /Users/akonwi/Developer/agent/pi-kit
```

Then in Pi:

```text
/reload
```

## Notes

- This package is the shared source-of-truth.
- Machine-local changes can still be made directly in `~/.pi/agent` (settings, local overrides, auth/sessions).

## File picker ignores

To prune large repos for the `@` file picker, add a repo-local `.pi-files-ignore` file at the project root (the session cwd).

Example:

```txt
# ignore noisy build output
.next/
coverage/
out/
packages/*/dist/
packages/*/build/
*.log
```

Rules:
- blank lines and lines starting with `#` are ignored
- `name/` ignores directories with that name anywhere in the repo
- `*.log` matches file or directory names by segment
- `packages/*/dist/` matches relative paths from the repo root
- built-in excludes still apply: `.git/`, `node_modules/`, `.pi/`, `.agents/`, `dist/`, `build/`

You can also add entries from inside Pi:

```text
/files:ignore apps/web/.next
/files:ignore packages/api/dist
```

The command finds the nearest existing `.pi-files-ignore` up the tree from the target path and appends the rule there. If none exists yet, it creates one at the session root.
