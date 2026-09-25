import { MiCloud } from "../protocols/micloud";
import { type CredentialStore } from "../../credentials/store";
import { mijiaOperation } from "../operation";
/** Prepare a candidate without changing the current account or durable authorization. */
export async function renewAccountSession(
  account: MiCloud,
  signal: AbortSignal,
) {
  const client = await account.renewSession(signal);
  try {
    const devices = await client.getDevices(signal);
    return { client, devices };
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
  const restored = MiCloud.restoreSession(record.value);
  try {
    return await renewAccountSession(restored, signal);
  } finally {
    restored.dispose();
  }
}
