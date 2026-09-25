# Repository Rules

1. Do not write tests of any kind without the user's prior explicit permission.
2. Do not add backward-compatibility code without the user's prior explicit permission, including legacy fallbacks, compatibility aliases, migration warnings, or version-specific branches. Always treat the current code as the sole, final implementation; do not distinguish between historical variants such as v1 and v2.
3. Write and maintain project documentation as a coherent final reference to the current implementation. Remove work-in-progress narration, session history, superseded alternatives, one-off progress or verification logs, and redundant explanations. Keep necessary usage instructions, constraints, and unverified limitations accurate; place explicitly planned work only in dedicated planning documents, never describe it as implemented behavior.

## Local environment

Read `AGENTS.local.md` at the repository root if present. This optional, Git-ignored file holds machine-specific paths and tool setup. Contributors can create it to specify their MiLoCo checkout path and any local CodeGraph configuration. Keep personal absolute paths out of shared documentation.

## MiLoCo reference

Use the checkout configured in `AGENTS.local.md` as a read-only reference. If no path is configured, ask for its location when needed. For indexed checkouts, use `codegraph explore --path <checkout-path> "<query>"` first, resolving `codegraph` from PATH.
