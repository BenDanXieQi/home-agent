import { z } from "zod";
import {
  automationConditionSchema,
  automationPropertyReferenceSchema,
  automationOperatorSchema,
  automationPredicateSchema,
  automationTriggerSchema,
  type AutomationCapabilities,
  type AutomationCondition,
  type AutomationNode,
} from "@home-agent/api/automations";
import {
  isRuleGroup,
  type RuleGroupType,
  type RuleType,
} from "react-querybuilder";

const propertyFieldSchema = z
  .tuple([
    automationPropertyReferenceSchema.shape.device_id,
    automationPropertyReferenceSchema.shape.property_key,
  ])
  .transform(([device_id, property_key]) => ({ device_id, property_key }));

type EditorGroup = RuleGroupType & {
  meta?: {
    presentationRoot?: boolean;
    unaryNot?: boolean;
    notId?: string;
    notSourceId?: string;
  };
};

export const operatorLabels = {
  eq: "等于",
  neq: "不等于",
  in: "属于",
  not_in: "不属于",
  gt: "大于",
  gte: "大于或等于",
  lt: "小于",
  lte: "小于或等于",
  between: "介于",
  contains: "包含",
  not_contains: "不包含",
} satisfies Record<ReturnType<typeof automationOperatorSchema.parse>, string>;

export function propertyFieldName(
  property: Pick<
    AutomationCapabilities["properties"][number],
    "device_id" | "property_key"
  >,
) {
  return JSON.stringify([property.device_id, property.property_key]);
}

export function defaultPropertyValue(
  property: Pick<
    AutomationCapabilities["properties"][number],
    "kind" | "options" | "range"
  >,
) {
  return (
    property.options[0]?.value ??
    (property.kind === "boolean"
      ? false
      : property.kind === "number"
        ? (property.range?.[0] ?? 0)
        : "")
  );
}

export function defaultWindow() {
  return {
    kind: "time_window" as const,
    start: "18:00",
    end: "23:00",
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  };
}

export function conditionToQuery(condition: AutomationCondition) {
  const predicate = condition.predicate;
  return {
    id: condition.id,
    field:
      predicate.kind === "property"
        ? propertyFieldName(predicate)
        : predicate.kind,
    operator: predicate.kind === "property" ? predicate.operator : "eq",
    value: predicate.kind === "property" ? predicate.value : predicate,
    meta: { role: condition.role, trigger: condition.trigger },
  };
}

export function nodeToQuery(node: AutomationNode) {
  const group: EditorGroup = {
    id: node.id,
    combinator: node.kind === "group" && node.operator === "or" ? "or" : "and",
    rules: [],
  };
  if (node.kind === "condition") {
    group.id = crypto.randomUUID();
    group.meta = { presentationRoot: true };
    group.rules.push(conditionToQuery(node));
    return group;
  }
  if (node.operator === "not") {
    const child = node.children[0];
    if (child?.kind === "group" && child.operator !== "not") {
      const inner: EditorGroup = nodeToQuery(child);
      inner.not = true;
      inner.meta = {
        ...inner.meta,
        notId: node.id,
        ...(inner.id ? { notSourceId: inner.id } : {}),
      };
      return inner;
    }
    group.not = true;
    group.meta = { unaryNot: true };
  }
  for (const child of node.children) {
    group.rules.push(
      child.kind === "condition" ? conditionToQuery(child) : nodeToQuery(child),
    );
  }
  return group;
}

export function queryCondition(rule: RuleType) {
  const role =
    rule.field === "event" || rule.meta?.role !== "state" ? "trigger" : "state";
  const trigger =
    rule.field === "event"
      ? { mode: "event" as const }
      : automationTriggerSchema.parse(rule.meta?.trigger ?? { mode: "enter" });
  return automationConditionSchema.parse({
    kind: "condition",
    id: rule.id ?? crypto.randomUUID(),
    role,
    ...(role === "trigger"
      ? {
          trigger:
            trigger.mode === "event" && rule.field !== "event"
              ? { mode: "enter" }
              : trigger,
        }
      : {}),
    predicate:
      rule.field === "time_window" ||
      rule.field === "event" ||
      rule.field === "ai"
        ? automationPredicateSchema.parse(rule.value)
        : {
            kind: "property",
            ...propertyFieldSchema.parse(JSON.parse(rule.field)),
            operator: rule.operator,
            value: rule.value,
          },
  });
}

export function queryToNode(query: EditorGroup) {
  const children: AutomationNode[] = [];
  for (const child of query.rules) {
    children.push(
      isRuleGroup(child) ? queryToNode(child) : queryCondition(child),
    );
  }
  const group: AutomationNode = {
    kind: "group",
    id: query.id ?? crypto.randomUUID(),
    operator: query.combinator === "or" ? "or" : "and",
    children,
  };
  if (query.not) {
    const negation: AutomationNode = {
      kind: "group",
      id:
        typeof query.meta?.notId === "string" &&
        query.meta.notSourceId === query.id
          ? query.meta.notId
          : query.meta?.unaryNot === true && children.length === 1
            ? group.id
            : `not:${group.id}`,
      operator: "not",
      children:
        query.meta?.unaryNot === true && children.length === 1
          ? children
          : [group],
    };
    return negation;
  }
  return query.meta?.presentationRoot === true && children.length === 1
    ? children[0]!
    : group;
}

export function newQuery(capabilities: AutomationCapabilities) {
  const property = capabilities.properties.find((item) => item.readable);
  return nodeToQuery({
    kind: "group",
    id: crypto.randomUUID(),
    operator: "and",
    children: [
      {
        kind: "condition",
        id: crypto.randomUUID(),
        role: "trigger",
        trigger: { mode: "enter" },
        predicate: property
          ? {
              kind: "property",
              device_id: property.device_id,
              property_key: property.property_key,
              operator: "eq",
              value: defaultPropertyValue(property),
            }
          : defaultWindow(),
      },
    ],
  });
}

/** Adapt scalar/list editors while preserving the library's node metadata. */
export function normalizeQuery(query: RuleGroupType) {
  const rules: RuleGroupType["rules"] = [];
  for (const node of query.rules) {
    if (isRuleGroup(node)) {
      rules.push(normalizeQuery(node));
      continue;
    }
    if (
      node.field === "time_window" ||
      node.field === "event" ||
      node.field === "ai"
    ) {
      rules.push(node);
      continue;
    }
    const value: unknown = node.value;
    const multiple = node.operator === "in" || node.operator === "not_in";
    rules.push({
      ...node,
      value:
        node.operator === "between"
          ? Array.isArray(value)
            ? [value[0] ?? 0, value[1] ?? value[0] ?? 0]
            : [value, value]
          : multiple
            ? Array.isArray(value)
              ? value
              : [value]
            : Array.isArray(value)
              ? (value[0] ?? "")
              : value,
    });
  }
  const normalized: RuleGroupType = { ...query, rules };
  return normalized;
}

export function defaultAiCondition() {
  return {
    kind: "ai" as const,
    goal: "",
    property_refs: [],
    interval_seconds: 900,
    max_calls_per_day: 12,
    result_ttl_seconds: 1800,
    evaluate_unchanged: false,
  };
}
