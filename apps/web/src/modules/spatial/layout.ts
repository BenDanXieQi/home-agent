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
    created: next.filter((record) => !old.has(record.id)),
    changed: next.filter((record) => {
      const saved = old.get(record.id);
      return saved && !same(saved, record);
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
  const spaces = diff(
    before.spaces,
    after.spaces,
    (left, right) =>
      left.name === right.name && left.description === right.description,
  );
  const passages = diff(
    before.passages,
    after.passages,
    (left, right) =>
      left.name === right.name &&
      left.description === right.description &&
      left.space_a_id === right.space_a_id &&
      left.space_b_id === right.space_b_id,
  );
  return (
    [
      ["新增空间", spaces.created],
      ["修改空间", spaces.changed],
      ["删除空间", spaces.removed],
      ["新增通道", passages.created],
      ["修改通道", passages.changed],
      ["删除通道", passages.removed],
    ] as const
  )
    .filter(([, records]) => records.length)
    .map(([label, records]) => `${label} ${changedNames(records)}`)
    .join("；");
}

/** Compares a planned layout with the saved snapshot, record by record. */
export function compareLayout(
  snapshot: SpatialSnapshot,
  layout: ReturnType<typeof spatialLayoutSchema.parse>,
) {
  const spaces = new Map(snapshot.spaces.map((record) => [record.id, record]));
  const passages = new Map(
    snapshot.passages.map((record) => [record.id, record]),
  );
  const keptSpaces = new Set(layout.spaces.map((space) => space.id));
  const keptPassages = new Set(layout.passages.map((passage) => passage.id));
  const spaceState = (space: (typeof layout.spaces)[number]) => {
    const saved = spaces.get(space.id);
    if (!saved) return "created" as const;
    return saved.name !== space.name || saved.description !== space.description
      ? ("changed" as const)
      : ("unchanged" as const);
  };
  const passageState = (passage: (typeof layout.passages)[number]) => {
    const saved = passages.get(passage.id);
    if (!saved) return "created" as const;
    return saved.name !== passage.name ||
      saved.description !== passage.description ||
      saved.space_a_id !== passage.space_a_id ||
      saved.space_b_id !== passage.space_b_id
      ? ("changed" as const)
      : ("unchanged" as const);
  };
  const result = {
    spaces: layout.spaces.map((space) => ({
      ...space,
      state: spaceState(space),
    })),
    passages: layout.passages.map((passage) => ({
      ...passage,
      state: passageState(passage),
    })),
    removedSpaces: snapshot.spaces.filter(
      (record) => !keptSpaces.has(record.id),
    ),
    removedPassages: snapshot.passages.filter(
      (record) => !keptPassages.has(record.id),
    ),
    referenced: snapshot.observation_bindings.filter(
      (binding) =>
        (binding.space_id !== null && !keptSpaces.has(binding.space_id)) ||
        (binding.passage_id !== null && !keptPassages.has(binding.passage_id)),
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
