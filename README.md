# @akonwi/pi-kit

Source-of-truth Pi package for my setup.

## Includes

- Extensions:
  - `extensions/protected-paths.ts`
  - `extensions/pi-kit.ts`
  - `extensions/thread-references.ts`
  - `extensions/subagent/index.ts`
- Prompt templates:
  - `prompts/plan.md`
  - `prompts/implement.md`
- Theme:
  - `themes/akonwi-dark.json`
- Bundled subagent profile:
  - `extensions/subagent/agents/ard-expert.md`

## Local install

```bash
pi install /Users/akonwi/Developer/agent/pi-kit
```

Then in Pi:

```text
/reload
```

## Notes

- This package is the shared source-of-truth.
- Machine-local changes can still be made directly in `~/.pi/agent` (settings, local overrides, auth/sessions).
