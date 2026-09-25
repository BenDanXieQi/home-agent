import { Button } from "./Button";

/** Fetch failures and rejected actions have separate recovery semantics. */
export function RequestFeedback({
  fetchError,
  error,
  refresh,
  retryLabel = "重试",
  errorClassName = "notice notice-error",
}: {
  fetchError?: string | null;
  error?: string | null | undefined;
  refresh?: () => void;
  retryLabel?: string;
  errorClassName?: string;
}) {
  return (
    <>
      {fetchError ? (
        <div className="notice notice-error" role="alert">
          {fetchError}
          {refresh ? <Button onClick={refresh}>{retryLabel}</Button> : null}
        </div>
      ) : null}
      {error ? (
        <p className={errorClassName} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
