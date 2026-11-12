import { useState } from "react";

export function useReadingSnapshot<T>(value: T, key: string) {
  const [saved, setSaved] = useState<{ key: string; value: T } | null>(null);
  const snapshot = saved?.key === key ? saved.value : null;
  if (saved && saved.key !== key) setSaved(null);

  function freeze(current = value) {
    setSaved({ key, value: current });
  }
  function resume() {
    setSaved(null);
  }

  return { snapshot, freeze, resume };
}
