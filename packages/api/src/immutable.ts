import { create, type Draft } from "mutative";
import type { z } from "zod";

/** Build a candidate without freezing values owned by its caller. */
export function produce<T extends object>(
  base: T,
  recipe: (draft: Draft<T>) => undefined,
) {
  return create(base, recipe);
}

/** Freeze an owned value in place; no draft update or schema copy is needed. */
export function freeze<T extends object>(value: T) {
  void create(value, () => {}, { enableAutoFreeze: true });
  return value;
}

const immutable = new WeakSet<object>();

/** Validation detaches external inputs before they become trusted frozen values. */
export function parseImmutable<T extends object>(
  schema: z.ZodType<T>,
  input: unknown,
) {
  const value = freeze(schema.parse(input));
  immutable.add(value);
  return value;
}

export function isImmutable(value: unknown) {
  return value !== null && typeof value === "object" && immutable.has(value);
}
