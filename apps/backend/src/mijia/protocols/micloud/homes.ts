import { z } from "zod";
import { MiCloudError } from "./errors";

const id = z
  .union([z.string().min(1), z.number().int().safe()])
  .transform(String);
const dids = z
  .array(id)
  .nullish()
  .transform((value) => value ?? []);
const roomSchema = z.object({ id, name: z.string(), dids });
const homeSchema = z.object({
  id,
  name: z.string(),
  dids,
  roomlist: z.array(roomSchema),
});
const pageFields = {
  has_more: z.boolean().optional(),
  max_id: id.optional(),
};
const homesSchema = z.object({
  homelist: z.array(homeSchema),
  share_home_list: z.array(homeSchema).optional(),
  ...pageFields,
});
const pageSchema = z.object({
  info: z.array(
    z.object({
      id,
      dids,
      roomlist: z
        .array(z.object({ id, name: z.string().optional(), dids }))
        .optional(),
    }),
  ),
  ...pageFields,
});

function homeEntry(home: z.infer<typeof homeSchema>, shared: boolean) {
  return {
    id: home.id,
    name: home.name,
    shared,
    deviceIds: home.dids,
    rooms: home.roomlist.map((room) => ({
      id: room.id,
      name: room.name,
      deviceIds: room.dids,
    })),
  };
}

type CloudRequest = (
  path: string,
  data: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Resolve membership from the home/room API, including its device-membership pages. */
export async function readHomes(request: CloudRequest, signal?: AbortSignal) {
  const result = homesSchema.safeParse(
    await request(
      "/v2/homeroom/gethome",
      {
        limit: 150,
        fetch_share: true,
        fetch_share_dev: true,
        plat_form: 0,
        app_ver: 9,
      },
      signal,
    ),
  );
  if (!result.success) throw new MiCloudError("invalid-response");
  const homes = new Map<string, ReturnType<typeof homeEntry>>();
  for (const [shared, items] of [
    [false, result.data.homelist],
    [true, result.data.share_home_list ?? []],
  ] as const) {
    for (const home of items) {
      if (homes.has(home.id)) throw new MiCloudError("invalid-response");
      homes.set(home.id, homeEntry(home, shared));
    }
  }
  let cursor = result.data.max_id;
  let more = result.data.has_more;
  const seen = new Set<string>();
  while (more) {
    if (!cursor || seen.has(cursor) || seen.size >= 100)
      throw new MiCloudError("invalid-response");
    seen.add(cursor);
    const page = pageSchema.safeParse(
      await request(
        "/v2/homeroom/get_dev_room_page",
        { start_id: cursor, limit: 150 },
        signal,
      ),
    );
    if (!page.success) throw new MiCloudError("invalid-response");
    for (const item of page.data.info) {
      const home = homes.get(item.id);
      if (!home) throw new MiCloudError("invalid-response");
      home.deviceIds.push(...item.dids);
      for (const itemRoom of item.roomlist ?? []) {
        let room = home.rooms.find((entry) => entry.id === itemRoom.id);
        if (!room) {
          room = { id: itemRoom.id, name: itemRoom.name ?? "", deviceIds: [] };
          home.rooms.push(room);
        }
        room.deviceIds.push(...itemRoom.dids);
      }
    }
    more = page.data.has_more;
    cursor = page.data.max_id;
  }
  return [...homes.values()].map((home) => ({
    ...home,
    deviceIds: [...new Set(home.deviceIds)],
    rooms: home.rooms.map((room) => ({
      ...room,
      deviceIds: [...new Set(room.deviceIds)],
    })),
  }));
}

export function homeLocation(
  home?: ReturnType<typeof homeEntry>,
  room?: ReturnType<typeof homeEntry>["rooms"][number],
) {
  return {
    home_id: home?.id ?? null,
    home_name: home?.name ?? null,
    room_id: room?.id ?? null,
    room_name: room?.name ?? null,
  };
}

export type DeviceLocation = ReturnType<typeof homeLocation>;

export function deviceLocations(homes: Awaited<ReturnType<typeof readHomes>>) {
  const locations = new Map<string, DeviceLocation>();
  for (const home of homes) {
    for (const did of home.deviceIds) {
      locations.set(did, homeLocation(home));
    }
    for (const room of home.rooms) {
      for (const did of room.deviceIds) {
        locations.set(did, homeLocation(home, room));
      }
    }
  }
  return locations;
}
