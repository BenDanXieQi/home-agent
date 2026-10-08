import { useEffect, useState } from "react";
import type { WindowListEntry } from "./windows";

export function useWindowExpired(readableUntil: number | null) {
  const [expiredAt, setExpiredAt] = useState(() =>
    readableUntil !== null && Date.now() >= readableUntil
      ? readableUntil
      : null,
  );
  useEffect(() => {
    if (readableUntil === null) return undefined;
    const deadline = readableUntil;
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setExpiredAt(readableUntil);
        return;
      }
      timer = setTimeout(check, Math.min(2_147_483_647, remaining));
    }
    check();
    return () => clearTimeout(timer);
  }, [readableUntil]);
  return readableUntil !== null && expiredAt === readableUntil;
}

export function useWindowInputState(
  window: Pick<WindowListEntry, "inputState" | "readableUntil"> | undefined,
) {
  const expired = useWindowExpired(
    window?.inputState === "available" ? window.readableUntil : null,
  );
  return expired ? "expired" : window?.inputState;
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
