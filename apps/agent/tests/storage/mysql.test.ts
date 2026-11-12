import { expect, test } from "bun:test";
import { SQL } from "bun";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import {
  createExpectAssertions,
  createStorageConformance,
} from "@earendil-works/pi-durable/testing";
import { MysqlStorage } from "../../src/storage/mysql";

// oxlint-disable-next-line turbo/no-undeclared-env-vars
const databaseUrl = process.env.TEST_MYSQL_DATABASE_URL;

async function readStored(storage: Storage) {
  const documents = await storage.scanDocuments(
    {
      scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
      at: "current",
    },
    256,
    undefined,
    context,
  );
  return {
    entries: await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
      256,
      undefined,
      context,
    ),
    documents: await Promise.all(
      documents.items.map((record) =>
        storage.document(record.id, "current", context),
      ),
    ),
  };
}

async function withStorage(use: (storage: Storage) => Promise<void>) {
  if (!databaseUrl) throw new Error("TEST_MYSQL_DATABASE_URL is required");

  const database = `pi_storage_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(databaseUrl, { max: 1 });
  let storage: MysqlStorage | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE \`${database}\``);
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    storage = await MysqlStorage.open(url.href);
    await use(storage);

    const expected = await readStored(storage);
    const nextId = await storage.mintId();
    await storage.close();
    storage = await MysqlStorage.open(url.href);
    expect(await readStored(storage)).toEqual(expected);
    expect(await storage.mintId()).toBeGreaterThan(nextId);
  } finally {
    try {
      await storage?.close();
    } finally {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS \`${database}\``);
      } finally {
        await admin.close();
      }
    }
  }
}

const batchCases = new Set([
  "commits batches in order, each with its seq, checked against the earlier ones",
  "stores the batches before the first one refused, and none after it",
  "refuses a later batch its own malformed actions fail, keeping the batches before it",
  "resolves a batched copy against the state the earlier batches left",
]);
const cases = createStorageConformance({
  assertions: createExpectAssertions(expect),
  withStorage,
}).filter((scenario) => batchCases.has(scenario.name));
if (cases.length !== batchCases.size)
  throw new Error("Pi storage batch conformance cases changed");
for (const scenario of cases) {
  test.skipIf(!databaseUrl)(scenario.name, () => scenario.run(), 15_000);
}
