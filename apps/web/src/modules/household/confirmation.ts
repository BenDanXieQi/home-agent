import type {
  snapshotSchema,
  stateVersionSchema,
} from "@home-agent/api/household";
export type Confirmation = {
  version: ReturnType<typeof stateVersionSchema.parse> | null;
  snapshotAfter: number | null;
};
export function isHouseholdConfirmed(
  snapshot: ReturnType<typeof snapshotSchema.parse> | undefined,
  received: number,
  confirmation: Confirmation,
) {
  return (
    !!snapshot &&
    ((confirmation.version !== null &&
      snapshot.scope_epoch === confirmation.version.scope_epoch &&
      snapshot.sequence >= confirmation.version.sequence) ||
      (confirmation.snapshotAfter !== null &&
        received > confirmation.snapshotAfter))
  );
}
