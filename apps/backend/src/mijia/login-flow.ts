import { setTimeout as sleep } from "node:timers/promises";
import type { MijiaLoginAttempt } from "@home-agent/api/mijia";
import { MiCloud } from "./micloud";
import { MijiaError, safeMijiaError } from "./errors";
import { mijiaOperation } from "./operation";

export type LoginCandidate = {
  id: string;
  cloud: MiCloud;
  controller: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

/** Owns only an interactive attempt. Account adoption belongs to the coordinator. */
export class LoginFlow {
  state: MijiaLoginAttempt = { status: "idle" };
  private attempt: LoginCandidate | undefined;

  constructor(
    private readonly commit: (candidate: LoginCandidate) => Promise<void>,
  ) {}

  get active() {
    return this.attempt !== undefined;
  }

  start() {
    this.dispose();
    const candidate: LoginCandidate = {
      id: crypto.randomUUID(),
      cloud: new MiCloud({ region: "cn" }),
      controller: new AbortController(),
    };
    this.attempt = candidate;
    this.state = { status: "creating", id: candidate.id };
    void this.prepareLogin(candidate);
  }

  isCurrent(candidate: LoginCandidate) {
    return this.attempt === candidate && !candidate.controller.signal.aborted;
  }

  dispose() {
    if (this.attempt) {
      clearTimeout(this.attempt.expiryTimer);
      this.attempt.controller.abort();
      this.attempt.cloud.dispose();
      this.attempt = undefined;
    }
    this.state = { status: "idle" };
  }

  prepareCommit(candidate: LoginCandidate) {
    if (!this.isCurrent(candidate)) throw new MijiaError("stale_session");
    clearTimeout(candidate.expiryTimer);
    this.state = { status: "completing", id: candidate.id };
  }

  adopt(candidate: LoginCandidate) {
    if (!this.isCurrent(candidate)) throw new MijiaError("stale_session");
    clearTimeout(candidate.expiryTimer);
    candidate.controller.abort();
    this.attempt = undefined;
    this.state = { status: "completed", id: candidate.id };
  }

  cancel(id: string) {
    if (this.attempt?.id === id) this.finish({ status: "cancelled", id });
  }

  private finish(result: MijiaLoginAttempt) {
    this.dispose();
    this.state = result;
  }

  private async prepareLogin(attempt: LoginCandidate) {
    try {
      const qr = await mijiaOperation("login.create", "authentication", () =>
        attempt.cloud.createLogin(attempt.controller.signal),
      );
      if (!this.isCurrent(attempt)) return;
      this.state = {
        id: attempt.id,
        status: "pending",
        qrImageUrl: qr.qrImage,
        expiresAt: new Date(qr.expiresAt).toISOString(),
      };
      attempt.expiryTimer = setTimeout(
        () => {
          if (!this.isCurrent(attempt) || this.state.status === "completed")
            return;
          this.loginFailed(attempt, new MijiaError("expired"));
        },
        Math.max(0, qr.expiresAt - Date.now()),
      );
      attempt.expiryTimer.unref();
      while (this.isCurrent(attempt)) {
        const result = await mijiaOperation(
          "login.poll",
          "authentication",
          () => attempt.cloud.pollLogin(attempt.controller.signal),
        );
        if (!this.isCurrent(attempt)) return;
        if (result.status === "authenticated") {
          await this.commit(attempt);
          return;
        }
        if (result.status === "expired") throw new MijiaError("expired");
        if (result.status === "security-required") {
          this.state = {
            id: attempt.id,
            status: "security_required",
            verificationUrl: result.verificationUrl,
            expiresAt: new Date(qr.expiresAt).toISOString(),
          };
          return;
        }
        await sleep(qr.pollIntervalMs, undefined, {
          signal: attempt.controller.signal,
        });
      }
    } catch (error) {
      this.loginFailed(attempt, error);
    }
  }

  private loginFailed(attempt: LoginCandidate, error: unknown) {
    if (!this.isCurrent(attempt)) return;
    const failure = safeMijiaError(error, "authentication");
    this.finish({
      id: attempt.id,
      status: failure.reason === "expired" ? "expired" : "error",
      error: failure.toPayload(),
    });
  }

  async verifyLogin(id: string, ticket: string) {
    const attempt = this.attempt;
    const challenge = this.state;
    if (
      !attempt ||
      attempt.id !== id ||
      challenge.status !== "security_required"
    )
      throw new MijiaError("stale_session");
    this.state = { id, status: "completing" };
    try {
      const result = await mijiaOperation(
        "login.verify",
        "authentication",
        () =>
          attempt.cloud.submitSecurityCode(ticket, attempt.controller.signal),
      );
      if (!this.isCurrent(attempt)) return;
      if (result.status === "authenticated") await this.commit(attempt);
      else {
        this.state = {
          id,
          status: "security_required",
          verificationUrl: result.verificationUrl,
          expiresAt: challenge.expiresAt,
        };
      }
    } catch (error) {
      if (this.isCurrent(attempt)) {
        const failure = safeMijiaError(error, "authentication");
        // Only a rejected code is retryable in this challenge. Other failures
        // may follow a consumed code or a partial STS exchange; discard them.
        if (failure.reason !== "security_code_invalid") {
          this.loginFailed(attempt, failure);
          return;
        }
        this.state = {
          ...challenge,
          error: failure.toPayload(),
        };
      }
    }
    return;
  }
}
