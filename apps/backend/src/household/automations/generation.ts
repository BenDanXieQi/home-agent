import {
  automationGenerationLimits,
  collectAutomationConditions,
  type automationGenerateRequestSchema,
} from "@home-agent/api/automations";
import type { z } from "zod";
import type { HouseholdRuntime } from "../runtime";
import { accessHousehold } from "../access";
import { readAutomationCapabilities } from "./capabilities";
import { createAutomationGenerationClient } from "./agent-client";

export function createAutomationGeneration(deps: {
  household: HouseholdRuntime;
  readEventTypes: () => string[];
  readAgentUrl: () => Promise<string>;
}) {
  const generate = createAutomationGenerationClient(deps.readAgentUrl);
  return async (
    input: z.infer<typeof automationGenerateRequestSchema>,
    signal: AbortSignal,
  ) => {
    const current = accessHousehold(deps.household, input.scope_epoch);
    const all = readAutomationCapabilities(
      deps.household,
      deps.readEventTypes(),
    );
    const requested = input.text.toLocaleLowerCase();
    const devices = Object.values(current.snapshot.projection.device);
    const mentioned = (name: string | null) =>
      !!name &&
      name.length >= 2 &&
      requested.includes(name.toLocaleLowerCase());
    const rooms = new Set(
      devices
        .filter((device) => mentioned(device.room_name))
        .map((device) => device.room_name),
    );
    const roomDeviceNames = new Set(
      devices
        .filter((device) => rooms.has(device.room_name))
        .map((device) => device.name.toLocaleLowerCase()),
    );
    const selected = new Set<string>();
    for (const device of devices) {
      if (
        rooms.has(device.room_name) ||
        (mentioned(device.name) &&
          !roomDeviceNames.has(device.name.toLocaleLowerCase()))
      )
        selected.add(device.id);
    }
    if (input.definition) {
      for (const node of collectAutomationConditions(input.definition.tree)) {
        if (node.predicate.kind === "ai")
          for (const ref of node.predicate.property_refs)
            selected.add(ref.device_id);
        if (node.predicate.kind === "property")
          selected.add(node.predicate.device_id);
      }
      for (const action of input.definition.actions)
        if (action.kind !== "notification") selected.add(action.device_id);
    }
    const relevant = selected.size
      ? {
          ...all,
          properties: all.properties.filter((item) =>
            selected.has(item.device_id),
          ),
          actions: all.actions.filter((item) => selected.has(item.device_id)),
        }
      : all;
    const request = {
      text: input.text,
      ...(input.definition ? { definition: input.definition } : {}),
      capabilities: relevant,
    };
    if (
      Buffer.byteLength(JSON.stringify(request)) >
      automationGenerationLimits.requestBytes
    )
      return {
        definition: null,
        behavior: "当前涉及的设备能力过多，暂时无法生成完整规则。",
        clarifications: [
          rooms.size
            ? "请缩小涉及的房间范围；也可以先手动填写名称、条件和动作，再描述希望调整的部分。"
            : "请补充设备所在的房间；也可以先手动填写名称、条件和动作，再描述希望调整的部分。",
        ],
      };
    const result = await generate(request, signal);
    current.assertCurrent();
    return result;
  };
}
