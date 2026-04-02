# pi-kit Refinement Plan

## Status

- **Phase 1: Re-enable foundations** ✅ COMPLETE
- **Phase 2: Modular extraction** ✅ COMPLETE
- **Phase 3: Revert custom UI overlay** ✅ COMPLETE
- **Phase 4: Reimplement and refine** — In progress
- **Phase 5: Polish** — Not started

---

## Phase 2 Complete (2024-04-02)

The monolithic `extensions/pi-kit.ts` (~1200 lines) has been refactored into focused modules:

```
extensions/
├── pi-kit.ts              # Thin orchestrator (~70 lines)
├── notifications.ts       # /bells, /speech commands, config management
├── session-naming.ts      # Auto session title generation
├── handoff.ts             # /handoff command
├── wizard.ts               # guided_questions tool, /wizard command
├── pager/index.ts         # /pager command
├── session-commands.ts     # /threads, /switch, /threads:manage
├── footer.ts              # Custom status bar
└── ...existing (protected-paths, thread-references, subagent, etc.)
```

Each module is self-contained with its own:
- Extension factory function (`default export`)
- Helper functions (internal or exported as needed)
- Command/tool registrations
- Event handlers

The main `pi-kit.ts` now:
1. Imports all feature modules
2. Delegates to feature modules

---

## Phase 3 Complete (2024-04-02)

Removed custom UI overlay system and migrated to Pi's native UI primitives:

### Removed

- `ui/shell.ts` - ScreenManager, InteractionDockController
- `ui/thread-reference-shell.ts` - custom editor installation
- `ui/input-surfaces/text-composer.ts` - custom composer
- `ui/input-surfaces/wizard-input.ts` - wizard input surface
- `ui/picker-overlay.ts` - anchored picker overlay
- `ui/screens/filter-picker-screen.ts` - custom picker screen
- `ui/screens/pager-screen.ts` - custom pager screen
- `ui/screens/text-input-screen.ts` - custom text input
- `ui/screens/thread-screen.ts` - custom thread screen
- `ui/screens/wizard-screen.ts` - custom wizard screen

### Migrated

- **session-commands.ts**: Now uses `ctx.ui.select()` and `ctx.ui.input()` for pickers
- **wizard.ts**: Now uses `ctx.ui.select()` and `ctx.ui.input()` for questions
- **pager/index.ts**: Simplified to use `ctx.ui.editor()` for display
- **pi-kit.ts**: Removed all custom UI wiring
- **thread-references.ts**: Removed custom editor integration

### Result

The extension now uses Pi's native UI:
- `ctx.ui.select()` for thread picker
- `ctx.ui.input()` for text input (rename)
- `ctx.ui.confirm()` for confirmations (delete)
- `ctx.ui.editor()` for multi-line display (pager)
- `ctx.ui.notify()` for notifications

---

## Phase 4: Reimplement and refine — In Progress

### Thread references with `@@` prefix ✅ DONE

Changed from `[[thread:id]]` to `@@id` syntax:
- `@@id` in user input expands to thread context block
- `/threads` command inserts `@@id` reference
- Matches Pi's `@path/to/file` syntax for consistency
- Removed `showTransientBadge` (replaced with `ctx.ui.notify`)

### Pager UX improvement — TODO

Current implementation uses `ctx.ui.editor()` which loses:
- Markdown rendering
- Section navigation
- Per-section note-taking
- Proper paging controls

Options:
1. Use `ctx.ui.custom()` with a custom pager component
2. Stream content to a temp file and open with `$PAGER`
3. Simplify: just notify that content is long and let user view externally

### Theme removal ✅ DONE

Removed `themes/akonwi-dark.json` - out of scope for this extension.

---

## Phase 5: Polish — Not started

- Verify all commands work correctly
- Clean up unused code paths
- Update documentation
- Consider adding tests for critical paths

---

## Files Reference

### Active extensions (currently enabled)
- `extensions/protected-paths.ts`
- `extensions/thread-references.ts`
- `extensions/subagent/index.ts`
- `extensions/pi-kit.ts`
- `extensions/claude-commands.ts`

### Extension modules
- `extensions/notifications.ts` — bells/speech config and commands
- `extensions/session-naming.ts` — auto session titles
- `extensions/handoff.ts` — child thread creation
- `extensions/wizard.ts` — guided_questions tool
- `extensions/pager/index.ts` — long response viewer
- `extensions/session-commands.ts` — thread management commands
- `extensions/footer.ts` — custom status bar

### Config files
- `~/.pi/agent/settings.json` — global Pi settings (controls which extensions are loaded)
- `~/.pi/agent/kit.json` — pi-kit specific settings (bells, speech config)