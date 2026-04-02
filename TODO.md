# pi-kit Refinement Plan

## Status

- **Phase 1: Re-enable foundations** ✅ COMPLETE
- **Phase 2: Modular extraction** ✅ COMPLETE
- **Phase 3: Revert custom UI overlay** ✅ COMPLETE
- **Phase 4: Reimplement and refine** ✅ COMPLETE
- **Phase 5: Polish** ✅ COMPLETE

---

## Commands (smoke tested ✅)

| Command | Module | Description |
|---------|--------|-------------|
| `/threads` | session-commands.ts | Manage threads — rename or delete |
| `/switch` | session-commands.ts | Switch to another thread/session |
| `/files:ignore` | ignore.ts | Add path to .pi-ignore |
| `/files:unignore` | ignore.ts | Remove path from .pi-ignore |
| `/pager` | pager/index.ts | Page through last response with per-section notes |
| `/handoff` | handoff.ts | Create child thread with compact context |
| `/wizard` | wizard.ts | Run guided questions from last assistant message |
| `/bells` | notifications.ts | Toggle bell notifications |
| `/speech` | notifications.ts | Toggle speech notifications |

**Also verified:**
- `@@` thread picker during typing
- `@@id` expansion to thread context on submit

---

## Extension Modules

| File | Responsibility |
|------|----------------|
| `pi-kit.ts` | Orchestrator — loads all modules |
| `thread-editor.ts` | `ThreadAwareEditor`, `@@` autocomplete provider |
| `thread-editor-extension.ts` | Installs custom editor at session start |
| `thread-references.ts` | `@@id` expansion to thread context |
| `session-commands.ts` | `/threads`, `/switch` |
| `ignore.ts` | `/files:ignore`, `/files:unignore` |
| `pager/index.ts` | `/pager` with per-section notes |
| `notifications.ts` | `/bells`, `/speech`, notification config |
| `session-naming.ts` | Auto session title generation |
| `handoff.ts` | `/handoff` child thread creation |
| `wizard.ts` | `guided_questions` tool, `/wizard` |
| `footer.ts` | Custom status bar |
| `protected-paths.ts` | Protected paths guard |
| `subagent/index.ts` | Subagent delegation |

---

## Config

- `~/.pi/agent/settings.json` — Pi settings (which extensions load)
- `~/.pi/agent/kit.json` — pi-kit settings (bells, speech)
