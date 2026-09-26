# Repository Rules

1. Do not write tests of any kind without the user's prior explicit permission.
2. Do not add backward-compatibility code without the user's prior explicit permission, including legacy fallbacks, compatibility aliases, migration warnings, or version-specific branches. Always treat the current code as the sole, final implementation; do not distinguish between historical variants such as v1 and v2.
3. Write and maintain project documentation as a coherent final reference to the current implementation. Remove work-in-progress narration, session history, superseded alternatives, one-off progress or verification logs, and redundant explanations. Keep necessary usage instructions, constraints, and unverified limitations accurate; place explicitly planned work only in dedicated planning documents, never describe it as implemented behavior.
   In Chinese documentation and explanations, call the household, room, and device inventory “设备清单”, reserving “目录” for filesystem directories. Describe storage actions concretely, such as “把设备清单保存到数据库”, instead of “目录持久化”. Explain unfamiliar technical terms on first use; preserve actual code identifiers when referencing them.
4. Prefer type inference over explicit definitions. Derive types from existing schemas, values, and implementations with `z.infer`, `typeof`, `ReturnType`, `Awaited`, and indexed access as appropriate. Do not maintain standalone type definitions that repeat these sources. Define necessary input boundaries once and reuse them; do not create schemas or wrapper functions solely to manufacture a type.
5. Do not hand-write function or method return types; let TypeScript infer them from the implementation. Preserve discriminated unions through actual values and narrow literals. Do not replace inference with `any`, double assertions, or casts that conceal a type mismatch.
6. Follow domain-driven design (DDD): organize modules around domain concepts, responsibilities, and ownership. Keep domain rules and invariants independent of HTTP, persistence, and vendor protocols; application orchestration coordinates domain work, while adapters handle external systems and boundary conversion. Give each domain state a single owner, and name modules in domain terms. Introduce abstractions and layers only when actual domain responsibilities require them.

## Local environment

Read `AGENTS.local.md` at the repository root if present. This optional, Git-ignored file holds machine-specific paths and tool setup. Contributors can create it to specify their MiLoCo checkout path and any local CodeGraph configuration. Keep personal absolute paths out of shared documentation.

## MiLoCo reference

Use the checkout configured in `AGENTS.local.md` as a read-only reference. If no path is configured, ask for its location when needed. For indexed checkouts, use `codegraph explore --path <checkout-path> "<query>"` first, resolving `codegraph` from PATH.
