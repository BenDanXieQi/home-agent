import { expect, test } from "bun:test";
import { resolveComputeBudget } from "../../src/perception/compute/budget";

test("CPU budget keeps one worker on small hosts and rounds fractional workers down", () => {
  expect(resolveComputeBudget(0.01, 1).workersPerProcess).toBe(1);
  expect(resolveComputeBudget(0.5, 3).workersPerProcess).toBe(1);
  expect(resolveComputeBudget(1, 3).workersPerProcess).toBe(3);
});

test("invalid CPU shares cannot create an unbounded or disabled compute pool", () => {
  for (const ratio of [0, -1, 1.1, NaN, Infinity])
    expect(() => resolveComputeBudget(ratio, 8)).toThrow();
});
