import { useLayoutEffect, useState } from "react";

/** Previous committed membership distinguishes filtering from viewport recycling. */
export function usePreviousKeys(keys: Set<string>) {
  const [previous, setPrevious] = useState(keys);
  useLayoutEffect(() => {
    if (
      previous.size !== keys.size ||
      [...keys].some((key) => !previous.has(key))
    )
      // oxlint-disable-next-line react/set-state-in-effect -- Commit the animation baseline after new rows mount; viewport-only changes never write state.
      setPrevious(keys);
  }, [keys, previous]);
  return previous;
}
