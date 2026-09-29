import { FixedQueue, queueOptionsSymbol } from "piscina";

// Queue residence is measured entirely in the compute process. Public queue
// options associate Piscina's opaque task with the submitting request.
export function createInferenceQueue() {
  const tasks = new FixedQueue();
  const enteredAt = new WeakMap<Parameters<FixedQueue["push"]>[0], number>();
  const elapsed = new WeakMap<object, number>();

  function leave(task: Parameters<FixedQueue["push"]>[0]) {
    const started = enteredAt.get(task);
    enteredAt.delete(task);
    const key = task[queueOptionsSymbol];
    if (started === undefined || !key) return;
    const previous = elapsed.get(key);
    if (previous !== undefined)
      elapsed.set(key, previous + performance.now() - started);
  }

  return {
    get size() {
      return tasks.size;
    },
    push(task: Parameters<FixedQueue["push"]>[0]) {
      enteredAt.set(task, performance.now());
      tasks.push(task);
    },
    unshift(task: Parameters<FixedQueue["unshift"]>[0]) {
      enteredAt.set(task, performance.now());
      tasks.unshift(task);
    },
    shift() {
      const task = tasks.shift();
      if (task) leave(task);
      return task;
    },
    remove(task: Parameters<FixedQueue["remove"]>[0]) {
      tasks.remove(task);
      leave(task);
    },
    measureTask() {
      const key = {};
      elapsed.set(key, 0);
      return {
        key,
        get queueMs() {
          return elapsed.get(key)!;
        },
      };
    },
  };
}
