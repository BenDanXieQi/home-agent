import type {
  Projection,
  selectHomeSchema,
  setupHomesSchema,
} from "@home-agent/api/household";
import type { z } from "zod";
import type { playbackReservationSchema } from "@home-agent/api/playback";

type Household = Projection["household"]["household"];

export type HouseholdSourceState = {
  provider: string;
  account_id: Household["account_id"];
  account: Projection["account"]["account"];
  login: Projection["login"]["login"];
  connection: Projection["connection"]["connection"];
  media: Projection["media"]["media"];
  homes: Household["homes"] & z.infer<typeof setupHomesSchema>;
  directory_sync: Household["sync_status"];
  directory_error: Household["error"];
  directory_capacity: boolean;
  directory_storage: boolean;
};

export type HouseholdSource = {
  snapshot: () => HouseholdSourceState;
  subscribe: (listener: () => void) => () => void;
  bindHome: (
    homeId: z.infer<typeof selectHomeSchema>["home_id"],
    assertCurrent: () => void,
    commitBinding: () => void,
  ) => Promise<unknown>;
  refreshDirectory: () => Promise<unknown>;
  logout: () => Promise<unknown>;
  close: () => Promise<unknown>;
  reservePlayback: (
    revision: string,
    id: string,
    channel: 1 | 2,
  ) => z.infer<typeof playbackReservationSchema>;
  failure: (
    error: unknown,
    stage?: "account" | "directory",
  ) => NonNullable<Household["error"]>;
};
