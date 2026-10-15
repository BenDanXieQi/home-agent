import { useLayoutEffect, useState } from "react";

export function usePreviousKeys(keys: Set<string>) {
  const [previous, setPrevious] = useState(keys);
  useLayoutEffect(() => {
    if (
      previous.size !== keys.size ||
      [...keys].some((key) => !previous.has(key))
    )
      // oxlint-disable-next-line react/set-state-in-effect
      setPrevious(keys);
  }, [keys, previous]);
  return previous;
}
