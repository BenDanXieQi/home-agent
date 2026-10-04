import { useEffect, useState } from "react";
import type { WindowListEntry } from "./windows";

function useWindowExpired(readableUntil: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (readableUntil === null) return undefined;
    const remaining = readableUntil - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [readableUntil]);
  return readableUntil !== null && now >= readableUntil;
}

export function useWindowInputState({
  inputState,
  readableUntil,
}: Pick<WindowListEntry, "inputState" | "readableUntil">) {
  const expired = useWindowExpired(
    inputState === "available" ? readableUntil : null,
  );
  return expired ? "expired" : inputState;
}

export function useWindowMediaState(
  media:
    | Pick<
        NonNullable<WindowListEntry["sampledMedia"]>,
        "state" | "readableUntil"
      >
    | null
    | undefined,
) {
  const expired = useWindowExpired(
    media && !["revoked", "evicted", "expired"].includes(media.state)
      ? media.readableUntil
      : null,
  );
  return expired ? "expired" : (media?.state ?? null);
}
