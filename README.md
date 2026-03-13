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

To prune large repos for the `@` file picker, add a repo-local `.pi-ignore` file at the project root (the session cwd).

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
- legacy `.pi-files-ignore` files are deprecated and ignored until renamed to `.pi-ignore`

You can also manage entries from inside Pi:

```text
/files:ignore apps/web/.next
/files:ignore packages/api/dist
/files:unignore packages/api/dist
```

- `/files:ignore` adds to the nearest existing `.pi-ignore` up the tree from the target path; if none exists yet, it creates one at the session root
- `/files:unignore` removes the matching entry from the nearest applicable ignore file
- running either command with no path opens an interactive picker
