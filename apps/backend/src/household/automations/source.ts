import {
  collectAutomationConditions,
  type AutomationDefinition,
  type AutomationEvaluation,
} from "@home-agent/api/automations";
import type { z } from "zod";
import type { automationInputSchema } from "./state";
import type { AutomationProperties } from "./properties";
import type { HouseholdRuntime } from "../runtime";

export function createAutomationSource(
  definition: AutomationDefinition,
  input: z.infer<typeof automationInputSchema>,
  evaluation: AutomationEvaluation,
  context: {
    devices: ReturnType<HouseholdRuntime["snapshot"]>["projection"]["device"];
    specs: ReturnType<HouseholdRuntime["specifications"]>;
    propertyReference: AutomationProperties["reference"];
  },
) {
  const ids = new Set(evaluation.triggered_by);
  const conditions = collectAutomationConditions(definition.tree);
  const selected = conditions.filter((node) => ids.has(node.id));
  const devices = new Map(
    Object.values(context.devices).map((device) => [device.device_id, device]),
  );
  const texts: string[] = [];
  for (const node of selected) {
    const trigger = node.trigger;
    const predicate = node.predicate;
    if (!trigger || predicate.kind === "ai") break;
    const mode =
      trigger.mode === "sustained"
        ? `sustained（持续 ${trigger.duration_seconds} 秒）`
        : trigger.mode;
    let detail;
    if (predicate.kind === "property") {
      const device = devices.get(predicate.device_id);
      const capability = device?.spec_id
        ? context.specs[device.spec_id]?.spec[predicate.property_key]
        : undefined;
      const fact = input.facts.find(
        (item) =>
          item.device_id === predicate.device_id &&
          context.propertyReference(item).property_key ===
            predicate.property_key,
      );
      detail = `${device?.name ?? "未知设备"}（${predicate.device_id}）/${capability?.description ?? "未知属性"}（${predicate.property_key}） ${predicate.operator} ${JSON.stringify(predicate.value)}；单位：${capability?.unit ?? "未知"}；本次原值：${fact?.has_value ? JSON.stringify(fact.value) : "未知"}；报告时间：${fact?.last_report_at ?? "未知"}`;
    } else if (predicate.kind === "time_window") {
      detail = `时区 ${predicate.time_zone}；星期 ${predicate.weekdays.join(",")}（ISO 1=周一，7=周日）；${predicate.start}–${predicate.end}`;
    } else {
      const event = input.event;
      detail = `事件 ${predicate.event_type}；来源设备：${event?.device_id ?? "未知"}；时间：${event?.occurred_at ?? "未知"}`;
    }
    texts.push(`${mode}：${detail}`);
  }
  return {
    executor: "automation" as const,
    rule_name: definition.name,
    trigger_text:
      ids.size > 0 &&
      selected.length === ids.size &&
      texts.length === selected.length &&
      !conditions.some((node) => node.predicate.kind === "ai")
        ? texts.join("；\n")
        : null,
  };
}
