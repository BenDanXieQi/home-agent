// Only readiness order lives here; pixels remain in each source's single slot.
export function createVideoScheduler(
  available: () => boolean,
  dispatch: (id: string) => void,
) {
  const ready = new Set<string>();
  let scheduled = false;
  function wake() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!available()) return;
      const id = ready.values().next().value;
      if (id === undefined) return;
      ready.delete(id);
      dispatch(id);
      if (ready.size && available()) wake();
    });
  }
  return {
    get pending() {
      return ready.size > 0;
    },
    ready(id: string) {
      ready.add(id);
      wake();
    },
    remove(id: string) {
      ready.delete(id);
    },
    wake,
  };
}
