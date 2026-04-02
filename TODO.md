# pi-kit Refinement Plan

## Status

- **Phase 1: Re-enable foundations** ✅ COMPLETE
- **Phase 2: Modular extraction** ✅ COMPLETE
- **Phase 3: Selective v2 ports** — Not started
- **Phase 4: Polish** — Not started

## Recent Changes

### Phase 2 Completed (2024-04-02)

The monolithic `extensions/pi-kit.ts` (~1200 lines) has been refactored into focused modules:

```
extensions/
├── pi-kit.ts              # Thin orchestrator (~140 lines)
├── notifications/
│   └── index.ts           # /bells, /speech commands, config management
├── session-naming/
│   └── index.ts           # Auto session title generation
├── handoff/
│   └── index.ts           # /handoff command
├── wizard/
│   └── index.ts           # guided_questions tool, /wizard command
├── pager/
│   ├── index.ts           # /pager command
│   └── split-sections.ts   # Section parsing (unchanged)
├── session-commands/
│   └── index.ts           # /threads, /switch, /threads:manage
├── footer/
│   └── index.ts            # Custom status bar
└── ...existing modules...
```

Each module is self-contained with its own:
- Extension factory function (`default export`)
- Helper functions (internal or exported as needed)
- Command/tool registrations
- Event handlers

The main `pi-kit.ts` now:
1. Imports all feature modules
2. Sets up dock controller and screen input routing
3. Wires lifecycle events (`session_start`, `session_switch`, etc.)
4. Delegates to feature modules"edits to make it deontological

## Context

This repo contains two related efforts:

1. **Root package** (`@akonwi/pi-kit`) — a Pi extension package meant to plug into normal Pi
2. **`v2/`** — a standalone terminal app experiment that built a custom UI shell around Pi internals

The `v2` experiment is **not the future product**. However, it contains cleaner implementations and better module boundaries for many features.

**Goal:** Re-center on the extension package as the real artifact, mining `v2` selectively for improvements without adopting its UI/shell architecture.

---

## Current State

- The extension package is installed but **partially disabled** in `~/.pi/agent/settings.json`
- `extensions/pi-kit.ts` (the main UX extension) is **not in the active extensions list**
- Active extensions: `protected-paths`, `thread-references`, `subagent`
- Inactive: `pi-kit.ts`, `claude-commands.ts`

---

## A. Keep As-Is

These are already solid and don't need major rework:

### `extensions/protected-paths.ts`
- Blocks edits/writes to sensitive files (`.env*`, `.ssh/*`, `*.pem`, lockfiles, etc.)
- Clean, orthogonal, low-risk
- **Action:** No changes needed

### `extensions/subagent/index.ts`
- Subagent tool (single/parallel/chain modes)
- Agent discovery from user/project scopes
- Rich output formatting and usage stats
- **Action:** No changes needed, optionally consider v2's module split if it improves clarity

### `extensions/thread-references.ts`
- Thread reference expansion (`[[thread:id]]`)
- Session listing/discovery
- `.pi-ignore` support and `/files:ignore` `/files:unignore` commands
- **Action:** Keep, possibly extract scoring/indexing helpers into separate module

### `prompts/plan.md`, `prompts/implement.md`
- Custom prompt templates
- **Action:** Keep as-is

### `themes/akonwi-dark.json`
- Custom theme
- **Action:** Keep as-is

---

## B. Re-enable + Refine

These are currently in `extensions/pi-kit.ts` (disabled) and should be brought back, but with more modular structure:

### 1. Notifications (bells + speech)
- `/bells` and `/speech` commands
- Config persistence in `~/.pi/agent/kit.json`
- Terminal bell on completion
- Speech synthesis for assistant responses
- **v2 equivalent:** `v2/src/features/notification-config.ts`, `v2/src/features/notifications.ts`, `v2/src/features/commands/bells-speech.ts`
- **Refinement:** Extract into `extensions/notifications/` module

### 2. Footer/Status Customization
- Custom footer showing cwd, git branch, session name, model, context %
- Bell/speech status indicators
- **v2 equivalent:** `v2/src/shell/BottomStatusBar.tsx`
- **Refinement:** Keep minimal, ensure it plays well with Pi's native footer hooks

### 3. Session/Thread Management
- `/threads` — session picker with reference insertion
- `/switch` — switch to another session
- `/threads:manage` — rename/delete sessions
- **v2 equivalent:** `v2/src/features/commands/sessions-manage.ts`, `v2/src/features/commands/switch.ts`
- **Refinement:** Determine if v2's session management UX patterns are worth porting

### 4. Handoff
- `/handoff` — create child thread with compact context
- Current implementation: simple message clipping
- **v2 equivalent:** `v2/src/features/commands/handoff.ts` — uses LLM-generated summary via `generateSummary(...)`
- **Port from v2:** Use LLM-generated summaries instead of naive clipping

### 5. Pager
- `/pager` — view/annotate long assistant responses by section
- Section navigation and per-section feedback notes
- **v2 equivalent:** `v2/src/features/pager/*`, `v2/src/shell/PagerView.tsx`
- **Refinement:** Keep the extension-native screen/overlay approach, ensure it still works with current Pi TUI APIs

### 6. Guided Questions / Wizard
- `guided_questions` tool for structured multi-question flows
- `/wizard` command to run questionnaires from last assistant message
- **v2 equivalent:** `v2/src/features/wizard/*`
- **Refinement:** Consider v2's cleaner tool encapsulation pattern

### 7. Auto Session Naming
- Auto-generates session titles after sufficient conversation depth
- **v2 equivalent:** `v2/src/features/session-naming/auto-name.ts`
- **Refinement:** Ensure cooldown and prompt are tuned appropriately

---

## C. Port Selectively from v2

These are improvements in `v2` worth bringing back to the extension:

### 1. LLM-Generated Handoff Summaries
- **File:** `v2/src/features/commands/handoff.ts`
- **What:** Uses `generateSummary()` from Pi's agent session API to create better handoff context
- **Why:** More useful than naive message clipping for child threads
- **Port:** Adapt the summary generation logic to the extension's handoff command

### 2. Cleaner Feature Module Boundaries
- **What:** `v2` splits features into `features/<domain>/*` with clear exports
- **Why:** `extensions/pi-kit.ts` is monolithic (~1200 lines)
- **Port:** Split into `extensions/<feature>/index.ts` style modules, re-export from a thin `extensions/pi-kit.ts` that just wires them together

### 3. Improved Command/Tool Registration Patterns
- **What:** `v2/src/features/commands/types.ts` defines a clean `Command` interface
- **Why:** Consistent command handler shape, easier testing
- **Port:** Consider a shared command/tool registration helper in the extension

### 4. Session Indexing Improvements
- **What:** `v2/src/features/threads/thread-index.ts` has a cleaner ThreadIndex API
- **Why:** Better separation of indexing from picker UI
- **Port:** Merge indexing improvements into `extensions/thread-references.ts` or separate `extensions/indexing/`

---

## D. Drop / Defer

These are `v2`-specific and should not be ported:

### Drop entirely
- `v2/src/app/*` — standalone bootstrap/app
- `v2/src/shell/*` — custom terminal UI shell
- `v2/src/backend/runtime/*` — runtime wrapper abstraction
- `v2/src/state/*` — SolidJS store state management
- OpenTUI/Solid component architecture

### Defer until needed
- Any new commands that don't have extension equivalents
- Palette/app-level UX patterns that don't translate to Pi's extension model

---

## Principles

1. **Extension-native first** — Prefer Pi's extension APIs over custom UI layers
2. **Modular over monolithic** — Split `pi-kit.ts` into focused feature modules
3. **Port clean implementations** — Bring back better code from v2 where it improves maintainability
4. **Avoid UX baggage** — Don't import v2's shell/UI architecture
5. **Preserve compatibility** — Ensure existing configs (bells, speech, handoff) continue to work

---

## Suggested Execution Order

### Phase 1: Re-enable foundations
1. Enable `extensions/pi-kit.ts` in settings (will need testing)
2. Audit what currently breaks or is outdated
3. Fix integration issues with current Pi version

### Phase 2: Modular extraction
4. Extract notifications into `extensions/notifications/index.ts`
5. Extract footer/status into `extensions/footer/index.ts`
6. Extract pager into `extensions/pager/index.ts`
7. Extract wizard/guided_questions into `extensions/wizard/index.ts`
8. Extract handoff into `extensions/handoff/index.ts`
9. Extract session management commands into `extensions/session-commands/index.ts`

### Phase 3: Selective v2 ports
10. Port LLM-generated handoff summaries from v2
11. Review and port any cleaner indexing/thread logic from v2
12. Consider v2's command type patterns if they improve consistency

### Phase 4: Polish
13. Verify all commands work correctly after refactor
14. Update documentation (README, inline comments)
15. Consider adding a simple test harness for critical paths

---

## Files Reference

### Active extensions (currently enabled)
- `extensions/protected-paths.ts`
- `extensions/thread-references.ts`
- `extensions/subagent/index.ts`

### Disabled extensions (to re-enable/refine)
- `extensions/pi-kit.ts` — main UX extension (monolithic)
- `extensions/claude-commands.ts` — Claude command bridge

### v2 equivalents to consider
- `v2/src/features/commands/handoff.ts` — better handoff summaries
- `v2/src/features/notifications.ts` — notification implementation
- `v2/src/features/wizard/tool.ts` — cleaner tool encapsulation
- `v2/src/features/threads/expand-references.ts` — thread expansion
- `v2/src/features/session-naming/auto-name.ts` — auto naming
- `v2/src/features/pager/*` — pager module structure

### Config files
- `~/.pi/agent/settings.json` — global Pi settings (controls which extensions are loaded)
- `~/.pi/agent/kit.json` — pi-kit specific settings (bells, speech config)