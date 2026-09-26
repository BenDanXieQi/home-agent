import { describe, expect, mock, test } from "bun:test";
import {
  deviceLocations,
  readHomes,
} from "../../../src/mijia/protocols/micloud/homes";

function home(id: string | number, dids: (string | number)[] = []) {
  return {
    id,
    name: `Home ${id}`,
    dids,
    roomlist: [
      { id: `${id}-room`, name: "Living room", dids: ["room-device"] },
    ],
  };
}

describe("authoritative home membership", () => {
  test("merges owned/shared membership pages, normalizes IDs and refines room locations", async () => {
    const request = mock<Parameters<typeof readHomes>[0]>()
      .mockResolvedValueOnce({
        homelist: [home(1, [11])],
        share_home_list: [home("shared", ["shared-device"])],
        has_more: true,
        max_id: 10,
      })
      .mockResolvedValueOnce({
        info: [
          {
            id: 1,
            dids: [11, 12],
            roomlist: [
              { id: "1-room", dids: [12, "room-device"] },
              { id: 20, name: "Bedroom", dids: [13] },
            ],
          },
        ],
        has_more: false,
      });
    const signal = new AbortController().signal;
    const homes = await readHomes(request, signal);
    expect(request.mock.calls).toEqual([
      [
        "/v2/homeroom/gethome",
        {
          limit: 150,
          fetch_share: true,
          fetch_share_dev: true,
          plat_form: 0,
          app_ver: 9,
        },
        signal,
      ],
      [
        "/v2/homeroom/get_dev_room_page",
        { start_id: "10", limit: 150 },
        signal,
      ],
    ]);
    expect(homes[0]).toEqual({
      id: "1",
      name: "Home 1",
      shared: false,
      deviceIds: ["11", "12"],
      rooms: [
        { id: "1-room", name: "Living room", deviceIds: ["room-device", "12"] },
        { id: "20", name: "Bedroom", deviceIds: ["13"] },
      ],
    });
    expect(homes[1]).toMatchObject({
      id: "shared",
      shared: true,
      deviceIds: ["shared-device"],
    });
    const locations = deviceLocations(homes);
    expect(locations.get("11")).toEqual({
      home_id: "1",
      home_name: "Home 1",
      room_id: null,
      room_name: null,
    });
    expect(locations.get("12")).toEqual({
      home_id: "1",
      home_name: "Home 1",
      room_id: "1-room",
      room_name: "Living room",
    });
    expect(locations.get("13")).toMatchObject({ home_id: "1", room_id: "20" });
    expect(locations.has("unlisted-device")).toBe(false);
  });

  test.each([
    { homelist: [home("a"), home("a")] },
    { homelist: [home("a")], share_home_list: [home("a")] },
    { homelist: [home("a")], has_more: true },
    { homelist: [{ id: "a", name: "Home", dids: [] }] },
  ])(
    "rejects ambiguous or incomplete initial membership %j",
    async (response) => {
      const request =
        mock<Parameters<typeof readHomes>[0]>().mockResolvedValue(response);
      await expect(readHomes(request)).rejects.toMatchObject({
        code: "invalid-response",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { info: [{ id: "unknown-home", dids: ["foreign-device"] }] },
    { info: [], has_more: true, max_id: "cursor" },
    { info: [], has_more: true },
  ])("does not accept partial membership after a bad page %j", async (page) => {
    const request = mock<Parameters<typeof readHomes>[0]>()
      .mockResolvedValueOnce({
        homelist: [home("a")],
        has_more: true,
        max_id: "cursor",
      })
      .mockResolvedValueOnce(page);
    await expect(readHomes(request)).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
