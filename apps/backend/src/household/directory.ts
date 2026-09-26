import { z } from "zod";
import {
  deviceSchema,
  directorySchema,
  entityKey,
  homeSchema,
  initialSpecification,
  roomSchema,
} from "@home-agent/api/household";
import { mijiaDeviceSchema } from "@home-agent/api/mijia";

/** Complete directory boundary; vendor transport fields are discarded here. */
export const directoryCandidateSchema = z.object({
  accountId: z.string(),
  homeId: z.string().nullable(),
  homes: z.array(
    z.object({
      id: homeSchema.shape.home_id,
      name: homeSchema.shape.name,
      shared: homeSchema.shape.shared,
      rooms: z.array(
        z.object({
          id: roomSchema.shape.room_id,
          name: roomSchema.shape.name,
        }),
      ),
    }),
  ),
  devices: z.array(
    mijiaDeviceSchema.extend({ spec_type: z.string().nullable() }),
  ),
});
export type DirectoryCandidate = z.infer<typeof directoryCandidateSchema>;

export function publicDirectory(input: DirectoryCandidate, now: string) {
  const candidate = directoryCandidateSchema.parse(input);
  const home = candidate.homes.find((item) => item.id === candidate.homeId);
  const account_id = candidate.accountId;
  return directorySchema.parse({
    home: home
      ? {
          [entityKey(account_id, home.id)]: {
            account_id,
            home_id: home.id,
            name: home.name,
            shared: home.shared,
            last_seen_at: now,
            archived: false,
          },
        }
      : {},
    room: Object.fromEntries(
      (home?.rooms ?? []).map((room) => [
        entityKey(account_id, home!.id, room.id),
        {
          account_id,
          home_id: home!.id,
          room_id: room.id,
          name: room.name,
          last_seen_at: now,
          archived: false,
        },
      ]),
    ),
    device: Object.fromEntries(
      candidate.devices.map((device) => [
        entityKey(account_id, device.id),
        deviceSchema.parse({
          ...device,
          account_id,
          device_id: device.id,
          ...initialSpecification,
          category: null,
          capability_tags: [],
          availability: "unknown",
          read_enabled_properties: [],
          alias: null,
          last_seen_at: now,
          archived: false,
        }),
      ]),
    ),
  });
}
