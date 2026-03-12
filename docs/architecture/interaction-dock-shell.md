# Architecture Decision: Screen + Interaction Dock Shell

- Status: Implemented
- Date: 2026-03-11 (implemented 2026-03-12)
- Scope: Pi kit UI architecture for thread view, pager, wizard, and future interactive screens

## Summary

The UI is structured around a persistent application shell with three layers:

1. **Screen Area** — the main content area above the dock
2. **Interaction Dock** — a persistent bottom-anchored interaction region
3. **Overlay Layer** — transient, top-priority UI such as pickers and dialogs

The dock remains a stable layout region, but it does **not** always host the same input implementation. Instead, each active screen selects an **Input Surface** for the dock.

This replaced the narrower mental model of "one composer everywhere" with a broader model:

- there is one persistent **dock region**
- the dock hosts different **input surfaces** depending on context
- transient UI is rendered as overlays, not as part of screen or dock layout flow

---

## Why this decision exists

The previous architecture exposed foundational problems:

- picker UI was entangled with the editor/composer render path
- pager, picker, and composer competed for focus and escape handling
- transient UI affected layout and cursor behavior in ways that felt unstable
- the system did not generalize to contexts like wizard-style screens

The goals that drove this decision:

- the bottom interaction area should feel stable and foundational
- the content above it should be free to change by mode/screen
- transient UI like the picker should be visually attached where appropriate but architecturally independent
- new screens should be possible without recreating the same focus and layout problems

---

## Glossary

### App Shell
The root layout and input-routing framework for the session UI.

### Screen Area
The region above the dock. The active screen owns this area.

Examples:
- thread/transcript view
- pager view
- wizard view
- future review/search/task screens

### Interaction Dock
The persistent bottom region used for interacting with the active screen.

Important: the dock is a stable layout region, but not necessarily a single hard-coded composer implementation.

### Input Surface
The concrete interaction implementation mounted inside the dock.

Examples:
- `TextComposerSurface`
- `WizardInputSurface`
- `ChoiceInputSurface`
- `HiddenInputSurface`

### Overlay Layer
A separate transient UI layer above the shell.

Examples:
- picker
- dialogs
- menus
- temporary popovers

---

## Decision

### 1. The app uses a routed shell
The UI is a shell with:

- **Screen Area** on top
- **Interaction Dock** fixed at the bottom
- **Overlay Layer** above both

### 2. Screens own the screen area
Each screen controls the content and interaction model of the screen area.

Examples:
- `ThreadScreen`
- `PagerScreen`
- `WizardScreen`

### 3. Screens select the dock input surface
Each screen decides what kind of input surface the dock should host.

This may be:
- the normal text composer
- a wizard-specific response surface
- a choice-driven surface
- no input surface at all

### 4. Overlays are not part of screen or dock layout flow
Transient UI must live in the overlay layer.

This is a hard architectural rule for anything that should not affect layout stability.

### 5. The picker is a true overlay
The picker:
- renders with the highest priority among transient UI relevant to the dock interaction
- is visually attached to the top edge of the dock/input surface
- is **not** a sibling in the dock's internal layout flow
- does **not** resize the dock
- does **not** resize the screen

Visually attached, architecturally floating.

---

## Core Principles

### Stable shell, variable content
The shell remains stable while screen content and dock behavior vary by context.

### One dock region, many input surfaces
The dock is a standardized region, not a single implementation of its contents.

### Transient UI never drives layout
Pickers, menus, and dialogs are overlays, not embedded layout participants.

### Screen changes do not imply new architectural rules
Pager, wizard, and future screens fit into the same shell model rather than inventing custom one-off stacks.

### Focus and dismissal are explicit
The system has clear ownership of:
- focus
- cursor
- key precedence
- escape/dismiss behavior

---

## Invariants

These hold true across the implementation and future iteration.

### Shell invariants
1. There is one persistent **Screen Area**.
2. There is one persistent **Interaction Dock**.
3. There is one **Overlay Layer** above them.

### Dock invariants
4. The dock is bottom-anchored.
5. The dock is the only persistent bottom interaction region.
6. The dock may swap input surfaces, but the dock region itself should remain conceptually stable.

### Overlay invariants
7. Overlays do not participate in screen or dock layout flow.
8. The picker is always implemented as an overlay.
9. The picker may visually attach to the dock, but it does not alter dock geometry.

### Input invariants
10. At any moment, one active input surface owns primary input inside the dock.
11. Cursor ownership must be clear and consistent for the active surface.
12. Escape always dismisses the topmost dismissible layer first.

---

## Screen Model

A screen is the active mode/view occupying the screen area.

A screen is responsible for:
- rendering its main content in the screen area
- defining screen-specific state and keybindings
- selecting the dock's input surface
- supplying screen-specific behavior/configuration to that input surface
- participating in lifecycle when activated/deactivated

A screen is **not** responsible for:
- implementing the global overlay stack itself
- embedding transient overlay UI into its own layout when that UI should float
- creating a bespoke bottom layout system outside the dock contract

---

## Input Surface Model

An input surface is the dock implementation for the active screen.

Examples:

### Text Composer Surface
Used for:
- thread input
- pager notes
- other freeform text interactions

Capabilities:
- text editing
- cursor rendering/ownership
- draft binding
- submit behavior
- suggestion trigger detection
- overlay anchoring for picker
- render delegation (for wizard to take over dock rendering)

### Wizard Input Surface
Used for:
- structured choices
- yes/no selection
- occasional free text
- guided workflows where the dock remains present but the interaction style differs from freeform composition

Capabilities:
- option focus
- constrained navigation
- auxiliary free-text field
- step confirmation/cancel behavior

### Hidden Input Surface
Used when the active screen should control the entire experience without dock interaction.

---

## Contracts

### Screen contract (`ScreenController`)
A screen declares:
- what it renders in the screen area
- what input surface the dock hosts
- what keys it intercepts
- what happens on submit/cancel/escape when no overlay is open

### Input surface contract
An input surface declares:
- how it renders inside the dock
- how it handles input
- whether it owns a cursor/focus target
- how it loads and persists state
- whether it supports anchored overlays such as the picker
- what submit means in its current context

### Overlay contract
The overlay system:
- opens/closes overlays via `tui.showOverlay()`
- prevents overlays from affecting layout geometry
- allows visual anchoring relative to the dock/input surface

---

## Key Routing and Dismissal

Key handling follows explicit priority:

1. **Dock handler** — captures picker-specific keys when picker is open
2. **`blocksScreenInput()`** — prevents screen input while picker is active
3. **Active Screen** — handles screen-level shortcuts (pager nav, wizard controls, escape)
4. **Editor/Input Surface** — handles remaining keys (text editing, typing)

### Escape rule
`Esc` dismisses the topmost dismissible layer first:
- picker open → close picker
- pager/wizard active with no overlay → screen handles close/cancel
- otherwise → fallback/default behavior

---

## How this applies to current and planned UX

### Thread screen
**Screen Area:** transcript / thread content

**Dock Input Surface:** `TextComposerSurface`

**Behavior:**
- draft is the normal thread draft
- submit sends a normal user message
- picker is available as an anchored overlay

### Pager screen
**Screen Area:** paged long-form content and section status

**Dock Input Surface:** `TextComposerSurface` with `mode: "pager"`

**Behavior:**
- active section determines which draft is bound
- each section has its own logical note state
- switching sections auto-saves current draft and loads the next section's draft
- submit compiles and sends structured feedback from all non-empty section drafts
- picker remains an overlay attached to the dock, not part of pager layout

### Wizard screen
**Screen Area:** question context, progress, helper text (screen overlay)

**Dock Input Surface:** `WizardInputSurface` via render delegate on `TextComposerSurface`

**Behavior:**
- uses constrained controls (select lists, boolean, text input) instead of freeform composer
- wizard screen captures all input; text composer is passive
- returns structured answers via Promise

---

## Important non-goals

These are patterns we should avoid.

### Non-goal: embedded picker layout
Do not implement the picker as part of the text composer's internal render stack if doing so changes layout, geometry, or cursor behavior.

### Non-goal: per-screen custom dock systems
Do not let each screen invent a brand new bottom interaction architecture. The shell and dock should remain shared framework concepts.

### Non-goal: naming everything a composer
Not every dock interaction implementation is meaningfully a composer. The broader term is **Input Surface**.

---

## Module layout

### UI infrastructure (`extensions/ui/`)
- `shell.ts` — `ScreenManager`, `InteractionDockController`, core types
- `picker-overlay.ts` — `AnchoredPickerOverlayController`
- `thread-reference-shell.ts` — suggestion providers, editor installation, dock integration

### Input surfaces (`extensions/ui/input-surfaces/`)
- `text-composer.ts` — `TextComposerSurface` (text editing, picker triggers, render delegation)
- `wizard-input.ts` — `WizardInputSurface` (question state, select/text/boolean controls)

### Screens (`extensions/ui/screens/`)
- `thread-screen.ts` — default screen, sets dock to text-composer mode
- `pager-screen.ts` — paged content with per-section notes
- `wizard-screen.ts` — guided questionnaire with dock render delegation

### Integration
- `extensions/pi-kit.ts` — shell wiring, screen activation, tool/command registration
- `extensions/thread-references.ts` — suggestion data, scoring, session/file indexing

---

## Heuristic for future features

When adding a new interaction, ask:

1. Is this **screen content**?
   - If yes, it belongs in the Screen Area.
2. Is this the user's primary way to interact from the bottom region?
   - If yes, it belongs in the Interaction Dock as an Input Surface.
3. Is this temporary/transient UI?
   - If yes, it belongs in the Overlay Layer.
4. Does this feature change layout when it should only change focus/priority?
   - If yes, it is probably being implemented in the wrong layer.

---

## Rule of thumb

**The application is a routed shell with a persistent screen area, a persistent bottom interaction dock, and a separate overlay layer. Screens choose the dock's input surface; overlays remain transient and layout-independent.**
