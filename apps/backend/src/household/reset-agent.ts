import { tracedFetch } from "@home-agent/observability";
import { MijiaError } from "../mijia/errors";
import type { householdResetRequestSchema } from "@home-agent/api/household-reset";
import type { z } from "zod";

/** Agent owns its database, including when it uses a separate database URL. */
export function createAgentHouseholdReset(readAgentUrl: () => Promise<string>) {
  return async (commit: (assertReady: () => void) => Promise<void>) => {
    const id = crypto.randomUUID();
    const url = new URL("/api/household-reset", await readAgentUrl());
    // Always expire the backend operation before the Agent's admission lease.
    const deadline = performance.now() + 20_000;
    const assertReady = () => {
      if (performance.now() >= deadline)
        throw new MijiaError("home_reset_failed");
    };
    async function send(
      phase: z.infer<typeof householdResetRequestSchema>["phase"],
    ) {
      const response = await tracedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, phase }),
        signal: AbortSignal.timeout(8_000),
      });
      await response.body?.cancel();
      if (response.status === 409) throw new MijiaError("home_reset_busy");
      if (response.status !== 204) throw new MijiaError("home_reset_failed");
    }
    try {
      try {
        await send("prepare");
      } catch (cause) {
        if (cause instanceof MijiaError) throw cause;
        throw new MijiaError("home_reset_failed");
      }
      assertReady();
      await commit(assertReady);
    } finally {
      try {
        await send("finish");
      } catch {
        // The bounded admission lease also releases after a backend crash.
        console.warn(
          "Agent household reset admission will reopen after its lease expires.",
        );
      }
    }
  };
}
