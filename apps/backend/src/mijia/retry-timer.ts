import { context, ROOT_CONTEXT } from "@home-agent/observability";

/** One retry owned by one failed operation or camera source. */
export class RetryTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: (() => void) | undefined;
  private failures = 0;

  schedule(run: () => void) {
    this.run = run;
    if (this.timer) return;
    const delayMs = Math.min(5_000 * 2 ** Math.min(this.failures, 4), 60_000);
    this.failures += 1;
    // Register in the root context so retries do not retain the triggering request.
    this.timer = context.with(ROOT_CONTEXT, () =>
      setTimeout(
        () => {
          this.timer = undefined;
          const next = this.run;
          this.run = undefined;
          next?.();
        },
        delayMs + Math.random() * 1_000,
      ),
    );
    this.timer.unref();
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.run = undefined;
    this.failures = 0;
  }
}
