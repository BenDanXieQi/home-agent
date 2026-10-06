import { CronExpressionParser } from "cron-parser";
import {
  collectAutomationConditions,
  evaluateAutomationTree,
  type AutomationDefinition,
} from "@home-agent/api/automations";
import type { z } from "zod";
import type { automationInputSchema, automationStateSchema } from "./state";

export function advanceAutomation(
  definition: AutomationDefinition,
  revision: number,
  input: z.infer<typeof automationInputSchema>,
  previous: z.infer<typeof automationStateSchema> | null,
) {
  const now = Date.parse(input.at);
  const baseline =
    input.kind === "baseline" ||
    !previous ||
    previous.scope_epoch !== input.scope_epoch ||
    previous.revision !== revision;
  const leaves: z.infer<typeof automationStateSchema>["leaves"] = {};
  const fired = new Set<string>();
  const deadlines: number[] = [];
  for (const condition of collectAutomationConditions(definition.tree)) {
    const stage = input.episodes[condition.id];
    if (!stage) throw new Error("Automation condition episode is missing");
    const episode = stage.id;
    const value = input.leaves[condition.id]?.truth ?? null;
    const old = baseline ? undefined : previous.leaves[condition.id];
    // A condition must stay in the same episode to retain its sustained timer.
    const continuous = old?.truth === true && old.episode === episode;
    const adjacent = old?.episode === stage.previous_id;
    const expiry = input.leaves[condition.id]?.expires_at;
    if (expiry && Date.parse(expiry) > now) deadlines.push(Date.parse(expiry));
    const property = condition.predicate.kind === "property";
    const reported =
      condition.predicate.kind === "property" &&
      input.kind === "facts" &&
      input.report?.device_id === condition.predicate.device_id &&
      input.report.property_key === condition.predicate.property_key;
    // Cached values establish condition state. Only a live report can start
    // an attribute trigger or its sustained interval.
    const start = property
      ? !baseline && reported
        ? input.at
        : null
      : input.at;
    const since =
      value === true ? (continuous ? (old.since ?? start) : start) : null;
    let sustainedFired =
      value === true && continuous ? old.sustained_fired : false;
    if (condition.role === "trigger" && condition.trigger) {
      if (
        !baseline &&
        (!property || reported) &&
        adjacent &&
        condition.trigger.mode === "enter" &&
        (old?.truth === false ||
          (condition.predicate.kind === "ai" && old?.truth === null)) &&
        value === true
      )
        fired.add(condition.id);
      if (
        !baseline &&
        (!property || reported) &&
        adjacent &&
        condition.trigger.mode === "exit" &&
        old?.truth === true &&
        value === false
      )
        fired.add(condition.id);
      if (
        condition.trigger.mode === "event" &&
        input.kind === "event" &&
        value === true
      )
        fired.add(condition.id);
      if (condition.trigger.mode === "sustained" && since && !sustainedFired) {
        const due =
          Date.parse(since) + condition.trigger.duration_seconds * 1000;
        if (!baseline && due <= now) {
          fired.add(condition.id);
          sustainedFired = true;
        } else deadlines.push(due);
      }
    }
    if (condition.predicate.kind === "time_window") {
      for (const boundary of [
        condition.predicate.start,
        condition.predicate.end,
      ]) {
        const [hour, minute] = boundary.split(":");
        const next = CronExpressionParser.parse(`${minute} ${hour} * * *`, {
          currentDate: new Date(now),
          tz: condition.predicate.time_zone,
        })
          .next()
          .toDate();
        deadlines.push(next.getTime());
      }
    }
    leaves[condition.id] = {
      truth: value,
      episode,
      since,
      sustained_fired: sustainedFired,
    };
  }
  const evaluation = evaluateAutomationTree(
    definition.tree,
    input.leaves,
    fired,
  );
  const lastFired = previous?.last_fired_at ?? null;
  const cooldown =
    lastFired !== null &&
    definition.cooldown_seconds > 0 &&
    now - Date.parse(lastFired) < definition.cooldown_seconds * 1000;
  const execute = evaluation.eligible && !cooldown;
  const state = {
    scope_epoch: input.scope_epoch,
    revision,
    sequence: input.sequence,
    at: input.at,
    leaves,
    last_fired_at: execute
      ? new Date(
          Math.max(now, lastFired ? Date.parse(lastFired) : now),
        ).toISOString()
      : lastFired,
    next_at: deadlines.length
      ? new Date(Math.min(...deadlines)).toISOString()
      : null,
  };
  const reason = baseline
    ? "已建立当前基线，首次值不产生进入触发"
    : evaluation.truth === null
      ? "存在未知或过期条件"
      : !evaluation.truth
        ? "条件未满足"
        : !evaluation.eligible
          ? "没有来自满足分支的有效触发"
          : cooldown
            ? "处于冷却时间"
            : null;
  return { state, evaluation, execute, reason };
}
