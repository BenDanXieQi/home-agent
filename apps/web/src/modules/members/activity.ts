import { infiniteQueryOptions } from "@tanstack/react-query";
import {
  contextBrowseResponseSchema,
  type contextCursorSchema,
} from "@home-agent/api/household-context";
import { memberActivityDataSchema } from "@home-agent/api/contracts";
import { requestJson } from "../../api/client";
import { memberObservationPlaybackSource } from "../playback/observation";
import type { Member } from "./queries";

export function memberActivityOptions(scope: string, member: Member) {
  const input = {
    scope_epoch: scope,
    table: "context_records" as const,
    search: "",
    entity: { type: member.kind, id: member.id },
  };
  return infiniteQueryOptions({
    queryKey: ["household-context", input, "activity"],
    initialPageParam: null as ReturnType<
      typeof contextCursorSchema.parse
    > | null,
    queryFn: ({ pageParam, signal }) =>
      requestJson(
        (client, options) =>
          client.api["household-context"].browse.$post(
            {
              json: { ...input, cursor: pageParam },
            },
            options,
          ),
        contextBrowseResponseSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: (query) =>
      (query.state.data?.pages.length ?? 0) > 1 ? Infinity : 0,
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) <= 1 && !query.state.error
        ? 5000
        : false,
    retry: false,
    gcTime: 0,
  });
}

export function groupMemberActivities(
  rows: ReturnType<typeof contextBrowseResponseSchema.parse>["rows"],
) {
  const records = [
    ...new Map(
      rows.map((row) => [
        typeof row.id === "string" ? row.id : JSON.stringify(row),
        row,
      ]),
    ).values(),
  ].map((row) => {
    const parsed =
      row.topic === "member_sighting"
        ? memberActivityDataSchema.safeParse(row.data)
        : undefined;
    const data = parsed?.success ? parsed.data : undefined;
    return {
      id: typeof row.id === "string" ? row.id : JSON.stringify(row),
      row,
      data,
      source: data ? memberObservationPlaybackSource(data) : undefined,
      startedAt:
        data?.firstObservedAt ??
        (typeof row.occurredAt === "string" ? Date.parse(row.occurredAt) : 0),
      endedAt: data?.lastObservedAt ?? 0,
    };
  });
  const groups: {
    records: typeof records;
    startedAt: number;
    endedAt: number;
  }[] = [];
  const latest = new Map<string, (typeof groups)[number]>();

  for (const record of records.toSorted(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  )) {
    const data = record.data;
    const current = data?.attribution.current;
    const key = data
      ? JSON.stringify([
          data.deviceId,
          data.channel,
          data.sourceRunId,
          data.mediaGeneration,
        ])
      : undefined;
    const previous = key ? latest.get(key) : undefined;
    const previousAttribution = previous?.records[0]?.data?.attribution.current;
    if (
      previous &&
      current?.kind === "known" &&
      previousAttribution?.kind === "known" &&
      current.association.memberId ===
        previousAttribution.association.memberId &&
      current.association.className ===
        previousAttribution.association.className &&
      record.startedAt <= previous.endedAt + 5000
    ) {
      previous.records.push(record);
      previous.endedAt = Math.max(previous.endedAt, record.endedAt);
      continue;
    }

    const group = {
      records: [record],
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    };
    groups.push(group);
    if (key) {
      if (current?.kind === "known") latest.set(key, group);
      else latest.delete(key);
    }
  }

  return groups
    .toSorted((a, b) => b.startedAt - a.startedAt)
    .map((group) => {
      const first = group.records[0]!;
      const representative =
        group.records.find((record) => {
          const current = record.data?.attribution.current;
          return (
            current?.kind === "known" &&
            current.association.state !== "confirmed"
          );
        }) ?? first;
      return {
        ...group,
        id: first.id,
        representative,
        source:
          group.records.length > 1 && first.source
            ? {
                ...first.source,
                firstObservedAt: group.startedAt,
                lastObservedAt: group.endedAt,
              }
            : first.source,
      };
    });
}
