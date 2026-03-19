# Extension Overhaul Backlog

Working plan for overhauling the Pi extension to match the `v2/` app UX as closely as Pi host constraints allow.

## Guiding principles

- `v2/` is the primary **UX guide**.
- We do **not** need to copy all `v2` architecture.
- Where the current extension is clearly better, keep that behavior.
- Current known exception: **`@@` trigger detection in the Pi extension is better than `v2`** and should remain the behavioral reference.
- Additional parity target: **bring over the `v2` theme** where practical.

## UX parity targets

- Shell feel and information hierarchy from `v2`
- Composer + picker behavior from `v2`, except keep the extension’s smoother `@@` feel
- Pager behavior from `v2`
- Wizard / guided questionnaire behavior from `v2`
- Stable transcript + ephemeral runtime activity philosophy from `v2`
- Footer / pending strip / status styling closer to `v2`
- Theme parity with `v2`

## Known host limits

We should push as far as possible, but exact parity may be limited by Pi interactive mode in areas like:

- independently scrollable regions
- exact overlay placement/focus behavior
- exact fixed-pane shell layout
- exact OpenTUI rendering semantics

Goal: prioritize **behavioral parity first**, then visual/layout parity wherever Pi allows.

## File-level plan

### Composer + picker core

Keep as the base:
- `extensions/ui/input-surfaces/text-composer.ts`
- `extensions/ui/picker-overlay.ts`

Direction:
- align slash/file/bash behavior with `v2`
- preserve extension-led `@@` trigger UX
- improve unified picker behavior without forcing OpenTUI architecture
- do **not** prioritize `v2`'s follow-up text-input flow for slash-command values; current extension patterns are acceptable there

### Composer orchestration

Primary file:
- `extensions/ui/thread-reference-shell.ts`

Direction:
- turn this into the main extension-side composer controller/orchestrator
- centralize trigger behavior, picker source routing, submit behavior, and dock awareness
- use `v2/src/shell/composer-controller.ts` as guidance, not as a strict port

### Files / ignore behavior

Current source:
- `extensions/thread-references.ts`

`v2` reference:
- `v2/src/features/files/file-index.ts`
- `v2/src/features/files/scan-files.ts`
- `v2/src/features/files/score.ts`

Direction:
- bring over cleaner indexing/scanning logic from `v2`
- keep good extension ignore-management UX
- treat indexing internals as an explicit priority during Milestone 1 follow-up work

### Thread references

Current source:
- `extensions/thread-references.ts`
- `extensions/ui/input-surfaces/text-composer.ts`

`v2` reference:
- `v2/src/features/threads/thread-index.ts`
- `v2/src/features/threads/expand-references.ts`

Direction:
- hybrid approach
- preserve extension `@@` typing/insertion feel
- borrow/refactor `v2` modular logic where useful

### Slash commands / command flows

Current source:
- `extensions/pi-kit.ts`
- `extensions/thread-references.ts`
- `extensions/claude-commands.ts`

`v2` reference:
- `v2/src/features/commands/*`

Direction:
- make command flows feel like one coherent system
- use picker/input/list interactions closer to `v2`

### Pager

Current source:
- `extensions/ui/screens/pager-screen.ts`
- `extensions/pi-kit.ts`

`v2` reference:
- `v2/src/features/pager/pager-controller.ts`
- `v2/src/features/pager/split-sections.ts`
- `v2/src/shell/PagerView.tsx`

Direction:
- align section splitting, note semantics, and grouped feedback behavior with `v2`
- keep Pi-specific screen/overlay plumbing only where necessary

### Wizard / guided questions

Current source:
- `extensions/ui/screens/wizard-screen.ts`
- `extensions/ui/input-surfaces/wizard-input.ts`
- `extensions/pi-kit.ts`

`v2` reference:
- `v2/src/features/wizard/wizard-controller.ts`
- `v2/src/features/wizard/tool.ts`
- `v2/src/shell/WizardView.tsx`
- `v2/src/shell/WizardDock.tsx`

Direction:
- bring wizard flow and presentation closer to `v2`
- keep extension implementation details where they are a better fit for Pi

### Runtime panel + footer/status

Current source:
- `extensions/pi-kit.ts`
- `extensions/ui/shell.ts`

`v2` reference:
- `v2/src/shell/PendingSlot.tsx`
- `v2/src/shell/BottomStatusBar.tsx`
- `v2/docs/decisions/assistant-message-streaming.md`

Direction:
- match `v2` information hierarchy
- keep transient activity outside the durable transcript where possible
- move visual styling closer to `v2`, including theme parity

### Theme parity

Primary reference:
- `v2/src/shell/theme.ts`

Direction:
- carry over the `v2` theme palette and visual language into the extension where Pi supports it
- ensure composer, picker, pager, wizard, footer/status, and overlays feel visually aligned

## Implementation order

### Milestone 1 — Composer + picker overhaul

Focus:
- `extensions/ui/input-surfaces/text-composer.ts`
- `extensions/ui/thread-reference-shell.ts`
- `extensions/ui/picker-overlay.ts`

Success criteria:
- no regression in `@@`
- slash picker feels more like `v2`
- file/thread/bash flows are more unified
- cleaner screen/mode awareness
- stronger base for pager/wizard parity later

### Milestone 2 — Command flow parity

Focus:
- `extensions/pi-kit.ts`
- `extensions/thread-references.ts`
- optional command extraction into smaller files

### Milestone 3 — Pager parity

Focus:
- `extensions/ui/screens/pager-screen.ts`
- `extensions/pi-kit.ts`

### Milestone 4 — Wizard parity

Focus:
- `extensions/ui/screens/wizard-screen.ts`
- `extensions/ui/input-surfaces/wizard-input.ts`
- `extensions/pi-kit.ts`

### Milestone 5 — Footer / pending / transcript polish

Focus:
- `extensions/pi-kit.ts`
- `extensions/ui/shell.ts`
- theme alignment from `v2`

## Immediate next step

Start with **Milestone 1: composer + picker overhaul**.
