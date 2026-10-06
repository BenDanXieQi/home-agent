import PQueue from "p-queue";
import { validateDeviceValue } from "@home-agent/api/devices";
import type { MijiaDeviceSpec } from "@home-agent/api/mijia";
import { MijiaError, safeMijiaError } from "../errors";
import { MiCloudError } from "../protocols/micloud";
import type { MiCloud } from "../protocols/micloud";
import {
  MIOT_WRITE_BATCH_SIZE,
  miotPropertyWriteSchema,
  miotActionRequestSchema,
  propertyWriteResults,
  actionResult,
} from "../protocols/micloud/commands";
import type { RequestStartObserver } from "../protocols/micloud/transport";

type CommandContext = {
  client: MiCloud;
  accountKey: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  specification: (did: string) => MijiaDeviceSpec;
  authenticationRejected: () => void;
};

function requireOnlineSpec(did: string, context: CommandContext) {
  context.assertCurrent();
  const specification = context.specification(did);
  if (!specification.online) throw new MijiaError("device_offline");
  return specification;
}

/** Orders commands per device; it never schedules retries or owns action history. */
export class MijiaCommands {
  private readonly deviceQueues = new Map<string, PQueue>();
  private pendingCommands = 0;
  private readonly retryAfter = new Map<string, number>();

  writeProperties(
    properties: Parameters<MiCloud["writeProperties"]>[0],
    context: CommandContext,
  ) {
    const parsed = miotPropertyWriteSchema
      .array()
      .min(1)
      .max(MIOT_WRITE_BATCH_SIZE)
      .safeParse(properties);
    if (!parsed.success) throw new MijiaError("invalid_input");
    const requested = parsed.data;
    const keys = requested.map(({ did, siid, piid }) =>
      JSON.stringify([did, siid, piid]),
    );
    if (new Set(keys).size !== requested.length)
      throw new MijiaError("invalid_input");
    const assertCapabilities = () => {
      context.assertCurrent();
      const specifications = new Map(
        [...new Set(requested.map(({ did }) => did))].map((did) => [
          did,
          requireOnlineSpec(did, context),
        ]),
      );
      for (const property of requested) {
        const capability = specifications.get(property.did)?.spec[
          `prop.${property.siid}.${property.piid}`
        ];
        if (!capability?.writeable)
          throw new MijiaError("property_not_writeable");
        if (validateDeviceValue(capability, property.value))
          throw new MijiaError("invalid_input");
      }
    };
    assertCapabilities();
    return this.send(
      context,
      requested.map(({ did }) => did),
      assertCapabilities,
      (started) =>
        context.client.writeProperties(requested, context.signal, started),
    ).then((result) =>
      propertyWriteResults(requested, result.response).map((outcome) => ({
        ...outcome,
        sent_at: result.sent_at,
        received_at: result.received_at,
        error: result.error,
      })),
    );
  }

  invokeAction(
    action: Parameters<MiCloud["invokeAction"]>[0],
    context: CommandContext,
  ) {
    const parsed = miotActionRequestSchema.safeParse(action);
    if (!parsed.success) throw new MijiaError("invalid_input");
    const requested = parsed.data;
    const assertCapabilities = () => {
      const specification = requireOnlineSpec(requested.did, context);
      const capability =
        specification.spec[`action.${requested.siid}.${requested.aiid}`];
      if (!capability?.writeable) throw new MijiaError("action_not_supported");
      const inputs = capability.in_params ?? [];
      if (inputs.length !== requested.in.length)
        throw new MijiaError("invalid_input");
      for (const [index, input] of inputs.entries()) {
        const value = requested.in[index];
        if (value === undefined || validateDeviceValue(input, value))
          throw new MijiaError("invalid_input");
      }
    };
    assertCapabilities();
    return this.send(context, [requested.did], assertCapabilities, (started) =>
      context.client.invokeAction(requested, context.signal, started),
    ).then((result) => ({
      ...actionResult(requested, result.response),
      sent_at: result.sent_at,
      received_at: result.received_at,
      error: result.error,
    }));
  }

  private async send(
    context: CommandContext,
    deviceIds: readonly string[],
    assertCapabilities: () => void,
    dispatch: (started: RequestStartObserver) => Promise<unknown>,
  ) {
    if (this.pendingCommands >= 100) throw new MijiaError("capacity_exceeded");
    this.pendingCommands++;
    const release = Promise.withResolvers<void>();
    // Reserve every device before yielding. Overlapping multi-device batches
    // keep the same admission order while disjoint commands can run together.
    const reservations = [...new Set(deviceIds)].map((did) => {
      const key = JSON.stringify([context.accountKey, did]);
      let queue = this.deviceQueues.get(key);
      if (!queue) {
        queue = new PQueue({ concurrency: 1 });
        this.deviceQueues.set(key, queue);
        queue.once("idle", () => {
          this.deviceQueues.delete(key);
        });
      }
      const entered = Promise.withResolvers<void>();
      const completed = queue.add(async () => {
        entered.resolve();
        await release.promise;
      });
      return { entered: entered.promise, completed };
    });
    try {
      await Promise.all(reservations.map(({ entered }) => entered));
      context.signal.throwIfAborted();
      assertCapabilities();
      const retryAt = this.retryAfter.get(context.accountKey) ?? 0;
      if (retryAt > Date.now())
        throw new MijiaError("network", {
          retry_after_at: new Date(retryAt).toISOString(),
        });
      this.retryAfter.delete(context.accountKey);
      let sentAt: string | null = null;
      const preflight: { error?: unknown } = {};
      try {
        const response = await dispatch((startedAt) => {
          try {
            context.signal.throwIfAborted();
            assertCapabilities();
          } catch (error) {
            // Transport intentionally sanitizes unknown exceptions. Preserve
            // our local rejection so a revoked command retains its reason.
            preflight.error = error;
            throw error;
          }
          sentAt = startedAt;
        });
        return {
          response,
          sent_at: sentAt,
          received_at: new Date().toISOString(),
          error: null,
        };
      } catch (error) {
        if (error instanceof MiCloudError && error.retryAfterAt)
          this.retryAfter.set(context.accountKey, error.retryAfterAt);
        if (error instanceof MiCloudError && error.code === "authentication")
          context.authenticationRejected();
        // A rejected preflight has no effect. Losing the reply after dispatch
        // cannot establish whether the device acted.
        if (sentAt === null) throw safeMijiaError(preflight.error ?? error);
        return {
          response: null,
          sent_at: sentAt,
          received_at: new Date().toISOString(),
          error: safeMijiaError(error).toPayload(),
        };
      }
    } finally {
      release.resolve();
      await Promise.all(reservations.map(({ completed }) => completed));
      this.pendingCommands--;
    }
  }
}
