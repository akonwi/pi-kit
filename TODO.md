# pi-kit Refinement Plan

## Status

- **Phase 1: Re-enable foundations** ✅ COMPLETE
- **Phase 2: Modular extraction** ✅ COMPLETE
- **Phase 3: Revert custom UI overlay** ✅ COMPLETE
- **Phase 4: Reimplement and refine** ✅ COMPLETE
- **Phase 5: Polish** — Not started

---

## Phase 4 Complete (2024-04-02)

### Thread references with `@@` prefix ✅

- `ThreadAwareEditor` wraps Pi's autocomplete provider
- `@@` triggers thread picker during typing (like `@` for files)
- Thread fuzzy search by ID, name, cwd, first message
- `@@id` expands to thread context on input
- `/threads` command browses threads and inserts reference

### Pager with per-section notes ✅

- Uses `ctx.ui.custom()` with embedded `Editor` for notes
- Markdown rendering with `Markdown` component from pi-tui
- Section-by-section navigation (`h`/`l`)
- Note-taking per section (`n` to edit)
- `Ctrl+Enter` submits notes as structured feedback
- Visual indicators: `○` empty, `●` has note, `◆` current

### Consolidated commands ✅

- Removed duplicate `/threads` command (was in both files)
- `/threads` now lives in `thread-references.ts`
- `/switch` and `/threads:manage` in `session-commands.ts`
- `/files:ignore` and `/files:unignore` in `thread-references.ts`

---

## Phase 5: Polish — Not started

- Verify all commands work correctly
- Clean up unused code paths
- Update documentation
- Consider adding tests for critical paths

---

## Extension Modules

| File | Commands/Features |
|------|-------------------|
| `pi-kit.ts` | Orchestrator, loads all modules |
| `thread-editor.ts` | `ThreadAwareEditor`, `ThreadAwareAutocompleteProvider` |
| `thread-editor-extension.ts` | Installs custom editor at session start |
| `thread-references.ts` | `@@id` expansion |
| `ignore.ts` | `/files:ignore`, `/files:unignore` |
| `session-commands.ts` | `/threads` (manage), `/switch` |
| `pager/index.ts` | `/pager` with notes |
| `notifications.ts` | `/bells`, `/speech` |
| `session-naming.ts` | Auto session titles |
| `handoff.ts` | `/handoff` for child threads |
| `wizard.ts` | `guided_questions` tool, `/wizard` |
| `footer.ts` | Custom status bar |
| `protected-paths.ts` | Protected paths guard |
| `subagent/index.ts` | Subagent delegation |

---

## Config files

- `~/.pi/agent/settings.json` — global Pi settings (controls which extensions are loaded)
- `~/.pi/agent/kit.json` — pi-kit specific settings (bells, speech config)