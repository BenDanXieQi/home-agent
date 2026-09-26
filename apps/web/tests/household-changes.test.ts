import { describe, expect, it } from "vitest";
import {
  applyChanges,
  entityKey,
  snapshotSchema,
  stateChangeSchema,
} from "@home-agent/api/household";
import {
  accountId,
  device,
  epoch,
  householdSnapshot,
  withDevices,
} from "./support/household";

describe("atomic household changes with structural sharing", () => {
  it("updates one device's preparation failure without changing its accepted spec or peers", () => {
    const first = device({ spec_id: "urn:shared", spec_status: "ready" });
    const second = device({
      id: "device-2",
      device_id: "device-2",
      spec_id: "urn:shared",
      spec_status: "ready",
    });
    const baseline = withDevices(first, second);
    const projection = snapshotSchema.parse(baseline).projection;
    const firstKey = entityKey(first.account_id, first.device_id);
    const secondKey = entityKey(second.account_id, second.device_id);
    const batch = stateChangeSchema.parse({
      scope_epoch: epoch,
      sequence: 2,
      changes: [
        {
          op: "upsert",
          entity: "device",
          key: firstKey,
          value: {
            ...first,
            spec_status: "error",
            spec_error: { code: "mijia_spec_failed", message: "规格读取失败" },
          },
        },
      ],
    });
    const next = applyChanges(projection, batch);
    expect(next.device[firstKey]).toMatchObject({
      spec_id: "urn:shared",
      spec_status: "error",
      spec_error: { code: "mijia_spec_failed" },
    });
    expect(next.device[secondKey]).toBe(projection.device[secondKey]);
    expect(next.device[secondKey]?.spec_status).toBe("ready");
    expect(next.device[secondKey]?.spec_error).toBeNull();
    expect(next.home).toBe(projection.home);
    expect(next).not.toHaveProperty("spec");
  });

  it("preserves unchanged domains and device entries while updating an entire batch", () => {
    const first = device();
    const second = device({ id: "device-2", device_id: "device-2" });
    const projection = withDevices(first, second).projection;
    const firstKey = entityKey(first.account_id, first.device_id);
    const secondKey = entityKey(second.account_id, second.device_id);
    const batch = stateChangeSchema.parse({
      scope_epoch: epoch,
      sequence: 2,
      changes: [
        {
          op: "upsert",
          entity: "device",
          key: firstKey,
          value: { ...first, alias: "阅读灯" },
        },
        {
          op: "upsert",
          entity: "login",
          key: "login",
          value: { ...projection.login.login, material_version: 3 },
        },
      ],
    });
    const next = applyChanges(projection, batch);
    expect(next).not.toBe(projection);
    expect(next.device).not.toBe(projection.device);
    expect(next.device[firstKey]?.alias).toBe("阅读灯");
    expect(next.device[firstKey]).toBe(
      batch.changes.find(
        (change) => change.op === "upsert" && change.entity === "device",
      )?.value,
    );
    expect(next.device[secondKey]).toBe(projection.device[secondKey]);
    expect(next.home).toBe(projection.home);
    expect(next.household).toBe(projection.household);
    expect(next.login.login.material_version).toBe(3);
    expect(projection.device[firstKey]?.alias).toBeNull();
    expect(projection.login.login.material_version).toBe(0);
  });

  it("validates the entire batch at the boundary before applying changes", () => {
    const first = device();
    const projection = withDevices(first).projection;
    const before = structuredClone(projection);
    expect(() =>
      applyChanges(
        projection,
        stateChangeSchema.parse({
          scope_epoch: epoch,
          sequence: 2,
          changes: [
            {
              op: "remove",
              entity: "device",
              key: entityKey(first.account_id, first.device_id),
            },
            {
              op: "upsert",
              entity: "device",
              key: "wrong-identity",
              value: first,
            },
          ],
        }),
      ),
    ).toThrow();
    expect(projection).toEqual(before);
  });

  it("applies repeated edits in order without mutating the original domain", () => {
    const first = device();
    const projection = withDevices(first).projection;
    const key = entityKey(first.account_id, first.device_id);
    const next = applyChanges(projection, {
      scope_epoch: epoch,
      sequence: 2,
      changes: [
        { op: "remove", entity: "device", key },
        {
          op: "upsert",
          entity: "device",
          key,
          value: { ...first, alias: "新名称" },
        },
      ],
    });
    expect(next.device[key]?.alias).toBe("新名称");
    expect(projection.device[key]?.alias).toBeNull();
    expect(
      applyChanges(next, { scope_epoch: epoch, sequence: 3, changes: [] }),
    ).toBe(next);
  });

  it("rejects prototype keys at the record identity boundary", () => {
    const projection = householdSnapshot().projection;
    expect(() =>
      stateChangeSchema.parse({
        scope_epoch: epoch,
        sequence: 2,
        changes: [
          { op: "upsert", entity: "device", key: "__proto__", value: device() },
        ],
      }),
    ).toThrow();
    expect(Object.getPrototypeOf(projection.device)).toBe(Object.prototype);
    expect(Object.keys(projection.device)).toEqual([]);
  });
});

describe("household snapshot and change identities", () => {
  const timestamp = "2026-09-01T00:00:00.000Z";
  const records = [
    {
      entity: "home",
      key: entityKey(accountId, "home-1"),
      value: {
        account_id: accountId,
        home_id: "home-1",
        name: "家",
        shared: false,
        last_seen_at: timestamp,
        archived: false,
      },
    },
    {
      entity: "room",
      key: entityKey(accountId, "home-1", "room-1"),
      value: {
        account_id: accountId,
        home_id: "home-1",
        room_id: "room-1",
        name: "客厅",
        last_seen_at: timestamp,
        archived: false,
      },
    },
    {
      entity: "device",
      key: entityKey(accountId, "device-1"),
      value: device(),
    },
  ];

  it.each(records)(
    "checks $entity identity in snapshots and changes",
    ({ entity, key, value }) => {
      const snapshot = householdSnapshot();
      for (const [recordKey, valid] of [
        [key, true],
        ["wrong-identity", false],
      ] as const) {
        const parsed = snapshotSchema.safeParse({
          ...snapshot,
          projection: {
            ...snapshot.projection,
            [entity]: { [recordKey]: value },
          },
        });
        expect(parsed.success).toBe(valid);
        if (!parsed.success)
          expect(parsed.error.issues).toContainEqual({
            code: "custom",
            message: "Entity identity mismatch",
            path: ["projection", entity, recordKey],
          });
        expect(
          stateChangeSchema.safeParse({
            scope_epoch: epoch,
            sequence: 2,
            changes: [{ op: "upsert", entity, key: recordKey, value }],
          }).success,
        ).toBe(valid);
      }
    },
  );

  it("rejects a device whose vendor id disagrees with its identity", () => {
    const value = device({ id: "another-device" });
    expect(snapshotSchema.safeParse(withDevices(value)).success).toBe(false);
    expect(
      stateChangeSchema.safeParse({
        scope_epoch: epoch,
        sequence: 2,
        changes: [
          {
            op: "upsert",
            entity: "device",
            key: entityKey(value.account_id, value.device_id),
            value,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates record fields even when the snapshot identity matches", () => {
    const snapshot = withDevices(device());
    const key = entityKey(accountId, "device-1");
    const parsed = snapshotSchema.safeParse({
      ...snapshot,
      projection: {
        ...snapshot.projection,
        device: {
          [key]: { ...snapshot.projection.device[key], online: "yes" },
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0]?.path).toEqual([
        "projection",
        "device",
        key,
        "online",
      ]);
  });
});
