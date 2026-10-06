import { describe, expect, it } from "vitest";
import {
  confirmSpatialCommand,
  type SpatialSnapshot,
  type SpatialCommand,
} from "../../../src/modules/spatial/api";
import { createApiClient } from "../../../src/api/client";
import { spatialDeleteResultSchema } from "@home-agent/api/spatial";

const id = "aa000000-0000-4000-8000-000000000001";
const previous = "2026-10-06T01:00:00.000Z";
const latest = "2026-10-06T01:00:00.001Z";
const scope = { account_id: "account", home_id: "home", updated_at: previous };
const initial: SpatialSnapshot = {
  scope,
  spaces: [
    {
      id,
      name: "客厅",
      description: "旧说明",
      created_at: previous,
      updated_at: previous,
    },
  ],
  passages: [],
  observation_bindings: [],
};
const save: SpatialCommand = {
  action: "save",
  resource: "space",
  input: {
    scope,
    id,
    name: "客厅",
    description: "新说明",
    operation: "update",
    expected_updated_at: previous,
  },
};

describe("spatial mutation recovery", () => {
  it("distinguishes committed writes, unchanged records and another writer", () => {
    expect(confirmSpatialCommand(save, initial)).toBe("not-applied");
    const record = initial.spaces[0]!;
    expect(
      confirmSpatialCommand(save, {
        ...initial,
        spaces: [{ ...record, description: "新说明", updated_at: latest }],
      }),
    ).toBe("confirmed");
    expect(
      confirmSpatialCommand(save, {
        ...initial,
        spaces: [{ ...record, description: "其他编辑", updated_at: latest }],
      }),
    ).toBe("changed");
  });
  it("confirms a deleted record and rejects the same outcome from a different household binding", () => {
    const command: SpatialCommand = {
      action: "delete",
      resource: "space",
      input: { scope, id, expected_updated_at: previous },
    };
    expect(confirmSpatialCommand(command, { ...initial, spaces: [] })).toBe(
      "confirmed",
    );
    expect(
      confirmSpatialCommand(command, {
        ...initial,
        scope: { ...scope, updated_at: latest },
        spaces: [],
      }),
    ).toBe("scope-changed");
  });
  it("keeps business reference conflicts distinct from error responses sharing HTTP 409", async () => {
    const errorClient = createApiClient("http://localhost", async () =>
      Response.json(
        { code: "spatial_record_changed", message: "Changed" },
        { status: 409 },
      ),
    );
    await expect(
      errorClient.requestJson(
        (api, options) =>
          api.api.spatial.spaces.delete.$post(
            { json: { scope, id, expected_updated_at: previous } },
            options,
          ),
        spatialDeleteResultSchema,
        { acceptedStatuses: [409] },
      ),
    ).rejects.toMatchObject({
      details: { code: "spatial_record_changed" },
      status: 409,
    });
    const result = {
      status: "referenced",
      id,
      references: {
        passages: [],
        observation_bindings: [
          {
            id,
            device_id: "sensor",
            channel: null,
            space_id: id,
            passage_id: null,
            enabled: false,
            description: "",
            created_at: previous,
            updated_at: previous,
          },
        ],
      },
    };
    const conflictClient = createApiClient("http://localhost", async () =>
      Response.json(result, { status: 409 }),
    );
    expect(
      await conflictClient.requestJson(
        (api, options) =>
          api.api.spatial.spaces.delete.$post(
            { json: { scope, id, expected_updated_at: previous } },
            options,
          ),
        spatialDeleteResultSchema,
        { acceptedStatuses: [409] },
      ),
    ).toEqual(result);
  });
});
