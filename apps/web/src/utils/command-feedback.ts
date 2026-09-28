/** Commands settle only after the authoritative state has caught up. */
export function commandFeedback({
  sending,
  confirming,
  failed,
  issued,
}: {
  sending: boolean;
  confirming: boolean;
  failed: boolean;
  issued: boolean;
}) {
  const phase = sending
    ? "sending"
    : confirming
      ? "confirming"
      : failed
        ? "error"
        : issued
          ? "success"
          : "idle";
  const pending = phase === "sending" || phase === "confirming";
  const status = pending
    ? "pending"
    : phase === "error"
      ? "error"
      : issued
        ? "success"
        : "idle";
  return { phase, pending, status } as const;
}
