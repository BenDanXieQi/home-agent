import { prepareProjection } from "./projection";
import { z } from "zod";
import {
  type Projection,
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

export function publicDirectory(
  input: DirectoryCandidate,
  previous: Projection,
) {
  const candidate = directoryCandidateSchema.parse(input);
  const home = candidate.homes.find((item) => item.id === candidate.homeId);
  const account_id = candidate.accountId;
  const incoming = {
    home: home
      ? {
          [entityKey(account_id, home.id)]: {
            account_id,
            home_id: home.id,
            name: home.name,
            shared: home.shared,
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
          archived: false,
        },
      ]),
    ),
    device: Object.fromEntries(
      candidate.devices.map((device) => [
        entityKey(account_id, device.id),
        {
          ...initialSpecification,
          category: null,
          capability_tags: [],
          availability: "unknown" as const,
          read_enabled_properties: [],
          alias: null,
          ...previous.device[entityKey(account_id, device.id)],
          ...device,
          account_id,
          device_id: device.id,
          archived: false,
        },
      ]),
    ),
  };
  const { projection } = prepareProjection(
    { projection: previous },
    { ...previous, ...incoming },
  );
  return {
    home: projection.home,
    room: projection.room,
    device: projection.device,
  };
}
