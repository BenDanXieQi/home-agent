import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { queueOptionsSymbol } from "piscina";
import { createInferenceQueue } from "../../src/perception/compute/inference-queue";

let now = 0;
const clock = spyOn(performance, "now").mockImplementation(() => now);
afterEach(() => {
  now = 0;
});
// Restore at file teardown so other perception tests retain their real clocks.
afterAll(() => clock.mockRestore());

test("directly dispatched tasks have no queue residence", () => {
  const queue = createInferenceQueue();
  const measurement = queue.measureTask();
  now = 100;
  expect(measurement.queueMs).toBe(0);
  expect(queue.size).toBe(0);
});

test("tracks each request independently while retaining FIFO order", () => {
  const queue = createInferenceQueue();
  const first = queue.measureTask();
  const second = queue.measureTask();
  const firstTask = { [queueOptionsSymbol]: first.key };
  const secondTask = { [queueOptionsSymbol]: second.key };
  queue.push(firstTask);
  now = 5;
  queue.push(secondTask);
  now = 10;
  expect(queue.shift()).toBe(firstTask);
  expect(first.queueMs).toBe(10);
  now = 20;
  expect(queue.shift()).toBe(secondTask);
  expect(second.queueMs).toBe(15);
  expect(first.queueMs).toBe(10);
  expect(queue.shift()).toBeNull();
});

test("adds multiple queue visits without counting time between requeues", () => {
  const queue = createInferenceQueue();
  const measurement = queue.measureTask();
  const task = { [queueOptionsSymbol]: measurement.key };
  now = 10;
  queue.push(task);
  now = 20;
  expect(queue.shift()).toBe(task);
  now = 25;
  queue.unshift(task);
  now = 50;
  expect(queue.shift()).toBe(task);
  expect(measurement.queueMs).toBe(35);
  expect(queue.size).toBe(0);
});

test("removal stops the current measurement and permits a later fresh visit", () => {
  const queue = createInferenceQueue();
  const measurement = queue.measureTask();
  const task = { [queueOptionsSymbol]: measurement.key };
  queue.push(task);
  now = 15;
  queue.remove(task);
  expect(queue.size).toBe(0);
  expect(measurement.queueMs).toBe(15);
  now = 20;
  queue.remove(task);
  expect(measurement.queueMs).toBe(15);
  now = 30;
  queue.push(task);
  now = 45;
  expect(queue.shift()).toBe(task);
  expect(measurement.queueMs).toBe(30);
});

test("unmeasured lifecycle tasks retain their ordering", () => {
  const queue = createInferenceQueue();
  const task = { [queueOptionsSymbol]: null };
  queue.unshift(task);
  now = 10;
  expect(queue.shift()).toBe(task);
  expect(queue.size).toBe(0);
});
