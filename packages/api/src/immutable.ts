import { create, type Draft } from "mutative";
import type { z } from "zod";

export function produce<T extends object>(
  base: T,
  recipe: (draft: Draft<T>) => undefined,
) {
  return create(base, recipe);
}

export function freeze<T extends object>(value: T) {
  // oxlint-disable-next-line typescript/no-floating-promises
  create(value, () => {}, { enableAutoFreeze: true });
  return value;
}

const immutable = new WeakSet<object>();

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
