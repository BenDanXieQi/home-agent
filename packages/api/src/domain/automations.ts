import type { z } from "zod";
import {
  validateDeviceValue,
  deriveDeviceValue,
  type deviceCapabilitySchema,
  type deviceValueSchema,
} from "./devices";
import type {
  AutomationCapabilities,
  AutomationDefinition,
  AutomationNode,
  AutomationCondition,
  automationOperatorSchema,
} from "../contracts/automations";
export * from "../contracts/automations";
type Scalar = z.infer<typeof deviceValueSchema>;

export function automationPropertyKey(deviceId: string, propertyKey: string) {
  return JSON.stringify([deviceId, propertyKey]);
}

export function collectAutomationConditions(tree: AutomationNode) {
  const pending = [tree];
  const conditions: AutomationCondition[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.kind === "condition") conditions.push(node);
    else pending.push(...node.children.toReversed());
  }
  return conditions;
}

function validateCapabilityValue(
  capability: AutomationCapabilities["properties"][number],
  value: Scalar,
  command: boolean,
) {
  if (capability.kind === "enum")
    return capability.options.some((option) => option.value === value)
      ? null
      : "值不在允许的枚举选项中";
  if (capability.kind === "boolean")
    return typeof value === "boolean" ? null : "需要布尔值";
  if (capability.kind === "text")
    return typeof value === "string" ? null : "需要文本值";
  if (typeof value !== "number" || !Number.isFinite(value))
    return "需要有限数值";
  if (command)
    return validateDeviceValue(
      { format: capability.format, value_range: capability.range ?? undefined },
      value,
    );
  return null;
}

/** Independent backend validation; UI field restrictions are not an authorization boundary. */
export function validateAutomationCapabilities(
  definition: AutomationDefinition,
  capabilities: AutomationCapabilities,
) {
  const problems: string[] = [];
  const properties = new Map(
    capabilities.properties.map((property) => [
      automationPropertyKey(property.device_id, property.property_key),
      property,
    ]),
  );
  const actions = new Map(
    capabilities.actions.map((action) => [
      automationPropertyKey(action.device_id, action.action_key),
      action,
    ]),
  );
  for (const node of collectAutomationConditions(definition.tree)) {
    const predicate = node.predicate;
    if (predicate.kind === "time_window") continue;
    if (predicate.kind === "ai") {
      const refs = new Set<string>();
      for (const ref of predicate.property_refs) {
        const key = automationPropertyKey(ref.device_id, ref.property_key);
        if (refs.has(key)) problems.push(`节点 ${node.id} 的证据属性重复`);
        refs.add(key);
        if (!properties.get(key)?.readable)
          problems.push(`节点 ${node.id} 的证据属性不可读取`);
      }
      continue;
    }
    if (predicate.kind === "event") {
      if (!capabilities.event_types.includes(predicate.event_type))
        problems.push(`节点 ${node.id} 的事件类型尚未支持`);
      continue;
    }
    const capability = properties.get(
      automationPropertyKey(predicate.device_id, predicate.property_key),
    );
    if (!capability || !capability.readable) {
      problems.push(`节点 ${node.id} 引用的设备属性不可读取`);
      continue;
    }
    if (!capability.operators.includes(predicate.operator))
      problems.push(`节点 ${node.id} 的属性不支持此运算符`);
    for (const value of Array.isArray(predicate.value)
      ? predicate.value
      : [predicate.value]) {
      const problem = validateCapabilityValue(capability, value, false);
      if (problem) problems.push(`节点 ${node.id}：${problem}`);
    }
  }
  for (const action of definition.actions) {
    if (action.kind === "notification") {
      if (!capabilities.notification)
        problems.push(`动作 ${action.id} 的通知渠道不可用`);
      continue;
    }
    if (action.kind === "set_property") {
      const capability = properties.get(
        automationPropertyKey(action.device_id, action.property_key),
      );
      if (!capability?.writeable) {
        problems.push(`动作 ${action.id} 引用的设备属性不可写入`);
        continue;
      }
      const problem = validateCapabilityValue(capability, action.value, true);
      if (problem) problems.push(`动作 ${action.id}：${problem}`);
      continue;
    }
    const capability = actions.get(
      automationPropertyKey(action.device_id, action.action_key),
    );
    if (!capability) {
      problems.push(`动作 ${action.id} 引用的设备操作不可用`);
      continue;
    }
    if (capability.inputs.length !== action.inputs.length) {
      problems.push(`动作 ${action.id} 的参数数量不匹配`);
      continue;
    }
    for (const [index, input] of capability.inputs.entries()) {
      const value = action.inputs[index];
      if (value === undefined) continue;
      const problem = validateDeviceValue(
        {
          format: input.format,
          value_range: input.range ?? undefined,
          value_list: input.options.map((option) => ({
            value: option.value,
            name: option.label,
            description: option.label,
          })),
        },
        value,
      );
      if (problem)
        problems.push(`动作 ${action.id} 的参数 ${input.name}：${problem}`);
    }
  }
  return problems;
}

const operators = {
  boolean: ["eq", "neq"],
  enum: ["eq", "neq", "in", "not_in"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  text: ["eq", "neq", "contains", "not_contains"],
} as const satisfies Record<
  string,
  readonly z.infer<typeof automationOperatorSchema>[]
>;

/** Device value semantics belong to devices; rules add their supported operators. */
export function deriveAutomationProperty(
  capability: z.infer<typeof deviceCapabilitySchema>,
) {
  const value = deriveDeviceValue(capability);
  if (!value) return null;
  return {
    ...value,
    description: capability.description,
    operators: [...operators[value.kind]],
    readable: capability.readable,
    writeable: capability.writeable,
  };
}
