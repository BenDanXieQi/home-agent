import { context, ROOT_CONTEXT } from "@home-agent/observability";

/** One retry owned by one failed operation or camera source. */
export class RetryTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private run: (() => void) | undefined;
  private failures = 0;
  private deadline = 0;

  schedule(run: () => void, notBefore = 0) {
    this.run = run;
    if (this.timer) {
      // A concurrent manual attempt may extend the supplier's deadline while
      // an earlier retry is waiting. Its wake-up re-arms for the later time.
      this.deadline = Math.max(this.deadline, notBefore);
      return;
    }
    const delayMs = Math.min(5_000 * 2 ** Math.min(this.failures, 4), 60_000);
    this.failures += 1;
    this.deadline = Math.max(
      Date.now() + delayMs + Math.random() * 1_000,
      notBefore,
    );
    // Long Retry-After values are re-armed instead of overflowing setTimeout.
    const arm = () => {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          if (Date.now() < this.deadline) {
            arm();
            return;
          }
          const next = this.run;
          this.run = undefined;
          next?.();
        },
        Math.min(Math.max(1, this.deadline - Date.now()), 2_147_483_647),
      );
      this.timer.unref();
    };
    // Retries must not retain the triggering request's trace context.
    context.with(ROOT_CONTEXT, arm);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.run = undefined;
    this.failures = 0;
    this.deadline = 0;
  }
}
