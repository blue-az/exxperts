---
name: code-review
description: Structured code review pass. Load when the user asks for a code review or "look at this PR".
---

# Code review (Exxeta style)

Run a structured pass and return findings grouped by severity. Do **not**
fix anything — review only.

## Steps

1. Identify the change set: `git diff --stat`, `git diff`, or the file list
   the user provided.
2. For each modified file, read it (use `read` with offset/limit for large
   files) and the call sites of any changed exported symbol (`grep`).
3. Check tests: do affected paths have tests? Were they updated?
4. Run static checks if available: `tsc --noEmit`, `eslint`, `ruff`,
   whatever the project uses. Surface failures.

## Output format

### Files reviewed
- `path/file.ts` (lines L–L)

### Critical (must fix)
- `path:line` — issue + why it's critical

### Warnings (should fix)
- `path:line` — issue

### Nits / suggestions
- `path:line` — improvement

### Tests
- Coverage observation, missing cases.

### Verdict
One sentence: ship / ship-with-changes / block.
