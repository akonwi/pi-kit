---
description: Execute implementation with tight scope and post-change validation
---
Implementation task: $@

Execution rules:
1. Keep scope focused to the requested task.
2. Read relevant files before editing.
3. Prefer surgical edits over rewrites.
4. If ambiguity appears, pause and ask.
5. After changes, run relevant validation (tests/lint/typecheck) when available.

If no concrete plan exists yet:
- create a short plan first, then implement.

Finish with:
- Summary of changes
- Validation run (and results)
- Remaining risks / follow-ups
