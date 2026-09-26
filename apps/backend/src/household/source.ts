import type { Projection, selectHomeSchema } from "@home-agent/api/household";
import type {
  mijiaPlaybackReservationResponseSchema,
  mijiaHomeSelectionSchema,
} from "@home-agent/api/mijia";
import type { z } from "zod";

type Household = Projection["household"]["household"];

/** Safe integration state consumed by the household lifecycle. */
export type HouseholdSourceState = {
  provider: string;
  account_id: Household["account_id"];
  account: Projection["account"]["account"];
  login: Projection["login"]["login"];
  connection: Projection["connection"]["connection"];
  media: Projection["media"]["media"];
  homes: z.infer<typeof mijiaHomeSelectionSchema>;
  directory_sync: Household["sync_status"];
  directory_error: Household["error"];
  directory_capacity: boolean;
  directory_storage: boolean;
};

/** Account and media resources stay with their integration adapter. */
export type HouseholdSource = {
  snapshot: () => HouseholdSourceState;
  subscribe: (listener: () => void) => () => void;
  /** Validate, save and install the fixed binding before acquiring devices or media. */
  bindHome: (
    homeId: z.infer<typeof selectHomeSchema>["home_id"],
    assertCurrent: () => void,
  ) => Promise<unknown>;
  refreshDirectory: () => Promise<unknown>;
  logout: () => Promise<unknown>;
  close: () => Promise<unknown>;
  reservePlayback: (
    revision: string,
    id: string,
    channel: 1 | 2,
  ) => z.infer<typeof mijiaPlaybackReservationResponseSchema>;
  failure: (
    error: unknown,
    stage?: "account" | "directory",
  ) => NonNullable<Household["error"]>;
};
