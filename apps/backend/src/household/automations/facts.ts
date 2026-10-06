import {
  collectAutomationConditions,
  evaluateAutomationPredicate,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationCondition,
  type automationAiValueSchema,
} from "@home-agent/api/automations";
import { propertyKey } from "@home-agent/api/observations";
import { entityKey } from "@home-agent/api/household";
import type { HouseholdRuntime } from "../runtime";

type Snapshot = ReturnType<HouseholdRuntime["snapshot"]>;
const conditions = new WeakMap<
  AutomationDefinition,
  ReturnType<typeof collectAutomationConditions>
>();
export function automationConditions(definition: AutomationDefinition) {
  let cached = conditions.get(definition);
  if (!cached) {
    cached = collectAutomationConditions(definition.tree);
    conditions.set(definition, cached);
  }
  return cached;
}

export function referencedFacts(
  definition: AutomationDefinition,
  snapshot: Snapshot,
) {
  const account = snapshot.projection.household.household.account_id ?? "";
  const keys = new Set(
    automationConditions(definition).flatMap(({ predicate }) => {
      const refs =
        predicate.kind === "property"
          ? [predicate]
          : predicate.kind === "ai"
            ? predicate.property_refs
            : [];
      return refs.map((ref) => {
        const [, siid, piid] = ref.property_key.split(".");
        return propertyKey(account, ref.device_id, Number(siid), Number(piid));
      });
    }),
  );
  return [...keys].flatMap((key) => {
    const fact = snapshot.projection.latest[key];
    return fact ? [fact] : [];
  });
}

export function leaves(
  definition: AutomationDefinition,
  snapshot: Snapshot,
  now: Date,
  event?: AutomationEvent,
  readAi?: (
    condition: AutomationCondition,
  ) => ReturnType<typeof automationAiValueSchema.parse>,
) {
  const account = snapshot.projection.household.household.account_id ?? "";
  return Object.fromEntries(
    automationConditions(definition).map((condition) => {
      const predicate = condition.predicate;
      if (predicate.kind === "ai") {
        const ai = readAi?.(condition);
        return [
          condition.id,
          {
            ...evaluateAutomationPredicate(predicate, {
              now,
              ...(ai ? { ai } : {}),
            }),
            expires_at: ai?.expires_at ?? null,
          },
        ];
      }
      let property;
      if (predicate.kind === "property") {
        const device =
          snapshot.projection.device[entityKey(account, predicate.device_id)];
        if (!device || !device.online)
          return [condition.id, { truth: null, reason: "offline" }];
        const [, siid, piid] = predicate.property_key.split(".");
        property =
          snapshot.projection.latest[
            propertyKey(
              account,
              predicate.device_id,
              Number(siid),
              Number(piid),
            )
          ];
      }
      return [
        condition.id,
        evaluateAutomationPredicate(predicate, {
          now,
          property: property ?? null,
          event: event ?? null,
        }),
      ];
    }),
  );
}
