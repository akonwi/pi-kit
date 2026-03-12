# Architecture Decision: Screen + Interaction Dock Shell

- Status: Accepted
- Date: 2026-03-11
- Scope: Pi kit UI architecture for thread view, pager, wizard, and future interactive screens

## Summary

We will structure the UI around a persistent application shell with three layers:

1. **Screen Area** — the main content area above the dock
2. **Interaction Dock** — a persistent bottom-anchored interaction region
3. **Overlay Layer** — transient, top-priority UI such as pickers and dialogs

The dock remains a stable layout region, but it does **not** always host the same input implementation. Instead, each active screen selects an **Input Surface** for the dock.

This replaces the narrower mental model of "one composer everywhere" with a broader model:

- there is one persistent **dock region**
- the dock can host different **input surfaces** depending on context
- transient UI is rendered as overlays, not as part of screen or dock layout flow

---

## Why this decision exists

The previous direction exposed a few foundational problems:

- picker UI was too entangled with the editor/composer render path
- pager behavior, picker behavior, and composer behavior were competing for focus and escape handling
- transient UI could affect layout and cursor behavior in ways that felt unstable
- the system did not generalize cleanly to future contexts like wizard-style screens

The desired UX is more general:

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
The UI should be thought of as a shell with:

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
The picker must:
- render with the highest priority among transient UI relevant to the dock interaction
- be visually attached to the top edge of the dock/input surface when appropriate
- **not** be a sibling in the dock's internal layout flow
- **not** resize the dock
- **not** resize the screen

Visually attached, architecturally floating.

---

## Core Principles

### Stable shell, variable content
The shell remains stable while screen content and dock behavior vary by context.

### One dock region, many input surfaces
We standardize the existence of the dock, not a single implementation of its contents.

### Transient UI never drives layout
Pickers, menus, and dialogs should be overlays, not embedded layout participants.

### Screen changes should not imply new architectural rules
A pager, wizard, or future screen should fit into the same shell model rather than inventing a custom one-off stack.

### Focus and dismissal must be explicit
The system must have clear ownership of:
- focus
- cursor
- key precedence
- escape/dismiss behavior

---

## Invariants

These should remain true across implementation and future iteration.

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

Capabilities may include:
- text editing
- cursor rendering/ownership
- draft binding
- submit behavior
- suggestion trigger detection
- overlay anchoring for picker

### Wizard Input Surface
Used for:
- structured choices
- yes/no selection
- occasional free text
- guided workflows where the dock remains present but the interaction style differs from freeform composition

Capabilities may include:
- option focus
- constrained navigation
- auxiliary free-text field
- step confirmation/cancel behavior

### Hidden Input Surface
Used when the active screen should control the entire experience without dock interaction.

---

## Recommended contracts

The exact code interfaces can evolve, but conceptually the system should have the following contracts.

### Screen contract
A screen should be able to declare:
- what it renders in the screen area
- what input surface should appear in the dock
- what behavior/configuration should be passed to that input surface
- what keys it intercepts before falling back
- what should happen on submit/cancel/escape when no overlay is open

### Input surface contract
An input surface should be able to declare:
- how it renders inside the dock
- how it handles input
- whether it owns a cursor/focus target
- how it loads and persists state
- whether it supports anchored overlays such as the picker
- what submit means in its current context

### Overlay manager contract
The overlay system should be able to:
- open/close overlays
- determine the topmost active overlay
- route dismiss behavior by priority
- allow visual anchoring relative to the dock/input surface
- prevent overlays from affecting layout geometry

---

## Key Routing and Dismissal

Key handling should be governed by explicit priority, not ad hoc listener competition.

Recommended order:

1. **Overlay Layer**
   - picker
   - dialogs
   - any transient focused overlay
2. **Active Input Surface**
   - text composer
   - wizard controls
   - choice input
3. **Active Screen**
   - pager navigation
   - screen-level shortcuts
4. **App/global fallback**

Notes:
- Some screens may intentionally shift some responsibilities between screen and input surface.
- That variance should be explicit and contractual, not incidental.

### Escape rule
`Esc` should always dismiss the topmost dismissible layer first.

Examples:
- picker open → close picker
- other overlay open → close that overlay
- pager screen active with no overlay → pager screen handles close/back
- otherwise → fallback/default behavior

No workaround-based double-escape behavior should be the long-term design.

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

**Dock Input Surface:** likely `TextComposerSurface` with a different binding/context

**Behavior:**
- active section determines which draft is bound
- each section has its own logical note state
- switching sections auto-saves current draft and loads the next section's draft
- submit compiles and sends structured feedback from all non-empty section drafts
- picker remains an overlay attached to the dock, not part of pager layout

### Wizard screen
**Screen Area:** question context, progress, helper text, richer interaction UI

**Dock Input Surface:** likely `WizardInputSurface` or `HiddenInputSurface`

**Behavior:**
- may use constrained controls instead of a freeform text composer
- may optionally include free-text entry when needed
- should not be forced into the same interaction metaphor as the normal text composer

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

## Implementation guidance

This document is architectural, not code-level, but it implies the following direction.

### Suggested top-level modules
- `AppShell`
- `ScreenManager` or screen routing/controller
- `InteractionDock`
- `InputSurface` implementations
- `OverlayManager`

### Suggested near-term input surfaces
- `TextComposerSurface`
- `WizardInputSurface`
- `HiddenInputSurface`

### Suggested initial screens
- `ThreadScreen`
- `PagerScreen`
- `WizardScreen`

### Suggested responsibilities to separate early
- dock rendering vs input-surface rendering
- screen state vs dock state
- overlay state vs layout state
- dismiss/key precedence vs feature-specific logic

---

## Migration guidance from current state

The current code should be moved toward this architecture incrementally.

### Phase 1: establish shell concepts
- formalize screen vs dock vs overlay responsibilities
- stop treating transient UI as dock/editor layout

### Phase 2: extract picker into a true overlay
- picker becomes overlay-managed
- visual anchoring remains tied to the dock/input surface
- layout independence becomes enforced

### Phase 3: treat pager as a screen/context
- pager owns screen content and screen-level behavior
- pager no longer behaves like a partial layout hack above the composer
- pager binds the dock to per-section drafts

### Phase 4: generalize input surface abstraction
- current composer becomes `TextComposerSurface`
- wizard or guided flows can use alternate surfaces

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

## Final rule of thumb

**The application should be built as a routed shell with a persistent screen area, a persistent bottom interaction dock, and a separate overlay layer. Screens choose the dock's input surface; overlays remain transient and layout-independent.**
