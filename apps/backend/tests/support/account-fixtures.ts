import { mock } from "bun:test";
import type { CredentialStore } from "../../src/credentials/store";
import type { HomeSelectionStore } from "../../src/mijia/homes/store";
import { oauthSessionSchema } from "../../src/mijia/protocols/oauth/client";
import { savedSession } from "./protocol-fixtures";

export function oauthSession(
  overrides: Partial<ReturnType<typeof oauthSessionSchema.parse>> = {},
) {
  return oauthSessionSchema.parse({
    uuid: "a".repeat(32),
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  });
}

export function accountRecord() {
  return { micloud: savedSession(), oauth: oauthSession() };
}

export function credentialStore(initial: unknown = accountRecord()) {
  let value: unknown = initial;
  return {
    read: mock<CredentialStore["read"]>(async () =>
      value === undefined ? undefined : { value: structuredClone(value) },
    ),
    write: mock<CredentialStore["write"]>(async (_name, next) => {
      value = structuredClone(next);
    }),
    remove: mock<CredentialStore["remove"]>(async () => {
      value = undefined;
    }),
  };
}

export function homeSelectionStore(
  initial?: Awaited<ReturnType<HomeSelectionStore["read"]>>,
) {
  let selection = initial;
  return {
    read: mock<HomeSelectionStore["read"]>(async () => selection),
    write: mock<HomeSelectionStore["write"]>(
      async (_account, homeId, assert) => {
        assert();
        selection = { homeId };
      },
    ),
  };
}
