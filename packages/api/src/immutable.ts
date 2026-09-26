import { create, type Draft } from "mutative";
import type { z } from "zod";

/** Build a synchronous candidate without freezing values owned by its caller. */
export function produce<T extends object>(
  base: T,
  recipe: (draft: Draft<T>) => undefined,
) {
  return create(base, recipe);
}

/** Freeze an owned result while retaining its schema-derived type. */
export function update<T extends object>(
  base: T,
  recipe: Parameters<typeof produce<T>>[1],
) {
  const next = produce(base, recipe);
  void create(next, () => {}, { enableAutoFreeze: true });
  return next;
}

const immutable = new WeakSet<object>();

/** Parse a detached public value before trusting its deeply frozen contents. */
export function parseImmutable<T extends object>(
  schema: z.ZodType<T>,
  input: unknown,
) {
  const value = update(schema.parse(input), () => {});
  immutable.add(value);
  return value;
}

export function isImmutable(value: unknown) {
  return value !== null && typeof value === "object" && immutable.has(value);
}
