import { z } from "zod";
import { deviceValueSchema } from "../domain/devices";
import { latestPropertySchema, propertyValueSchema } from "./observations";

export const automationLimits = {
  nodes: 128,
  depth: 12,
  children: 32,
  actions: 16,
  durationSeconds: 7 * 24 * 60 * 60,
} as const;

const identifier = z.string().min(1).max(128);
const deviceId = z.string().min(1).max(512);
export const automationOperatorSchema = z.enum([
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "not_contains",
]);
export const automationPropertyReferenceSchema = z.strictObject({
  device_id: deviceId,
  property_key: z.string().regex(/^prop\.[1-9]\d*\.[1-9]\d*$/),
});
export const automationPropertyPredicateSchema =
  automationPropertyReferenceSchema.extend({
    kind: z.literal("property"),
    operator: automationOperatorSchema,
    value: z.union([
      deviceValueSchema,
      z.array(deviceValueSchema).min(1).max(64),
    ]),
  });
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const automationTimeWindowSchema = z.strictObject({
  kind: z.literal("time_window"),
  start: clockTime,
  end: clockTime,
  time_zone: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => {
      try {
        return (
          new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
            .timeZone.length > 0
        );
      } catch {
        return false;
      }
    }, "无效的时区"),
  // ISO weekdays. Overnight windows belong to the day on which they start.
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
});
export const automationEventPredicateSchema = z.strictObject({
  kind: z.literal("event"),
  event_type: identifier,
  device_id: deviceId.optional(),
});
export const automationAiPredicateSchema = z.strictObject({
  kind: z.literal("ai"),
  goal: z.string().trim().min(1).max(4000),
  property_refs: z.array(automationPropertyReferenceSchema).min(1).max(50),
  interval_seconds: z.number().int().min(300).max(86400),
  max_calls_per_day: z.number().int().min(1).max(48),
  result_ttl_seconds: z.number().int().min(60).max(86400),
  evaluate_unchanged: z.boolean(),
});
export const automationAiValueSchema = z.object({
  truth: z.boolean().nullable(),
  reason: z.string().nullable(),
  expires_at: z.iso.datetime().nullable(),
});
export const automationPredicateSchema = z.discriminatedUnion("kind", [
  automationPropertyPredicateSchema,
  automationEventPredicateSchema,
  automationTimeWindowSchema,
  automationAiPredicateSchema,
]);
export const automationTriggerSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("enter") }),
  z.strictObject({ mode: z.literal("exit") }),
  z.strictObject({
    mode: z.literal("sustained"),
    duration_seconds: z
      .number()
      .int()
      .min(1)
      .max(automationLimits.durationSeconds),
  }),
  z.strictObject({ mode: z.literal("event") }),
]);
export const automationConditionSchema = z.strictObject({
  kind: z.literal("condition"),
  id: identifier,
  role: z.enum(["trigger", "state"]),
  predicate: automationPredicateSchema,
  trigger: automationTriggerSchema.optional(),
});
export const automationGroupSchema = z.strictObject({
  kind: z.literal("group"),
  id: identifier,
  operator: z.enum(["and", "or", "not"]),
  get children() {
    return z
      .array(z.union([automationGroupSchema, automationConditionSchema]))
      .min(1)
      .max(automationLimits.children);
  },
});
export const automationNodeSchema = z.union([
  automationGroupSchema,
  automationConditionSchema,
]);
export const automationActionSchema = z.discriminatedUnion("kind", [
  automationPropertyReferenceSchema.extend({
    id: identifier,
    kind: z.literal("set_property"),
    value: deviceValueSchema,
  }),
  z.strictObject({
    id: identifier,
    kind: z.literal("invoke_action"),
    device_id: deviceId,
    action_key: z.string().regex(/^action\.[1-9]\d*\.[1-9]\d*$/),
    inputs: z.array(deviceValueSchema).max(32),
  }),
  z.strictObject({
    id: identifier,
    kind: z.literal("notification"),
    message: z.string().trim().min(1).max(4000),
  }),
]);

export const automationDefinitionSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2000).default(""),
    tree: automationNodeSchema,
    actions: z
      .array(automationActionSchema)
      .min(1)
      .max(automationLimits.actions),
    decision: z
      .strictObject({ goal: z.string().trim().min(1).max(4000) })
      .optional(),
    cooldown_seconds: z
      .number()
      .int()
      .min(0)
      .max(automationLimits.durationSeconds)
      .default(0),
    action_ttl_seconds: z.number().int().min(1).max(3600).default(60),
  })
  .superRefine((definition, context) => {
    const pending = [{ node: definition.tree, depth: 1 }];
    const ids = new Set<string>();
    let triggerCount = 0;
    while (pending.length) {
      const item = pending.pop();
      if (!item) break;
      const { node, depth } = item;
      if (ids.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: `节点 ID 重复：${node.id}`,
          path: ["tree"],
        });
        return;
      }
      ids.add(node.id);
      if (ids.size > automationLimits.nodes || depth > automationLimits.depth) {
        context.addIssue({
          code: "custom",
          message: "规则树超过节点数量或嵌套深度限制",
          path: ["tree"],
        });
        return;
      }
      if (node.kind === "group") {
        if (node.operator === "not" && node.children.length !== 1) {
          context.addIssue({
            code: "custom",
            message: "NOT 必须且只能有一个子节点",
            path: ["tree"],
          });
        }
        for (const child of node.children)
          pending.push({ node: child, depth: depth + 1 });
        continue;
      }
      if (node.role === "trigger") triggerCount += 1;
      if ((node.role === "trigger") !== (node.trigger !== undefined)) {
        context.addIssue({
          code: "custom",
          message: `节点 ${node.id} 的触发／状态角色与触发方式不一致`,
          path: ["tree"],
        });
      }
      if (
        node.predicate.kind === "event" &&
        (node.role !== "trigger" || node.trigger?.mode !== "event")
      ) {
        context.addIssue({
          code: "custom",
          message: "独立事件只能作为事件触发，不能作为持续状态",
          path: ["tree"],
        });
      }
      if (node.predicate.kind !== "event" && node.trigger?.mode === "event") {
        context.addIssue({
          code: "custom",
          message: "属性、时间和 AI 条件不能使用事件触发方式",
          path: ["tree"],
        });
      }
      if (
        node.predicate.kind === "time_window" &&
        node.predicate.start === node.predicate.end
      ) {
        context.addIssue({
          code: "custom",
          message: "时间区间的开始与结束不能相同",
          path: ["tree"],
        });
      }
      if (node.predicate.kind === "property") {
        const { operator, value } = node.predicate;
        const needsArray =
          operator === "in" || operator === "not_in" || operator === "between";
        if (needsArray !== Array.isArray(value)) {
          context.addIssue({
            code: "custom",
            message: `节点 ${node.id} 的运算符和值不匹配`,
            path: ["tree"],
          });
        }
        if (
          operator === "between" &&
          (!Array.isArray(value) ||
            value.length !== 2 ||
            typeof value[0] !== "number" ||
            typeof value[1] !== "number" ||
            value[0] > value[1])
        ) {
          context.addIssue({
            code: "custom",
            message: "区间必须是从小到大的两个数值",
            path: ["tree"],
          });
        }
      }
    }
    if (triggerCount === 0)
      context.addIssue({
        code: "custom",
        message: "规则树至少需要一个触发条件",
        path: ["tree"],
      });
    const actionIds = new Set(definition.actions.map((action) => action.id));
    if (actionIds.size !== definition.actions.length)
      context.addIssue({
        code: "custom",
        message: "动作 ID 不能重复",
        path: ["actions"],
      });
  });

export const automationTruthSchema = z.union([z.boolean(), z.null()]);
export const automationNodeResultSchema = z.object({
  node_id: identifier,
  truth: automationTruthSchema,
  reason: z.string().nullable(),
  triggered_by: z.array(identifier),
});
export const automationEvaluationSchema = z.object({
  truth: automationTruthSchema,
  eligible: z.boolean(),
  triggered_by: z.array(identifier),
  nodes: z.array(automationNodeResultSchema),
});
export const automationPropertyCapabilitySchema = z.object({
  device_id: deviceId,
  device_name: z.string(),
  property_key: automationPropertyReferenceSchema.shape.property_key,
  description: z.string(),
  kind: z.enum(["boolean", "enum", "number", "text"]),
  format: z.string(),
  operators: z.array(automationOperatorSchema),
  options: z.array(z.object({ value: deviceValueSchema, label: z.string() })),
  unit: z.string().nullable(),
  range: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  readable: z.boolean(),
  writeable: z.boolean(),
});
export const automationActionCapabilitySchema = z.object({
  device_id: deviceId,
  device_name: z.string(),
  action_key: z.string().regex(/^action\.[1-9]\d*\.[1-9]\d*$/),
  description: z.string(),
  inputs: z.array(
    z.object({
      name: z.string(),
      kind: automationPropertyCapabilitySchema.shape.kind,
      format: z.string(),
      options: automationPropertyCapabilitySchema.shape.options,
      range: automationPropertyCapabilitySchema.shape.range,
      unit: z.string().nullable(),
    }),
  ),
});
export const automationCapabilitiesSchema = z.object({
  properties: z.array(automationPropertyCapabilitySchema),
  actions: z.array(automationActionCapabilitySchema),
  event_types: z.array(identifier),
  notification: z.boolean(),
});
export const automationSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  definition: automationDefinitionSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  readiness: z.enum(["ready", "unavailable", "disabled"]),
  reasons: z.array(z.string()),
});
export const automationScopeSchema = z.strictObject({ scope_epoch: z.uuid() });
export const automationQueryLimits = {
  responseBytes: 8 * 1024,
  pageSize: 20,
} as const;
const automationPageSchema = automationScopeSchema.extend({
  query: z.string().trim().max(120).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .min(1)
    .max(automationQueryLimits.pageSize)
    .default(10),
});
const automationPageResult = {
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
};
export const automationCapabilitiesQuerySchema = automationPageSchema.extend({
  device_id: deviceId.optional(),
});
export const automationCapabilitiesPageSchema = z.object({
  ...automationPageResult,
  notification: z.boolean(),
  items: z.array(
    z.discriminatedUnion("type", [
      automationPropertyCapabilitySchema.extend({
        type: z.literal("property"),
      }),
      automationActionCapabilitySchema.extend({ type: z.literal("action") }),
      z.object({ type: z.literal("event"), event_type: identifier }),
    ]),
  ),
});
export const automationListQuerySchema = automationPageSchema;
export const automationSummarySchema = automationSchema
  .pick({
    id: true,
    revision: true,
    enabled: true,
    updated_at: true,
  })
  .extend({ name: automationDefinitionSchema.shape.name });
export const automationListPageSchema = z.object({
  ...automationPageResult,
  items: z.array(automationSummarySchema),
});
export const automationReadRequestSchema = automationScopeSchema.extend({
  id: automationSchema.shape.id,
});

export const automationSaveRequestSchema = automationScopeSchema.extend({
  id: z.uuid(),
  expected_revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  definition: automationDefinitionSchema,
});
export const automationDeleteRequestSchema = automationScopeSchema.extend({
  id: z.uuid(),
  expected_revision: z.number().int().positive(),
});
export const automationEvaluateRequestSchema = automationScopeSchema.extend({
  definition: automationDefinitionSchema,
});
export const automationGenerateRequestSchema = automationScopeSchema.extend({
  text: z.string().trim().min(1).max(4000),
  definition: automationDefinitionSchema.optional(),
});
export const automationDraftSchema = z.object({
  definition: automationDefinitionSchema.nullable(),
  behavior: z.string().max(4000),
  clarifications: z.array(z.string().max(1000)).max(5),
});
export const automationGenerationLimits = {
  requestBytes: 256 * 1024,
  responseBytes: 128 * 1024,
  timeoutMs: 90_000,
  concurrent: 1,
} as const;
/** Backend supplies the current household capabilities; this endpoint only drafts. */
export const automationGenerationInputSchema = automationGenerateRequestSchema
  .omit({ scope_epoch: true })
  .extend({
    capabilities: automationCapabilitiesSchema,
  });
export const automationDecisionInputSchema = z.strictObject({
  request_id: z.uuid(),
  automation_id: z.uuid(),
  revision: z.number().int().positive(),
  goal: z.string().trim().min(1).max(4000),
  evaluated_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  context: z.strictObject({
    scope_epoch: z.uuid(),
    sequence: z.number().int().nonnegative(),
    facts: z.array(latestPropertySchema),
    evaluation: automationEvaluationSchema,
  }),
  allowed_actions: z
    .array(automationActionSchema)
    .min(1)
    .max(automationLimits.actions),
});
export const automationDecisionResultSchema = z.strictObject({
  action_ids: z.array(identifier).max(automationLimits.actions),
  explanation: z.string().trim().min(1).max(4000),
});
export const automationDecisionReceiptSchema = z.strictObject({
  request_id: z.uuid(),
  status: z.enum(["running", "succeeded", "unknown"]),
  result: automationDecisionResultSchema.nullable(),
});
export const automationDecisionLimits = {
  requestBytes: 256 * 1024,
  responseBytes: 32 * 1024,
  timeoutMs: 90_000,
  concurrent: 1,
} as const;
export const automationInputKindSchema = z.enum([
  "baseline",
  "ai",
  "facts",
  "timer",
  "event",
]);
export const automationEvaluationTimingSchema = z.object({
  recording_started_at: z.iso.datetime().optional(),
  started_at: z.iso.datetime().optional(),
  finished_at: z.iso.datetime().optional(),
  duration_ms: z.number().nonnegative().optional(),
  committed_at: z.iso.datetime().optional(),
});
export const automationActionTimingSchema = z.object({
  queued_at: z.iso.datetime().optional(),
  claimed_at: z.iso.datetime().optional(),
  prepared_at: z.iso.datetime().optional(),
  dispatch_started_at: z.iso.datetime().optional(),
  sent_at: z.iso.datetime().optional(),
  response_received_at: z.iso.datetime().optional(),
  finished_at: z.iso.datetime().optional(),
  feedback: z
    .object({
      observation_id: z.uuid(),
      received_at: z.iso.datetime(),
      observed_at: z.iso.datetime().nullable(),
      value: propertyValueSchema,
    })
    .optional(),
});
export const automationDecisionTimingSchema = z.object({
  queued_at: z.iso.datetime().optional(),
  requested_at: z.iso.datetime().optional(),
  response_received_at: z.iso.datetime().optional(),
  settled_at: z.iso.datetime().optional(),
});
export const automationRunSchema = z.object({
  id: z.uuid(),
  automation_id: z.uuid(),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  status: z.enum([
    "skipped",
    "pending",
    "running",
    "accepted",
    "succeeded",
    "failed",
    "unknown",
    "cancelled",
  ]),
  reason: z.string().nullable(),
  input: z.object({
    kind: automationInputKindSchema,
    captured_at: z.iso.datetime(),
    report: automationPropertyReferenceSchema.nullable(),
    event: z
      .object({
        id: z.uuid(),
        event_type: identifier,
        occurred_at: z.iso.datetime(),
      })
      .nullable(),
    facts: z.array(latestPropertySchema),
  }),
  evaluation: automationEvaluationSchema,
  evaluation_recorded_at: z.iso.datetime(),
  timing: automationEvaluationTimingSchema,
  decision: z
    .object({
      status: z.string(),
      explanation: z.string().nullable(),
      timing: automationDecisionTimingSchema,
    })
    .nullable(),
  actions: z.array(
    z.object({
      action_id: identifier,
      action: automationActionSchema,
      status: z.enum([
        "pending",
        "running",
        "accepted",
        "succeeded",
        "failed",
        "rejected",
        "unknown",
        "cancelled",
      ]),
      reason: z.string().nullable(),
      timing: automationActionTimingSchema,
      updated_at: z.iso.datetime(),
    }),
  ),
});
export const automationRunsRequestSchema = automationScopeSchema.extend({
  automation_id: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export const automationEventSchema = z.strictObject({
  id: z.uuid(),
  event_type: identifier,
  device_id: deviceId.nullable(),
  source: z.enum(["device", "rule", "agent"]),
  occurred_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationNode = z.infer<typeof automationNodeSchema>;
export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationPredicate = z.infer<typeof automationPredicateSchema>;
export type AutomationCapabilities = z.infer<
  typeof automationCapabilitiesSchema
>;
export type Automation = z.infer<typeof automationSchema>;
export type AutomationRun = z.infer<typeof automationRunSchema>;
export type AutomationEvaluation = z.infer<typeof automationEvaluationSchema>;
export type AutomationEvent = z.infer<typeof automationEventSchema>;
