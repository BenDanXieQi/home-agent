import {
  collectAutomationConditions,
  evaluateAutomationPredicate,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationCondition,
  type automationAiValueSchema,
} from "@home-agent/api/automations";
import { entityKey } from "@home-agent/api/household";
import type { HouseholdRuntime } from "../runtime";
import type { AutomationProperties } from "./properties";

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

export function createAutomationFacts(
  properties: Pick<AutomationProperties, "key">,
) {
  function referencedFacts(
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
        return refs.map((ref) => properties.key(account, ref));
      }),
    );
    return [...keys].flatMap((key) => {
      const fact =
        key === undefined ? undefined : snapshot.projection.latest[key];
      return fact ? [fact] : [];
    });
  }

  function leaves(
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
          const key = properties.key(account, predicate);
          property =
            key === undefined ? undefined : snapshot.projection.latest[key];
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

  return { referencedFacts, leaves };
}
