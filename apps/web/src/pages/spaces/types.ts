import type {
  SpatialSnapshot,
  SpatialCommand,
} from "../../modules/spatial/api";

export type Editor =
  | { resource: "space"; record: SpatialSnapshot["spaces"][number] | null }
  | { resource: "passage"; record: SpatialSnapshot["passages"][number] | null }
  | {
      resource: "binding";
      record: SpatialSnapshot["observation_bindings"][number] | null;
    };
export type Deletion = Extract<SpatialCommand, { action: "delete" }> & {
  label: string;
};
