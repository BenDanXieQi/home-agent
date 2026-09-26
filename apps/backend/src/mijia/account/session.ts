import { MiCloud } from "../protocols/micloud";
import { type CredentialStore } from "../../credentials/store";
import { mijiaOperation } from "../operation";
import { z } from "zod";
import { savedSessionSchema } from "../protocols/micloud/session";
import { oauthSessionSchema, refreshOAuth } from "../protocols/oauth/client";
import { MijiaError } from "../errors";

export const accountSessionSchema = z.strictObject({
  micloud: savedSessionSchema,
  oauth: oauthSessionSchema,
});

/** Prepare a candidate without changing the current account or durable authorization. */
export async function renewAccountSession(
  account: MiCloud,
  oauth: z.infer<typeof oauthSessionSchema>,
  signal: AbortSignal,
) {
  const client = await account.renewSession(signal);
  try {
    const catalog = await client.getCatalog(signal);
    return { client, catalog, oauth: await refreshOAuth(oauth, signal) };
  } catch (error) {
    client.dispose();
    throw error;
  }
}

export async function restoreAccountSession(
  store: CredentialStore,
  signal: AbortSignal,
) {
  const record = await mijiaOperation(
    "credentials.read",
    "credential_storage",
    () => store.read("mijia"),
  );
  signal.throwIfAborted();
  if (!record) return undefined;
  const parsed = accountSessionSchema.safeParse(record.value);
  if (!parsed.success) throw new MijiaError("authentication");
  const restored = MiCloud.restoreSession(parsed.data.micloud);
  try {
    return await renewAccountSession(restored, parsed.data.oauth, signal);
  } finally {
    restored.dispose();
  }
}
