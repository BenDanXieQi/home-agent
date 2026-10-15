import type { z } from "zod";
import type { automationPropertyReferenceSchema } from "@home-agent/api/automations";
import type { HouseholdRuntime } from "../runtime";

type Snapshot = ReturnType<HouseholdRuntime["snapshot"]>;
type Reference = z.infer<typeof automationPropertyReferenceSchema>;
type Commit = Parameters<Parameters<HouseholdRuntime["subscribeFacts"]>[0]>[0];
type Observation = NonNullable<NonNullable<Commit["result"]>["observation"]>;

export type AutomationProperties = {
  key: (accountId: string, reference: Reference) => string | undefined;
  reference: (fact: Snapshot["projection"]["latest"][string]) => Reference;
  reported: (
    snapshot: Snapshot,
    event: Extract<Observation["event"], { kind: "property" }>,
  ) => Snapshot["projection"]["latest"][string] | undefined;
};
