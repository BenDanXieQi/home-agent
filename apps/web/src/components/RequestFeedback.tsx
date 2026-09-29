import { Notice } from "./Notice";
import { Button } from "./Button";

/** Synchronization progress and rejected actions have distinct semantics. */
export function RequestFeedback({
  syncMessage,
  error,
  refresh,
  reconnectLabel = "重新连接状态",
}: {
  syncMessage?: string | null;
  error?: string | null;
  refresh?: () => void;
  reconnectLabel?: string;
}) {
  return (
    <>
      {syncMessage ? (
        <Notice>
          {syncMessage}
          {refresh ? <Button onClick={refresh}>{reconnectLabel}</Button> : null}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}
