import { entityKey, selectRoomFacts } from "@home-agent/api/household";
import {
  deviceSummarySchema,
  type householdOverviewRequestSchema,
  type devicesQueryRequestSchema,
  type deviceStateRequestSchema,
  type membersQueryRequestSchema,
} from "@home-agent/api/household-queries";
import type { z } from "zod";
import type { HouseholdRuntime } from "../runtime";
import type { createMemberRepository } from "../members/repository";
import { accessHousehold } from "../access";
import { HouseholdError } from "../errors";

function paginate<T>(items: T[], input: { offset: number; limit: number }) {
  return {
    items: items.slice(input.offset, input.offset + input.limit),
    total: items.length,
    next_offset:
      input.offset + input.limit < items.length
        ? input.offset + input.limit
        : null,
  };
}

export function createHouseholdQueries(
  household: HouseholdRuntime,
  members: ReturnType<typeof createMemberRepository> | undefined,
) {
  function access(scope: string) {
    const context = accessHousehold(household, scope);
    const devices = Object.values(context.snapshot.projection.device)
      .filter(
        (device) =>
          !device.archived &&
          device.account_id === context.identity.accountId &&
          device.home_id === context.identity.homeId,
      )
      .toSorted((a, b) => a.device_id.localeCompare(b.device_id));
    return {
      ...context,
      devices,
      metadata: {
        state_version: {
          scope_epoch: context.snapshot.scope_epoch,
          sequence: context.snapshot.sequence,
        },
        queried_at: new Date().toISOString(),
      },
    };
  }
  async function readMembers(context: ReturnType<typeof access>) {
    if (!members) throw new HouseholdError("home_storage");
    return (await members.access(context.identity, context.assertCurrent))
      .members;
  }
  return {
    async overview(input: z.infer<typeof householdOverviewRequestSchema>) {
      const context = access(input.scope_epoch);
      const profiles = await readMembers(context);
      const projection = context.snapshot.projection;
      const rooms = Object.values(projection.room)
        .filter(
          (room) =>
            !room.archived &&
            room.account_id === context.identity.accountId &&
            room.home_id === context.identity.homeId,
        )
        .toSorted((a, b) => a.room_id.localeCompare(b.room_id))
        .map((room) => ({
          room_id: room.room_id,
          name: room.name,
          device_count: context.devices.filter(
            (device) => device.room_id === room.room_id,
          ).length,
        }));
      const page = paginate(rooms, input);
      const counts = new Map<string | null, number>();
      for (const device of context.devices)
        counts.set(device.category, (counts.get(device.category) ?? 0) + 1);
      context.assertCurrent();
      return {
        ...context.metadata,
        home_name:
          projection.home[
            entityKey(context.identity.accountId, context.identity.homeId)
          ]?.name ?? "",
        rooms: page.items,
        total: page.total,
        next_offset: page.next_offset,
        device_count: context.devices.length,
        unassigned_device_count: context.devices.filter(
          (device) => device.room_id === null,
        ).length,
        categories: Array.from(counts, ([category, count]) => ({
          category,
          count,
        })),
        members: {
          people: profiles.filter((member) => member.kind === "person").length,
          pets: profiles.filter((member) => member.kind === "pet").length,
        },
      };
    },
    devices(input: z.infer<typeof devicesQueryRequestSchema>) {
      const context = access(input.scope_epoch);
      const query = input.query?.toLocaleLowerCase();
      const matches = context.devices.filter(
        (device) =>
          (input.room_id === undefined || device.room_id === input.room_id) &&
          (input.category === undefined ||
            device.category === input.category) &&
          (!query ||
            [device.name, device.alias, device.model, device.category].some(
              (value) => value?.toLocaleLowerCase().includes(query),
            )),
      );
      const page = paginate(matches, input);
      return {
        ...context.metadata,
        devices: page.items.map((device) => deviceSummarySchema.parse(device)),
        total: page.total,
        next_offset: page.next_offset,
      };
    },
    deviceState(input: z.infer<typeof deviceStateRequestSchema>) {
      const context = access(input.scope_epoch);
      const device = context.devices.find(
        (item) => item.device_id === input.device_id,
      );
      if (!device) throw new HouseholdError("device_not_found");
      const facts = selectRoomFacts(context.snapshot, {
        room_id: device.room_id,
        device_ids: [device.device_id],
        limit: input.limit,
        offset: input.offset,
      });
      let specification:
        | ReturnType<HouseholdRuntime["specification"]>
        | undefined;
      if (device.spec_status === "ready") {
        try {
          specification = household.specification(device.device_id);
        } catch (error) {
          if (
            !(error instanceof HouseholdError) ||
            error.reason !== "spec_unavailable"
          )
            throw error;
        }
      }
      return {
        ...context.metadata,
        device: deviceSummarySchema.parse(device),
        properties: facts.properties.map((fact) => ({
          ...fact,
          value_label: fact.has_value
            ? specification?.spec[
                `prop.${fact.siid}.${fact.piid}`
              ]?.value_list?.find((item) => item.value === fact.value)
                ?.description || null
            : null,
        })),
        coverage: facts.device_coverage[0] ?? null,
        collection: facts.collection,
        total: facts.coverage.properties,
        next_offset: facts.coverage.next_offset,
      };
    },
    async members(input: z.infer<typeof membersQueryRequestSchema>) {
      const context = access(input.scope_epoch);
      const query = input.query?.toLocaleLowerCase();
      const profiles = (await readMembers(context)).filter(
        (member) =>
          (input.kind === undefined || member.kind === input.kind) &&
          (!query ||
            [member.name, member.species, member.description].some((value) =>
              value.toLocaleLowerCase().includes(query),
            )),
      );
      const page = paginate(profiles, input);
      context.assertCurrent();
      return {
        ...context.metadata,
        members: page.items,
        total: page.total,
        next_offset: page.next_offset,
      };
    },
  };
}
