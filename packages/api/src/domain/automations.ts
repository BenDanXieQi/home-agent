import type { z } from "zod";
import {
  deriveDeviceValue,
  validateDeviceValue,
  type deviceCapabilitySchema,
  type deviceValueSchema,
} from "./devices";
import type { latestPropertySchema } from "../contracts/observations";
import type {
  AutomationCapabilities,
  AutomationCondition,
  AutomationDefinition,
  AutomationNode,
  AutomationPredicate,
  automationEventSchema,
  automationNodeResultSchema,
  automationOperatorSchema,
  automationAiValueSchema,
} from "../contracts/automations";

export * from "../contracts/automations";

type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;
type Scalar = z.infer<typeof deviceValueSchema>;
type Operator = z.infer<typeof automationOperatorSchema>;
type NodeResult = z.infer<typeof automationNodeResultSchema>;

const operators = {
  boolean: ["eq", "neq"],
  enum: ["eq", "neq", "in", "not_in"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  text: ["eq", "neq", "contains", "not_contains"],
} as const satisfies Record<string, readonly Operator[]>;

/** Device value semantics belong to devices; rules add their supported operators. */
export function deriveAutomationProperty(capability: DeviceCapability) {
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

export function automationPropertyKey(deviceId: string, propertyKey: string) {
  return JSON.stringify([deviceId, propertyKey]);
}

export function automationPropertyAddress(propertyKey: string) {
  const match = /^prop\.([1-9]\d*)\.([1-9]\d*)$/.exec(propertyKey);
  if (!match) return null;
  const siid = Number(match[1]);
  const piid = Number(match[2]);
  if (!Number.isSafeInteger(siid) || !Number.isSafeInteger(piid)) return null;
  return { siid, piid };
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

export function collectAutomationDependencies(tree: AutomationNode) {
  return collectAutomationConditions(tree).map((node) => ({
    node_id: node.id,
    role: node.role,
    ...node.predicate,
  }));
}

function compareProperty(
  predicate: Extract<AutomationPredicate, { kind: "property" }>,
  actual: Scalar,
) {
  const expected = predicate.value;
  switch (predicate.operator) {
    case "eq":
      return typeof actual === typeof expected ? actual === expected : null;
    case "neq":
      return typeof actual === typeof expected ? actual !== expected : null;
    case "in":
      return Array.isArray(expected) ? expected.includes(actual) : null;
    case "not_in":
      return Array.isArray(expected) ? !expected.includes(actual) : null;
    case "gt":
      return typeof actual === "number" && typeof expected === "number"
        ? actual > expected
        : null;
    case "gte":
      return typeof actual === "number" && typeof expected === "number"
        ? actual >= expected
        : null;
    case "lt":
      return typeof actual === "number" && typeof expected === "number"
        ? actual < expected
        : null;
    case "lte":
      return typeof actual === "number" && typeof expected === "number"
        ? actual <= expected
        : null;
    case "contains":
      return typeof actual === "string" && typeof expected === "string"
        ? actual.includes(expected)
        : null;
    case "not_contains":
      return typeof actual === "string" && typeof expected === "string"
        ? !actual.includes(expected)
        : null;
    case "between": {
      if (!Array.isArray(expected) || expected.length !== 2) return null;
      const [minimum, maximum] = expected;
      return typeof actual === "number" &&
        typeof minimum === "number" &&
        typeof maximum === "number"
        ? actual >= minimum && actual <= maximum
        : null;
    }
  }
  return null;
}

const isoWeekdays = new Map([
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
  ["Sun", 7],
]);

/** Midnight-crossing windows use the weekday of the start, with an exclusive end. */
export function evaluateAutomationTimeWindow(
  predicate: Extract<AutomationPredicate, { kind: "time_window" }>,
  now: Date,
) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: predicate.time_zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = isoWeekdays.get(values.get("weekday") ?? "");
  if (!weekday) return null;
  const minute = Number(values.get("hour")) * 60 + Number(values.get("minute"));
  const start =
    Number(predicate.start.slice(0, 2)) * 60 + Number(predicate.start.slice(3));
  const end =
    Number(predicate.end.slice(0, 2)) * 60 + Number(predicate.end.slice(3));
  if (start < end)
    return (
      predicate.weekdays.includes(weekday) && minute >= start && minute < end
    );
  if (minute >= start) return predicate.weekdays.includes(weekday);
  if (minute < end)
    return predicate.weekdays.includes(weekday === 1 ? 7 : weekday - 1);
  return false;
}

/** Event input is one accepted occurrence, never a cached "latest event" value. */
export function evaluateAutomationPredicate(
  predicate: AutomationPredicate,
  input: {
    now: Date;
    ai?: z.infer<typeof automationAiValueSchema>;
    property?: Pick<
      z.infer<typeof latestPropertySchema>,
      "has_value" | "value" | "reason" | "expires_at"
    > | null;
    event?: z.infer<typeof automationEventSchema> | null;
  },
) {
  if (predicate.kind === "ai") {
    const ai = input.ai;
    return !ai ||
      !ai.expires_at ||
      Date.parse(ai.expires_at) <= input.now.getTime()
      ? { truth: null, reason: "AI 尚未判断或结果已过期" }
      : { truth: ai.truth, reason: ai.reason };
  }
  if (predicate.kind === "time_window") {
    return {
      truth: evaluateAutomationTimeWindow(predicate, input.now),
      reason: null,
    };
  }
  if (predicate.kind === "event") {
    const event = input.event;
    if (!event) return { truth: false, reason: "本次没有独立事件" };
    if (Date.parse(event.expires_at) <= input.now.getTime())
      return { truth: false, reason: "事件已经过期" };
    if (Date.parse(event.occurred_at) > input.now.getTime())
      return { truth: null, reason: "事件时间晚于当前评估时间" };
    return {
      truth:
        event.event_type === predicate.event_type &&
        (!predicate.device_id || event.device_id === predicate.device_id),
      reason: null,
    };
  }
  const property = input.property;
  if (!property || !property.has_value)
    return { truth: null, reason: "缺少设备当前值" };
  if (
    !["current", "cloud_cache", "baseline", "unverified"].includes(
      property.reason,
    )
  )
    return { truth: null, reason: property.reason };
  if (
    property.expires_at &&
    Date.parse(property.expires_at) <= input.now.getTime()
  )
    return { truth: null, reason: "expired" };
  if (property.value === null) return { truth: null, reason: "invalid_value" };
  const truth = compareProperty(predicate, property.value);
  return {
    truth,
    reason:
      truth === null
        ? "条件与设备值的类型不匹配"
        : property.reason === "cloud_cache"
          ? "按云端缓存值判断，等待设备上报"
          : null,
  };
}

/** Trigger provenance follows the branches proving the current result. */
export function evaluateAutomationTree(
  tree: AutomationNode,
  values: Readonly<Record<string, Pick<NodeResult, "truth" | "reason">>>,
  firedNodeIds: ReadonlySet<string> = new Set(),
) {
  const results = new Map<string, NodeResult>();
  const pending = [{ node: tree, visited: false }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const node = entry.node;
    if (node.kind === "condition") {
      const value = values[node.id];
      const raw = value?.truth ?? null;
      const truth = raw !== null && node.trigger?.mode === "exit" ? !raw : raw;
      results.set(node.id, {
        node_id: node.id,
        truth,
        reason: value?.reason ?? (truth === null ? "缺少条件输入" : null),
        triggered_by:
          truth !== null && node.role === "trigger" && firedNodeIds.has(node.id)
            ? [node.id]
            : [],
      });
      continue;
    }
    if (!entry.visited) {
      pending.push({ node, visited: true });
      for (const child of node.children.toReversed())
        pending.push({ node: child, visited: false });
      continue;
    }
    const children = node.children.map((child) => results.get(child.id));
    const childValues = children.map((child) => child?.truth ?? null);
    const truth =
      node.operator === "not"
        ? childValues[0] === null || childValues[0] === undefined
          ? null
          : !childValues[0]
        : node.operator === "and"
          ? childValues.includes(false)
            ? false
            : childValues.includes(null)
              ? null
              : true
          : childValues.includes(true)
            ? true
            : childValues.includes(null)
              ? null
              : false;
    const proving =
      node.operator === "not"
        ? children
        : children.filter((child) => child?.truth === truth);
    results.set(node.id, {
      node_id: node.id,
      truth,
      reason: truth === null ? "条件包含未知值" : null,
      triggered_by:
        truth === null
          ? []
          : [...new Set(proving.flatMap((child) => child?.triggered_by ?? []))],
    });
  }
  const root = results.get(tree.id);
  return {
    truth: root?.truth ?? null,
    eligible: root?.truth === true && root.triggered_by.length > 0,
    triggered_by: root?.triggered_by ?? [],
    nodes: [...results.values()],
  };
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
  if (definition.decision)
    problems.push("当前尚未启用 AI 动作选择，请使用固定动作");
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
      problems.push(`节点 ${node.id} 使用了尚未启用的 AI 判断条件`);
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
