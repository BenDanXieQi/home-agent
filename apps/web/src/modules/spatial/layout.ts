import { spatialLayoutSchema } from "@home-agent/api/spatial";
import type { SpatialSnapshot } from "./api";

export function snapshotLayout(snapshot: SpatialSnapshot) {
  return spatialLayoutSchema.parse({
    spaces: snapshot.spaces.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    passages: snapshot.passages.map(
      ({ id, name, description, space_a_id, space_b_id }) => ({
        id,
        name,
        description,
        space_a_id,
        space_b_id,
      }),
    ),
  });
}

export function layoutVersions(snapshot: SpatialSnapshot) {
  return {
    spaces: snapshot.spaces.map(({ id, updated_at }) => ({ id, updated_at })),
    passages: snapshot.passages.map(({ id, updated_at }) => ({
      id,
      updated_at,
    })),
  };
}

const versions = (records: { id: string; updated_at: string }[]) =>
  new Map(records.map((record) => [record.id, record.updated_at]));

export function sameLayoutVersions(
  left: SpatialSnapshot,
  right: SpatialSnapshot,
) {
  return (["spaces", "passages"] as const).every((key) => {
    const expected = versions(left[key]);
    return (
      expected.size === right[key].length &&
      right[key].every(
        (record) => expected.get(record.id) === record.updated_at,
      )
    );
  });
}

function diff<T extends { id: string; name: string }>(
  previous: T[],
  next: T[],
  same: (left: T, right: T) => boolean,
) {
  const old = new Map(previous.map((record) => [record.id, record]));
  const kept = new Set(next.map((record) => record.id));
  return {
    kept,
    items: next.map((record) => {
      const saved = old.get(record.id);
      const state = !saved
        ? ("created" as const)
        : same(saved, record)
          ? ("unchanged" as const)
          : ("changed" as const);
      return { ...record, state };
    }),
    removed: previous.filter((record) => !kept.has(record.id)),
  };
}

const changedNames = (records: { name: string }[]) =>
  records.length > 3
    ? `${records
        .slice(0, 3)
        .map((record) => record.name)
        .join("、")} 等 ${records.length} 个`
    : records.map((record) => record.name).join("、");

/** Lists, by name, what one planning round changed in the draft. */
export function describeLayoutChange(
  before: ReturnType<typeof spatialLayoutSchema.parse>,
  after: ReturnType<typeof spatialLayoutSchema.parse>,
) {
  const comparison = compareLayout(before, after);
  return (
    [
      [
        "新增空间",
        comparison.spaces.filter((record) => record.state === "created"),
      ],
      [
        "修改空间",
        comparison.spaces.filter((record) => record.state === "changed"),
      ],
      ["删除空间", comparison.removedSpaces],
      [
        "新增通道",
        comparison.passages.filter((record) => record.state === "created"),
      ],
      [
        "修改通道",
        comparison.passages.filter((record) => record.state === "changed"),
      ],
      ["删除通道", comparison.removedPassages],
    ] as const
  )
    .filter(([, records]) => records.length)
    .map(([label, records]) => `${label} ${changedNames(records)}`)
    .join("；");
}

/** Compares a planned layout with the saved snapshot, record by record. */
export function compareLayout(
  snapshot: ReturnType<typeof spatialLayoutSchema.parse> &
    Partial<Pick<SpatialSnapshot, "observation_bindings">>,
  layout: ReturnType<typeof spatialLayoutSchema.parse>,
) {
  const spaces = diff(
    snapshot.spaces,
    layout.spaces,
    (left, right) =>
      left.name === right.name && left.description === right.description,
  );
  const passages = diff(
    snapshot.passages,
    layout.passages,
    (left, right) =>
      left.name === right.name &&
      left.description === right.description &&
      left.space_a_id === right.space_a_id &&
      left.space_b_id === right.space_b_id,
  );
  const result = {
    spaces: spaces.items,
    passages: passages.items,
    removedSpaces: spaces.removed,
    removedPassages: passages.removed,
    referenced: (snapshot.observation_bindings ?? []).filter(
      (binding) =>
        (binding.space_id !== null && !spaces.kept.has(binding.space_id)) ||
        (binding.passage_id !== null && !passages.kept.has(binding.passage_id)),
    ),
  };
  const count = (state: "created" | "changed") =>
    result.spaces.filter((space) => space.state === state).length +
    result.passages.filter((passage) => passage.state === state).length;
  const counts = {
    created: count("created"),
    changed: count("changed"),
    removed: result.removedSpaces.length + result.removedPassages.length,
  };
  return {
    ...result,
    counts,
    changes: counts.created + counts.changed + counts.removed,
  };
}
