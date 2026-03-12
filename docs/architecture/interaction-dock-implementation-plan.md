# Implementation Plan: Screen + Interaction Dock Shell

- Status: Proposed
- Date: 2026-03-11
- Depends on: `docs/architecture/interaction-dock-shell.md`
- Goal: Refactor the current UI architecture toward a routed shell with a persistent screen area, persistent interaction dock, and overlay-managed transient UI

## Purpose

This document translates the architectural decision into an incremental implementation plan.

It is intentionally practical:
- what to build first
- what existing files likely change
- what temporary compatibility shims are acceptable
- what risks to watch for
- what to validate after each phase

This is a refactor plan, not a complete redesign from scratch.

---

## Current state summary

Today, the relevant UX logic is primarily split across:

- `extensions/thread-references.ts`
  - custom editor implementation
  - picker detection and picker rendering
  - thread/file/slash/bash suggestion logic
  - some transient badge behavior
- `extensions/pi-kit.ts`
  - pager behavior
  - wizard/guided-question behavior
  - UI layer stack workaround logic
  - widget-based screen-adjacent UI

### Current pain points

1. **Picker rendering is coupled to editor rendering**
   - opening/closing picker changes the editor's render output directly
   - this risks cursor drift and layout instability

2. **Pager is not a first-class screen abstraction yet**
   - it behaves more like a specialized widget + input interception layer

3. **Layer precedence is feature-local instead of architectural**
   - pager and picker both participate in dismissal/focus semantics
   - current escape behavior has required workaround logic

4. **Wizard/guided flows are implemented as small takeovers rather than a reusable screen/dock model**

---

## Refactor strategy

We should refactor in small phases that preserve the current user-facing behavior as much as possible while changing the internals decisively.

### High-level sequence

1. Introduce shell primitives and naming
2. Extract overlay management and move picker there
3. Introduce dock/input-surface abstractions around the current composer
4. Convert pager from widget-style behavior into a screen-like context using dock binding
5. Generalize wizard to a screen + alternate input surface model
6. Remove transitional glue and old layer hacks

---

## Target module shape

These module names are suggestions, not requirements, but the responsibilities should be preserved.

### New conceptual modules
- `AppShellController`
- `ScreenController` or `ScreenRegistry`
- `InteractionDockController`
- `InputSurface` types / implementations
- `OverlayManager`
- `PickerOverlayController`

### Initial input surfaces
- `TextComposerSurface`
- `WizardInputSurface` (or equivalent)
- `HiddenInputSurface`

### Initial screens
- `ThreadScreen`
- `PagerScreen`
- `WizardScreen`

---

## File mapping from current codebase

This plan assumes the current package layout:

- `extensions/pi-kit.ts`
- `extensions/thread-references.ts`
- `extensions/claude-commands.ts`
- `extensions/protected-paths.ts`
- `extensions/subagent/index.ts`

### Expected main refactor surfaces

#### `extensions/thread-references.ts`
Likely responsibilities after refactor:
- suggestion providers for slash/files/threads/bash
- token parsing for text-based surfaces
- picker data/model logic
- maybe thin integration with dock/input-surface APIs

Likely responsibilities removed from this file:
- direct picker rendering inside custom editor render path
- ad hoc picker layout composition with the editor

#### `extensions/pi-kit.ts`
Likely responsibilities after refactor:
- pager screen/controller logic
- wizard screen/controller logic
- shell-level integration and registration
- alert/status behavior that is unrelated to picker/editor rendering

Likely responsibilities reduced/removed:
- local UI layer stack hacks once a true overlay/dismiss model exists
- widget-style pager ownership of input that should instead belong to a screen/dock contract

### Possible new files/directories
A staged extraction could introduce something like:

- `extensions/ui/shell.ts`
- `extensions/ui/overlay-manager.ts`
- `extensions/ui/dock.ts`
- `extensions/ui/input-surfaces/text-composer.ts`
- `extensions/ui/input-surfaces/wizard-input.ts`
- `extensions/ui/screens/thread-screen.ts`
- `extensions/ui/screens/pager-screen.ts`
- `extensions/ui/screens/wizard-screen.ts`
- `extensions/ui/picker-overlay.ts`

The exact structure can vary, but separating UI infrastructure from feature files will help a lot.

---

## Phase plan

## Phase 0 — Refactor guardrails

### Goal
Create a safe path for the refactor before changing UX behavior.

### Work
- Preserve the architecture decision doc as source of truth
- Add implementation plan doc (this document)
- Decide naming and folder structure before moving logic
- Identify minimal smoke-test commands for the current UX

### Acceptance criteria
- Team has a stable architecture and migration reference
- Clear naming exists for shell, screen, dock, input surface, and overlay

### Validation
- none beyond doc review

---

## Phase 1 — Establish shell and routing primitives

### Goal
Introduce code-level concepts for:
- active screen
- active dock input surface
- overlay ownership

without yet changing all features at once.

### Work
1. Create a small shell controller abstraction
   - current active screen id
   - current active input surface id
   - screen activation/deactivation hooks
2. Create a dock host abstraction
   - one persistent dock region
   - mount/unmount/swap input surfaces
3. Introduce minimal types/contracts
   - `Screen`
   - `InputSurface`
   - `OverlayHandle`/overlay manager integration point

### Notes
This phase can initially wrap the current text composer implementation instead of replacing it.

### Files likely touched
- new UI infrastructure files under `extensions/ui/`
- light integration changes in `extensions/pi-kit.ts`
- light integration changes in `extensions/thread-references.ts`

### Acceptance criteria
- there is one recognized dock host concept in code
- screens can declare or switch the active input surface
- no user-visible picker/pager redesign required yet

### Validation
- type/build validation
- basic session start/switch still installs the default text input path

---

## Phase 2 — Extract picker into a true overlay

### Goal
Make picker rendering independent from editor layout.

### Work
1. Split current picker logic into two pieces:
   - suggestion model / token detection
   - visual overlay rendering + selection control
2. Keep trigger detection in the text input surface
3. Move picker rendering into overlay infrastructure
4. Anchor picker visually to the dock/input surface
5. Ensure picker open/close does not change dock geometry

### Important rule
At the end of this phase, the text composer may still open the picker, but it must **not render the picker inside its own `render()` output**.

### Files likely touched
- `extensions/thread-references.ts`
- new `extensions/ui/picker-overlay.ts`
- new or updated overlay manager infrastructure

### Acceptance criteria
- picker is an overlay, not part of text composer layout flow
- opening/closing picker does not change composer height
- closing picker does not corrupt cursor placement
- picker remains visually attached to the top of the dock

### Validation
- open picker in normal thread mode
- dismiss picker with `Esc`
- type after dismissing picker
- confirm cursor remains inside dock
- confirm dock geometry remains unchanged

### Risk
This is the highest-value phase for fixing the original UX bug, but also the most likely to reveal hidden assumptions in the current custom editor flow.

---

## Phase 3 — Wrap the current composer as `TextComposerSurface`

### Goal
Turn the existing text-oriented bottom interaction into a formal input surface.

### Work
1. Define `TextComposerSurface`
2. Move text-specific behavior behind its contract:
   - render
   - input handling
   - cursor ownership
   - draft get/set
   - submit handling hooks
   - picker trigger hooks
3. Separate reusable text surface behavior from thread-specific behavior

### Thread-specific behavior should move out of the surface
Examples:
- thread message submission policy
- pager note submission policy
- screen-specific status/help text

### Files likely touched
- extracted text surface module(s)
- `extensions/thread-references.ts`
- integration in `extensions/pi-kit.ts`

### Acceptance criteria
- the current thread flow runs through `TextComposerSurface`
- the same surface can later be rebound for pager use
- suggestion providers are consumed as capabilities rather than hard-wired layout behavior

### Validation
- normal thread input still works
- slash/file/thread/bash suggestions still work
- submit behavior remains correct in thread mode

---

## Phase 4 — Convert pager into a screen with dock binding

### Goal
Make pager a first-class screen/context rather than a widget-like augmentation.

### Work
1. Define `PagerScreen`
2. Move pager-owned state into that screen/controller:
   - active section
   - scroll state
   - note presence
   - per-section draft map
3. Bind the dock to the pager's current note draft via `TextComposerSurface`
4. Ensure section changes:
   - persist current section draft
   - load next section draft into the dock
5. Define screen-level pager shortcuts and dismissal semantics

### Desired behavior
- screen area = pager content
- dock = text input for current section note
- picker overlay still opens above dock
- `Esc` closes picker first, then pager if no overlay is open

### Files likely touched
- `extensions/pi-kit.ts`
- new `extensions/ui/screens/pager-screen.ts`
- dock/text surface integration files

### Acceptance criteria
- pager behaves as a screen, not a widget hack
- dock remains stable and bottom-anchored while pager is active
- each section has persistent logical draft state
- pager can reuse the text input surface without creating a second architectural composer system

### Validation
- open pager
- navigate sections
- type distinct notes in 2+ sections
- move away and back; verify notes persist
- open/dismiss picker while pager is active
- verify no redraw/cursor corruption

---

## Phase 5 — Introduce wizard as an alternate input-surface/screen pairing

### Goal
Prove the architecture supports a non-composer dock interaction.

### Work
1. Define `WizardScreen`
2. Decide whether the dock should host:
   - `WizardInputSurface`, or
   - `HiddenInputSurface` with all controls in the screen area
3. Port or adapt current guided question behavior into this model
4. Keep wizard interaction out of the normal text-composer assumptions

### Why this phase matters
If the architecture only works for the text composer and pager, it is still too narrow.
The wizard is the best proof that we truly support alternate dock/input patterns.

### Files likely touched
- `extensions/pi-kit.ts`
- new wizard screen/input-surface modules

### Acceptance criteria
- wizard no longer feels like a small ad hoc takeover
- wizard fits the shell model cleanly
- the architecture supports a different input surface without special-casing the whole app

### Validation
- run wizard/demo flow
- ensure select/boolean/free-text interactions behave cleanly
- confirm the screen/dock relationship is intentional and stable

---

## Phase 6 — Remove transitional hacks and simplify precedence logic

### Goal
Delete workaround code that existed because the architecture was unclear.

### Work
- remove ad hoc UI layer stack logic that is superseded by overlay/screen/dock rules
- remove double-escape workaround behavior if no longer needed
- delete legacy layout coupling between picker and composer
- remove obsolete helper paths that only supported the old render model

### Files likely touched
- mostly `extensions/pi-kit.ts`
- possibly `extensions/thread-references.ts`
- new infra files once cleanup lands

### Acceptance criteria
- dismissal/focus semantics are expressed by architecture, not workarounds
- dead transitional code is removed
- code ownership boundaries are clearer than before refactor

### Validation
- regression pass across thread, pager, and wizard flows

---

## Suggested interface shape

These are conceptual examples for planning, not exact APIs.

## `Screen`
Should likely provide:
- `id`
- `activate(ctx)`
- `deactivate(ctx)`
- `renderScreen?()` or a way to bind screen content
- `getInputSurfaceSpec()`
- `handleKey?()` for screen-level shortcuts
- `canDismiss?()` / `dismiss?()`

## `InputSurface`
Should likely provide:
- `id`
- `render(width)`
- `handleInput(data)`
- `focus()/blur()` or equivalent focus lifecycle
- `getCursorAnchor?()` if needed for overlay positioning
- `loadState(spec)` / `updateBinding(spec)`
- `submit()` / `cancel()` behavior hooks
- `dispose()`

## `OverlayManager`
Should likely provide:
- `openOverlay(key, component, options)`
- `closeOverlay(key)`
- `getTopOverlay()`
- `dismissTopmost()`
- anchor support relative to dock/input surface

---

## State ownership guidance

This is critical during implementation.

### Screen owns
- screen-specific content state
- screen-specific keybindings
- view-level navigation state
- meaning of draft binding

### Input surface owns
- interaction mechanics inside the dock
- cursor/focus behavior for that surface
- local editing/selection mechanics
- emitting submit/cancel/intents

### Overlay manager owns
- transient overlay lifecycle
- topmost precedence
- overlay visibility/dismissal
- z-order and layout independence

### Do not blur these boundaries
Common mistake patterns to avoid:
- screen rendering the picker directly
- input surface simulating screen navigation state
- overlay lifecycle embedded inside a screen widget render path

---

## Testing plan

We should validate each phase with concrete UX checks.

### Core thread mode checks
- type normally in thread mode
- open slash/file/thread/bash picker
- dismiss picker with `Esc`
- continue typing
- submit message

### Pager checks
- open pager on long content
- navigate sections
- type per-section notes
- switch sections and confirm note persistence
- open picker while pager is active
- dismiss picker cleanly
- close pager with one `Esc` when no overlay is open

### Wizard checks
- run wizard flow
- move through select/boolean options
- enter free text when needed
- submit/cancel cleanly

### Layout/focus checks
- dock remains bottom-anchored
- picker does not resize dock
- cursor remains owned by the active dock surface
- topmost dismissible layer handles `Esc`

---

## Rollout guidance

### Recommended order of user-facing wins
If we want the biggest UX payoff early:

1. **Picker overlay extraction**
2. **Pager as a real screen/context**
3. **Input surface abstraction and wizard generalization**

This sequence most directly fixes the currently broken feel before broadening the architecture further.

---

## Open questions to settle during implementation

These are not blockers for the plan, but they should be answered as code takes shape.

1. Should screen-level shortcuts always run after the active input surface, or can screens opt into intercepting first?
2. What exact overlay anchor data should the dock/input surface expose to attach the picker visually?
3. Should wizard always use the dock, or should some wizard flows hide the dock entirely?
4. Do we want one generic `TextComposerSurface` with bindings, or a small subtype/wrapper for pager notes?
5. How much of today's `thread-references.ts` suggestion logic should remain feature-local versus moved into reusable UI infra?

---

## Recommended immediate next step

Begin with **Phase 1 + Phase 2 together**:
- establish enough shell/dock/overlay structure to support a true picker overlay
- move picker rendering out of the current custom editor render path

This is the smallest slice that aligns the code with the architecture and directly addresses the current UX failure.

---

## Rule of thumb during refactor

If a feature is causing layout instability but should only be changing focus or transient visibility, it probably belongs in the overlay layer rather than in the dock or screen render tree.
