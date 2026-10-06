import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import postgres from "postgres";
import { sql, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { createDatabase } from "../../../src/db";
import * as schema from "../../../src/db/schema";
import { createSpatialRepository } from "../../../src/household/spatial/repository";
import { createHomeSelectionStore } from "../../../src/mijia/homes/store";
import { clearHouseholdData } from "../../../src/household/data-lifecycle";

const serverUrl = process.env.TEST_DATABASE_URL;
// This URL is only used to create a fresh database; no application tables are touched.
describe.skipIf(!serverUrl)("spatial storage and household lifetime", () => {
  const databaseName = `spatial_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof postgres>;
  let database: ReturnType<typeof createDatabase>;
  let repository: ReturnType<typeof createSpatialRepository>;
  let selections: ReturnType<typeof createHomeSelectionStore>;
  beforeAll(async () => {
    if (!serverUrl) throw new Error("TEST_DATABASE_URL required");
    admin = postgres(serverUrl, { max: 1 });
    await admin`create database ${admin(databaseName)}`;
    const url = new URL(serverUrl);
    url.pathname = `/${databaseName}`;
    database = createDatabase(url.href);
    await migrate(database.db, {
      migrationsFolder: resolve(import.meta.dir, "../../../drizzle"),
    });
    repository = createSpatialRepository(database.db);
    selections = createHomeSelectionStore(
      database.db,
      async () => {},
      () => {},
    );
  }, 30_000);
  afterAll(async () => {
    await database?.close();
    if (admin) {
      try {
        await admin`drop database if exists ${admin(databaseName)}`;
      } finally {
        await admin.end();
      }
    }
  });
  beforeEach(async () => {
    await database.db.transaction(async (tx) => {
      await clearHouseholdData(tx);
      await tx.delete(schema.mijiaHomeSelections);
      await tx.delete(schema.credentials);
    });
    await selections.write("account", "home-a", () => {});
  });
  async function createSpace(name = "客厅") {
    const snapshot = await repository.read();
    return repository.saveSpace({
      id: crypto.randomUUID(),
      scope: snapshot.scope,
      operation: "create",
      name,
      description: "原始说明",
    });
  }
  test("switch clears all household tables and preserves installation data", async () => {
    const first = await createSpace();
    const second = await createSpace("门外");
    const { scope } = await repository.read();
    const passage = await repository.savePassage({
      scope,
      operation: "create",
      id: crypto.randomUUID(),
      name: "门",
      description: "",
      space_a_id: first.id,
      space_b_id: second.id,
    });
    await repository.saveObservationBinding(
      {
        scope,
        operation: "create",
        id: crypto.randomUUID(),
        device_id: "sensor",
        channel: null,
        space_id: null,
        passage_id: passage.id,
        enabled: false,
        description: "",
      },
      () => {},
    );
    await database.db
      .insert(schema.credentials)
      .values({ key: "login", ciphertext: "test-ciphertext" });
    await database.db
      .insert(schema.householdDirectories)
      .values({ accountId: "account", homeId: "home-a", directory: {} });
    const memberId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    await database.db
      .insert(schema.householdSubjects)
      .values({ id: memberId, kind: "person", name: "成员" });
    await database.db.insert(schema.identityMembers).values({ memberId });
    await database.db.execute(
      sql`insert into identity_samples (id, member_id, image_key, image_bytes, content_type, sha256, source, quality, model_version, processing_version, feature) values (${crypto.randomUUID()}, ${memberId}, ${crypto.randomUUID()}, 10, 'image/png', 'fixture', '{}'::jsonb, '{}'::jsonb, 'fixture', 'fixture', '{}'::jsonb)`,
    );
    await database.db.insert(schema.contextRecords).values({
      id: contextId,
      kind: "observation",
      topic: "fixture",
      summary: "fixture",
      certainty: "unknown",
      occurredAt: new Date(),
      scopeEpoch: "fixture",
    });
    await database.db.insert(schema.contextEntities).values({
      contextId,
      entityType: "person",
      entityId: memberId,
      role: "subject",
    });
    await selections.write("account", "home-b", () => {}, "home-a");
    for (const table of Object.values(schema)) {
      if (
        !is(table, PgTable) ||
        table === schema.credentials ||
        table === schema.mijiaHomeSelections
      )
        continue;
      expect({
        table: getTableConfig(table).name,
        count: await database.db.$count(table),
      }).toEqual({ table: getTableConfig(table).name, count: 0 });
    }
    expect(await database.db.select().from(schema.credentials)).toHaveLength(1);
    expect(await selections.read("account")).toEqual({ homeId: "home-b" });
    await expect(
      repository.saveSpace({
        scope,
        id: crypto.randomUUID(),
        operation: "create",
        name: "迟到写入",
        description: "",
      }),
    ).rejects.toMatchObject({ reason: "scope_changed" });
    await selections.write("account", "home-a", () => {}, "home-b");
    await expect(
      repository.saveSpace({
        scope,
        id: crypto.randomUUID(),
        operation: "create",
        name: "迟到写入",
        description: "",
      }),
    ).rejects.toMatchObject({ reason: "scope_changed" });
  });
  test("unclassified database tables prevent switching without deleting data", async () => {
    await createSpace();
    await database.db.execute(
      sql`create table unclassified_fixture (id integer)`,
    );
    try {
      await expect(
        selections.write("account", "home-b", () => {}, "home-a"),
      ).rejects.toMatchObject({ reason: "home_storage" });
      expect((await repository.read()).spaces).toHaveLength(1);
      expect(await selections.read("account")).toEqual({ homeId: "home-a" });
    } finally {
      await database.db.execute(sql`drop table unclassified_fixture`);
    }
  });
  test("failure after clearing rolls back the data and binding together", async () => {
    const space = await createSpace();
    let checks = 0;
    await expect(
      selections.write(
        "account",
        "home-b",
        () => {
          if (++checks >= 3) throw new Error("superseded");
        },
        "home-a",
      ),
    ).rejects.toThrow();
    expect((await repository.read()).spaces[0]?.id).toBe(space.id);
    expect(await selections.read("account")).toEqual({ homeId: "home-a" });
  });
  test("stale saves and deletes fail; a toggle changes only enabled", async () => {
    const space = await createSpace();
    const { scope } = await repository.read();
    const binding = await repository.saveObservationBinding(
      {
        scope,
        operation: "create",
        id: crypto.randomUUID(),
        device_id: "sensor",
        channel: null,
        space_id: space.id,
        passage_id: null,
        enabled: true,
        description: "旧说明",
      },
      () => {},
    );
    const { created_at, updated_at, ...fields } = binding;
    const changed = await repository.saveObservationBinding(
      {
        ...fields,
        scope,
        operation: "update",
        expected_updated_at: updated_at,
        description: "另一页面修改",
      },
      () => {},
    );
    expect(changed.updated_at > updated_at).toBe(true);
    await expect(
      repository.setObservationBindingEnabled({
        scope,
        id: binding.id,
        enabled: false,
        expected_updated_at: updated_at,
      }),
    ).rejects.toMatchObject({ reason: "record_changed" });
    await expect(
      repository.deleteObservationBinding({
        scope,
        id: binding.id,
        expected_updated_at: updated_at,
      }),
    ).rejects.toMatchObject({ reason: "record_changed" });
    await expect(
      repository.saveObservationBinding(
        {
          ...fields,
          scope,
          operation: "update",
          expected_updated_at: updated_at,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ reason: "record_changed" });
    const disabled = await repository.setObservationBindingEnabled({
      scope,
      id: binding.id,
      enabled: false,
      expected_updated_at: changed.updated_at,
    });
    expect(disabled).toMatchObject({
      description: "另一页面修改",
      enabled: false,
      space_id: space.id,
      created_at,
    });
    expect(
      (
        await repository.deleteSpace({
          scope,
          id: space.id,
          expected_updated_at: space.updated_at,
        })
      ).status,
    ).toBe("referenced");
  });
});
