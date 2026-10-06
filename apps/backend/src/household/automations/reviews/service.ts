import { entityKey } from "@home-agent/api/household";
import type { AutomationCondition } from "@home-agent/api/automations";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  automationReviewRequestSchema,
  type automationReviewResultSchema,
} from "@home-agent/api/automation-reviews";
import { automationPropertyAddress } from "@home-agent/api/automations";
import { propertyKey } from "@home-agent/api/observations";
import type { Database } from "../../../db";
import type { HouseholdRuntime } from "../../runtime";
import { accessHousehold } from "../../access";
import { createAutomationReviewRepository } from "./repository";
import {
  createAutomationReviewClient,
  AutomationReviewNotAcceptedError,
} from "./agent-client";
import { factMeaning } from "../../../room-analysis/context";

type Review = Awaited<
  ReturnType<ReturnType<typeof createAutomationReviewRepository>["list"]>
>[number];
type Scope = ReturnType<typeof accessHousehold>;
type Request = ReturnType<typeof automationReviewRequestSchema.parse>;
const executePayload = z.object({ id: z.uuid() });

function eligible(
  fact: Request["context"]["facts"][number]["latest"],
  now = Date.now(),
) {
  return (
    !!fact?.has_value &&
    fact.rule_eligible &&
    fact.evidence?.delivery_kind === "live" &&
    (!fact.expires_at || Date.parse(fact.expires_at) > now)
  );
}

export function createAutomationReviewService(deps: {
  db: Database;
  household: HouseholdRuntime;
  readAgentUrl: () => Promise<string>;
  signal: AbortSignal;
  onChange: (automationId: string, revision: number) => void;
  isCurrent: (automationId: string, revision: number) => boolean;
}) {
  const repository = createAutomationReviewRepository(deps.db);
  const agent = createAutomationReviewClient(deps.readAgentUrl);
  const definitions = new Map<string, Review>();
  const closing = new AbortController();
  const controllers = new Map<string, AbortController>();
  const judgments = new Map<
    string,
    {
      review: Review;
      request: Request;
      result: ReturnType<typeof automationReviewResultSchema.parse>;
      expiresAt: number;
    }
  >();
  let loadedEpoch: string | null = null;
  let refreshing: Promise<void> | null = null;
  let cacheGeneration = 0;
  let stopped = false;

  const scope = () => accessHousehold(deps.household, deps.household.epoch);
  function assertDefinition(row: Review) {
    const current = definitions.get(row.id);
    if (
      stopped ||
      !deps.isCurrent(row.automationId, row.revision) ||
      !current?.enabled ||
      current.revision !== row.revision
    )
      throw new Error("AI 条件已撤销");
  }
  function readFacts(
    current: Scope,
    review: Review,
    snapshot: ReturnType<HouseholdRuntime["snapshot"]>,
  ) {
    return review.definition.property_refs.map((reference) => {
      const address = automationPropertyAddress(reference.property_key);
      const latest = address
        ? (snapshot.projection.latest[
            propertyKey(
              current.identity.accountId,
              reference.device_id,
              address.siid,
              address.piid,
            )
          ] ?? null)
        : null;
      const evidenceId = latest?.evidence?.observation_id
        ? `property:${latest.evidence.observation_id}`
        : `missing:${createHash("sha256").update(JSON.stringify(reference)).digest("hex")}`;
      return {
        ...reference,
        evidence_id: evidenceId,
        description: latest?.description ?? reference.property_key,
        latest,
      };
    });
  }
  function capture(current: Scope, review: Review) {
    const snapshot = deps.household.snapshot();
    const now = new Date();
    const facts = readFacts(current, review, snapshot);
    const request = automationReviewRequestSchema.parse({
      request_id: crypto.randomUUID(),
      review_id: review.id,
      revision: review.revision,
      goal: review.definition.goal,
      evaluated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 120_000).toISOString(),
      context: {
        scope_epoch: current.snapshot.scope_epoch,
        sequence: snapshot.sequence,
        facts,
      },
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          facts: facts.map(({ device_id, property_key, latest }) => ({
            device_id,
            property_key,
            value: latest?.value ?? null,
            has_value: latest?.has_value ?? false,
            eligible: eligible(latest),
            reason: latest?.reason ?? "missing",
            spec_id: latest?.spec_id ?? null,
            source_id: latest?.evidence?.source_id ?? null,
            generation: latest?.evidence?.collection_generation ?? null,
            last_change_at: latest?.last_change_at ?? null,
          })),
        }),
      )
      .digest("hex");
    const hasEvidence = facts.some((fact) => eligible(fact.latest));
    return {
      request,
      fingerprint,
      reason:
        Buffer.byteLength(JSON.stringify(request)) > 128 * 1024
          ? "复核输入超过容量上限"
          : !hasEvidence
            ? "缺少当前有效的原始证据，未调用模型"
            : null,
    };
  }
  function assertEvidence(
    request: Request,
    result: ReturnType<typeof automationReviewResultSchema.parse>,
    current: Scope,
  ) {
    current.assertCurrent();
    if (result.judgment === null) return;
    if (!result.supporting_evidence_ids.length)
      throw new Error("明确判断缺少证据引用");
    const unique = new Set(result.supporting_evidence_ids);
    if (unique.size !== result.supporting_evidence_ids.length)
      throw new Error("证据引用重复");
    const frozenFacts = new Map(
      request.context.facts.map((fact) => [fact.evidence_id, fact]),
    );
    const latestByEvidence = new Map(
      request.context.facts.map((fact) => {
        if (
          !deps.household.snapshot().projection.device[
            entityKey(current.identity.accountId, fact.device_id)
          ]?.online
        )
          throw new Error("证据设备已离线");
        const address = automationPropertyAddress(fact.property_key);
        const latest = address
          ? (deps.household.snapshot().projection.latest[
              propertyKey(
                current.identity.accountId,
                fact.device_id,
                address.siid,
                address.piid,
              )
            ] ?? null)
          : null;
        // New evidence can contradict the reasoning even when the model omitted
        // it from its support list. Same-value reports do not change the meaning.
        if (
          (fact.latest === null) !== (latest === null) ||
          (fact.latest &&
            latest &&
            (factMeaning(fact.latest) !== factMeaning(latest) ||
              fact.latest.last_change_at !== latest.last_change_at))
        )
          throw new Error("复核输入已变化");
        return [fact.evidence_id, latest];
      }),
    );
    for (const id of unique) {
      const frozen = frozenFacts.get(id);
      if (frozen) {
        const latest = latestByEvidence.get(id) ?? null;
        if (
          !eligible(frozen.latest, Date.parse(request.evaluated_at)) ||
          !eligible(latest)
        )
          throw new Error("支持证据已变化或过期");
        continue;
      }
      throw new Error("证据引用无效");
    }
  }
  async function refresh() {
    if (stopped) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!deps.household.ready) {
        definitions.clear();
        judgments.clear();
        loadedEpoch = null;
        for (const controller of controllers.values()) controller.abort();
        return;
      }
      const current = scope();
      while (true) {
        if (stopped) return;
        const generation = cacheGeneration;
        const rows = await repository.list(current);
        current.assertCurrent();
        if (generation !== cacheGeneration) continue;
        definitions.clear();
        for (const row of rows) definitions.set(row.id, row);
        break;
      }
      if (loadedEpoch !== current.snapshot.scope_epoch) {
        for (const controller of controllers.values()) controller.abort();
        judgments.clear();
        await repository.startSchedules(current);
        current.assertCurrent();
        loadedEpoch = current.snapshot.scope_epoch;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function tick() {
    if (stopped || !deps.household.ready) return;
    if (loadedEpoch !== deps.household.epoch) await refresh();
    const current = scope();
    for (const row of await repository.list(current)) {
      if (
        !row.enabled ||
        !row.nextAt ||
        row.nextAt.getTime() > Date.now() ||
        !deps.isCurrent(row.automationId, row.revision)
      )
        continue;
      try {
        const generation = cacheGeneration;
        const review = await repository.takeDue(current, row.id);
        if (!review) continue;
        if (generation !== cacheGeneration) continue;
        definitions.set(review.id, review);
        assertDefinition(review);
        const candidate = capture(current, review);
        assertDefinition(review);
        current.assertCurrent();
        await repository.admit(current, review.id, review.revision, candidate);
      } catch (error) {
        console.warn(
          "AI 条件本轮已丢弃，后续周期继续",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
  }
  async function execute(payload: unknown) {
    if (stopped || !deps.household.ready) return;
    const job = executePayload.parse(payload);
    const current = scope();
    const generation = cacheGeneration;
    const claim = await repository.claim(current, job.id);
    if (!claim) return;
    if (
      generation === cacheGeneration &&
      (definitions.get(claim.review.id)?.revision ?? 0) <= claim.review.revision
    )
      definitions.set(claim.review.id, claim.review);
    const controller = new AbortController();
    controllers.set(claim.review.id, controller);
    const signal = AbortSignal.any([
      deps.signal,
      closing.signal,
      controller.signal,
      AbortSignal.timeout(60_000),
    ]);
    try {
      assertDefinition(claim.review);
      const response = await agent.submit(claim.request, signal);
      current.assertCurrent();
      assertDefinition(claim.review);
      if (response.request_id !== job.id)
        throw new Error("Agent 回执身份不匹配");
      if (response.status !== "succeeded" || !response.result) {
        judgments.delete(claim.review.id);
        deps.onChange(claim.review.automationId, claim.review.revision);
        await repository.complete(current, job.id, {
          status: "unknown",
          reason: "Agent 无法确认此次复核结果，未重新调用模型",
          result: null,
        });
        return;
      }
      try {
        assertEvidence(claim.request, response.result, current);
        if (
          Date.parse(claim.request.evaluated_at) +
            claim.review.definition.result_ttl_seconds * 1000 <=
          Date.now()
        )
          throw new Error("判断已超过有效期");
      } catch {
        judgments.delete(claim.review.id);
        deps.onChange(claim.review.automationId, claim.review.revision);
        await repository.complete(current, job.id, {
          status: "cancelled",
          reason: "结果引用的证据无效、已变化或过期",
          result: response.result,
        });
        return;
      }
      const result = response.result;
      const guarded = {
        ...current,
        assertCurrent: () => {
          current.assertCurrent();
          assertDefinition(claim.review);
          assertEvidence(claim.request, result, current);
        },
      };
      const accepted = await repository.complete(guarded, job.id, {
        status: "succeeded",
        reason: null,
        result,
      });
      if (!accepted) {
        judgments.delete(claim.review.id);
        deps.onChange(claim.review.automationId, claim.review.revision);
      } else {
        guarded.assertCurrent();
        judgments.set(claim.review.id, {
          review: claim.review,
          request: claim.request,
          result,
          expiresAt: Math.min(
            Date.parse(claim.request.evaluated_at) +
              claim.review.definition.result_ttl_seconds * 1000,
            ...claim.request.context.facts.flatMap((fact) =>
              result.supporting_evidence_ids.includes(fact.evidence_id) &&
              fact.latest?.expires_at
                ? [Date.parse(fact.latest.expires_at)]
                : [],
            ),
          ),
        });
        deps.onChange(claim.review.automationId, claim.review.revision);
      }
    } catch (error) {
      judgments.delete(claim.review.id);
      deps.onChange(claim.review.automationId, claim.review.revision);
      if (
        !stopped &&
        deps.household.ready &&
        deps.household.epoch === current.snapshot.scope_epoch
      ) {
        await repository.complete(current, job.id, {
          status:
            error instanceof AutomationReviewNotAcceptedError
              ? "failed"
              : "unknown",
          reason:
            error instanceof AutomationReviewNotAcceptedError
              ? `Agent 未接纳复核：${error.reason}`
              : "复核结果未确认，本次执行已结束",
          result: null,
        });
      }
      console.warn(
        "AI 判断失败，本次执行已结束",
        error instanceof Error ? error.name : "unknown",
      );
    } finally {
      if (controllers.get(claim.review.id) === controller)
        controllers.delete(claim.review.id);
    }
  }
  const unsubscribe = deps.household.subscribe(() => {
    if (deps.household.epoch !== loadedEpoch)
      refresh().catch(() => {
        console.warn("Semantic review household refresh failed");
      });
  });
  return {
    taskList: {
      automation_review_tick: tick,
      automation_review_execute: execute,
    },
    async start() {
      await refresh().catch(() => {
        console.warn("AI 条件初始化失败，等待下次周期读取配置");
      });
    },
    async close() {
      stopped = true;
      closing.abort();
      unsubscribe();
      for (const controller of controllers.values()) controller.abort();
      await refreshing;
    },
    revoke(automationId: string) {
      cacheGeneration += 1;
      for (const [id, review] of definitions) {
        if (review.automationId !== automationId) continue;
        controllers.get(id)?.abort();
        judgments.delete(id);
        definitions.delete(id);
      }
    },
    read(automationId: string, condition: AutomationCondition) {
      const unknown = {
        truth: null,
        reason: "AI 尚未判断或结果已失效",
        expires_at: null,
      };
      const value = [...judgments.values()].find(
        (item) =>
          item.review.automationId === automationId &&
          item.review.nodeId === condition.id,
      );
      if (
        !value ||
        condition.predicate.kind !== "ai" ||
        !isDeepStrictEqual(value.review.definition, condition.predicate)
      )
        return unknown;
      if (value.expiresAt <= Date.now()) {
        judgments.delete(value.review.id);
        return unknown;
      }
      try {
        assertDefinition(value.review);
        assertEvidence(value.request, value.result, scope());
      } catch {
        judgments.delete(value.review.id);
        return unknown;
      }
      return {
        truth: value.result.judgment,
        reason: value.result.explanation,
        expires_at: new Date(value.expiresAt).toISOString(),
      };
    },
    async runs(epoch: string, automationId: string, limit: number) {
      return {
        items: await repository.runs(
          accessHousehold(deps.household, epoch),
          automationId,
          limit,
        ),
      };
    },
  };
}
