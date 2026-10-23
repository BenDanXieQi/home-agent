type Retirement = "expired" | "evicted" | "revoked" | "cancelled";

export function createMediaResource(
  expiresAt: number | null,
  onRetire: (reason: Retirement) => void,
) {
  return {
    expiresAt,
    expiresMono:
      expiresAt === null
        ? Infinity
        : performance.now() + Math.max(0, expiresAt - Date.now()),
    createdAt: performance.now(),
    lastUsed: performance.now(),
    onRetire,
    generation: new AbortController(),
    access: new AbortController(),
    reads: new Set<Promise<void>>(),
    uses: new Set<Promise<void>>(),
    path: undefined as string | undefined,
    ownedPath: undefined as string | undefined,
    recursive: false,
    bytes: 0,
    reserved: 0,
    writing: false,
    retired: false,
    quarantined: false,
    pending: undefined as Promise<void> | undefined,
    removing: undefined as Promise<void> | undefined,
    retirement: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}

export type MediaResource = ReturnType<typeof createMediaResource>;

export function mediaExpired(item: ReturnType<typeof createMediaResource>) {
  return (
    item.expiresAt !== null &&
    (Date.now() >= item.expiresAt || performance.now() >= item.expiresMono)
  );
}
