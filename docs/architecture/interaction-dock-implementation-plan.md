# Implementation Record: Screen + Interaction Dock Shell

- Status: Complete
- Date: 2026-03-11 (completed 2026-03-12)
- Depends on: `docs/architecture/interaction-dock-shell.md`

## Purpose

This document records the incremental refactor of the UI architecture toward a routed shell with a persistent screen area, persistent interaction dock, and overlay-managed transient UI.

---

## Prior state

Before this refactor, the UX logic was split across:

- `extensions/thread-references.ts`
  - custom editor implementation
  - picker detection and picker rendering
  - thread/file/slash/bash suggestion logic
  - transient badge behavior
- `extensions/pi-kit.ts`
  - pager behavior
  - wizard/guided-question behavior
  - UI layer stack workaround logic
  - widget-based screen-adjacent UI

### Problems addressed

1. **Picker rendering was coupled to editor rendering** — opening/closing picker changed the editor's render output directly, causing cursor drift and layout instability.

2. **Pager was not a first-class screen** — it behaved as a specialized widget + input interception layer.

3. **Layer precedence was feature-local** — pager and picker competed for dismissal/focus, requiring workaround logic.

4. **Wizard was an ad hoc takeover** — implemented as an inline ~300-line class inside `pi-kit.ts` using `ctx.ui.custom()`, outside any architectural model.

---

## Module structure

### UI infrastructure (`extensions/ui/`)

- **`shell.ts`** — `ScreenManager`, `InteractionDockController`, core types (`ScreenController`, `DockState`, `DockMetrics`, `InputSurfaceKind`)
- **`picker-overlay.ts`** — `AnchoredPickerOverlayController` using `tui.showOverlay()` for layout-independent picker rendering
- **`thread-reference-shell.ts`** — suggestion providers, editor installation, dock integration

### Input surfaces (`extensions/ui/input-surfaces/`)

- **`text-composer.ts`** — `TextComposerSurface` (extends `CustomEditor`). Handles text editing, picker trigger detection, cursor ownership. Supports `setRenderDelegate()` for alternate dock rendering (used by wizard).
- **`wizard-input.ts`** — `WizardInputSurface`. Manages question state (select/text/boolean modes), renders wizard controls for the dock. Exports `GuidedQuestion`, `GuidedQuestionnaireInput`, `normalizeQuestion`.

### Screens (`extensions/ui/screens/`)

- **`thread-screen.ts`** — `createThreadScreen()`. Default screen; sets dock to text-composer mode.
- **`pager-screen.ts`** — `openPagerScreen()`. Screen overlay for paged content; dock stays as text-composer for per-section notes. Per-section draft persistence, section navigation, scroll.
- **`wizard-screen.ts`** — `openWizardScreen()`. Screen overlay for question context/progress; dock renders wizard controls via render delegate. Returns `{ screen, result: Promise<WizardResult> }`.

### Integration

- **`extensions/pi-kit.ts`** — shell-level wiring, screen activation, `runGuidedQuestionnaire`, tool/command registration
- **`extensions/thread-references.ts`** — suggestion data, scoring, session/file indexing (no longer contains UI rendering)

---

## Input routing

Input flows through three stages with no indirection:

1. **Dock handler** — captures picker-specific keys (up/down/tab/enter/escape) when picker is open
2. **`blocksScreenInput()`** — prevents screen input while picker is open
3. **Screen manager** — routes to the active screen's `handleInput()`

If none consume the key, the TUI system sends it to the editor component (TextComposerSurface).

---

## Phase record

### Phase 0 — Guardrails
- Created architecture decision doc and implementation plan
- Established naming: shell, screen, dock, input surface, overlay

### Phase 1 — Shell and routing primitives
- `shell.ts`: `ScreenManager` with activate/deactivate/close lifecycle, `InteractionDockController` with state/metrics/input routing
- `ScreenController` interface, `DockState`/`DockMetrics` types
- Shared singletons wired into `pi-kit.ts`

### Phase 2 — Picker as true overlay
- `picker-overlay.ts`: `AnchoredPickerOverlayController` renders picker via `tui.showOverlay()` — architecturally independent from composer layout
- Picker does not affect dock geometry; visually anchored above the dock
- Suggestion model/token detection stays in the text composer; rendering is separate

### Phase 3 — TextComposerSurface
- `text-composer.ts`: extends `CustomEditor`, encapsulates text editing, picker trigger detection, draft management
- Suggestion providers injected as capabilities
- `DockState` support allows the same surface to serve thread and pager modes
- Layout metrics reported to dock controller

### Phase 4 — Pager as screen with dock binding
- `pager-screen.ts`: returns `ScreenController` via `openPagerScreen()`
- Screen overlay for paged content; dock hosts text-composer for per-section notes
- Per-section draft map with persist/load on section change
- Screen-level shortcuts: Ctrl+Shift+arrows for section/scroll, Esc to close, Enter to submit
- Dismissal guard: `blocksScreenInput()` prevents pager from handling input while picker is open

### Phase 5 — Wizard as alternate input surface
- `wizard-input.ts`: `WizardInputSurface` manages question state and renders dock controls
- `wizard-screen.ts`: `openWizardScreen()` returns screen + result Promise
- Screen overlay shows question context/progress; dock shows wizard controls via `setRenderDelegate()` on the text composer
- Wizard screen captures all input when active
- Replaced ~300-line inline `WizardComponent` in `pi-kit.ts`

### Phase 6 — Remove transitional glue
- Deleted `UiLayerStack`, `UI_LAYER_KEYS`, `sharedUiLayerStack`
- Removed `ui:layer` event emissions and listener
- Removed `setLayerOpen`/`isTopLayer` plumbing from pager and wizard screen options
- Input router simplified to: dock → `blocksScreenInput()` → screen manager

---

## State ownership

### Screen owns
- Screen-specific content state
- Screen-specific keybindings
- View-level navigation state
- Draft binding semantics

### Input surface owns
- Interaction mechanics inside the dock
- Cursor/focus behavior
- Local editing/selection mechanics
- Submit/cancel intents

### Overlay manager owns
- Transient overlay lifecycle (picker)
- Overlay visibility/dismissal
- Layout independence from dock/screen

---

## Resolved design decisions

1. **Screen-level shortcuts run after the dock input handler.** The dock gets first chance to capture keys (for picker), then the screen handles the rest.

2. **Picker anchors to the dock via layout metrics.** The text composer reports `DockMetrics` (margin, panelWidth, panelLines) on each render; the picker overlay positions itself relative to these.

3. **Wizard uses the dock via render delegate.** The `TextComposerSurface` supports `setRenderDelegate()` — when set, it renders the delegate's output instead of the text editor. This keeps the dock host generic.

4. **One `TextComposerSurface` with dock state binding.** A single surface serves both thread and pager modes; `DockState.mode` distinguishes context. No subtype needed.

5. **Suggestion logic remains in `thread-references.ts` / `thread-reference-shell.ts`.** Providers are injected into the text composer as capabilities. This keeps suggestion data feature-local while rendering is architectural.

---

## Testing checklist

### Thread mode
- Type normally
- Open slash/file/thread/bash picker
- Dismiss picker with Esc
- Continue typing after dismiss
- Submit message

### Pager
- Open pager on long content
- Navigate sections (Ctrl+Shift+←/→)
- Type per-section notes
- Switch sections and verify note persistence
- Open/dismiss picker while pager is active
- Close pager with Esc when no overlay is open

### Wizard
- Run `/wizard --demo`
- Move through select/boolean/text questions
- Navigate back (Shift+Tab) and forward (Tab/Enter)
- Cancel with Esc
- Complete and verify structured answers

### Layout/focus
- Dock remains bottom-anchored across all screens
- Picker does not resize dock
- Cursor stays owned by the active dock surface

---

## Heuristic for future features

When adding a new interaction:

1. Is this **screen content**? → Screen Area
2. Is this the user's primary bottom-region interaction? → Dock as an Input Surface
3. Is this temporary/transient UI? → Overlay Layer
4. Does it change layout when it should only change focus? → Wrong layer
