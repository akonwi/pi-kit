# @akonwi/pi-kit

My Pi extension suite. Single entry point: `extensions/pi-kit.ts`.

## Install

```bash
pi install /Users/akonwi/Developer/agent/pi-kit
```

## Extensions

All loaded through `extensions/pi-kit.ts`:

| Module | Features |
|--------|----------|
| `thread-references.ts` | `@@id` expands to thread context in prompts |
| `thread-editor.ts` + `thread-editor-extension.ts` | `@@` triggers thread picker in composer |
| `session-commands.ts` | `/threads` (manage), `/switch` |
| `ignore.ts` | `/files:ignore`, `/files:unignore` |
| `pager/index.ts` | `/pager` — page through long responses with per-section notes |
| `handoff.ts` | `/handoff` — create child thread with compact context |
| `wizard.ts` | `/wizard`, `guided_questions` tool |
| `notifications.ts` | `/bells`, `/speech` |
| `session-naming.ts` | Auto session title generation |
| `footer.ts` | Custom status bar |
| `protected-paths.ts` | Protected paths guard |
| `claude-commands.ts` | Claude-specific commands |

External packages loaded separately:
- [`npm:pi-subagents`](https://github.com/nicobailon/pi-subagents) — `subagent` tool with single/parallel/chain modes

## Prompt templates

- `prompts/plan.md`
- `prompts/implement.md`

## Thread references

Type `@@` in the composer to trigger a fuzzy thread picker. Select a thread to insert `@@<id>`.

When you submit a message containing `@@<id>`, it expands to a context block from that thread:

```
[Thread Context]
id: abc12345
title: My other thread
cwd: ~/projects/foo
---
User: what does this function do?
Assistant: It parses...
```

## File picker ignores

Add a `.pi-ignore` file at your project root to prune large repos from the `@` file picker.

```txt
.next/
coverage/
packages/*/dist/
*.log
```

Manage entries from inside Pi:

```
/files:ignore apps/web/.next
/files:unignore packages/api/dist
```

- Adds to / removes from the nearest `.pi-ignore` up the directory tree
- Creates one at the session root if none exists

## Notes

- Machine-local changes go in `~/.pi/agent` (settings, auth, sessions)
- Custom agents live in `~/.pi/agent/agents/`
