import {
  executionTime,
  inputKindLabels,
} from "../../modules/automations/execution";
import { useQuery } from "@tanstack/react-query";
import type {
  AutomationCapabilities,
  AutomationDefinition,
  AutomationEvaluation,
  AutomationNode,
} from "@home-agent/api/automations";
import { automationRunsOptions } from "../../modules/automations/queries";
import { operatorLabels } from "../../modules/automations/editor";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { automationErrorMessage } from "../../modules/automations/messages";

import { TriggerDetails } from "./TriggerDetails";

function nodeLabels(
  tree: AutomationNode,
  capabilities: AutomationCapabilities,
  eventLabels: Record<string, string>,
) {
  const labels = new Map<string, string>();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.kind === "group") {
      labels.set(
        node.id,
        node.operator === "and"
          ? "全部满足"
          : node.operator === "or"
            ? "任一满足"
            : "取反",
      );
      pending.push(...node.children);
      continue;
    }
    const predicate = node.predicate;
    const property =
      predicate.kind === "property"
        ? capabilities.properties.find(
            (item) =>
              item.device_id === predicate.device_id &&
              item.property_key === predicate.property_key,
          )
        : undefined;
    labels.set(
      node.id,
      predicate.kind === "property"
        ? `${property?.device_name ?? predicate.device_id} · ${property?.description ?? predicate.property_key} ${operatorLabels[predicate.operator]} ${Array.isArray(predicate.value) ? predicate.value.join("、") : String(predicate.value)}`
        : predicate.kind === "event"
          ? (eventLabels[predicate.event_type] ?? predicate.event_type)
          : predicate.kind === "ai"
            ? `AI 判断 · ${predicate.goal}`
            : `${predicate.start}—${predicate.end}（${predicate.time_zone}）`,
    );
  }
  return labels;
}

export function EvaluationDetails({
  evaluation,
  definition,
  capabilities,
  eventLabels = {},
}: {
  evaluation: AutomationEvaluation;
  definition: AutomationDefinition | undefined;
  capabilities: AutomationCapabilities;
  eventLabels?: Record<string, string>;
}) {
  const labels = definition
    ? nodeLabels(definition.tree, capabilities, eventLabels)
    : new Map<string, string>();
  return (
    <div className="space-y-2">
      {evaluation.nodes.map((node) => (
        <div
          key={node.node_id}
          className="flex flex-wrap items-start justify-between gap-2 border-b border-line/60 py-2 text-xs"
        >
          <div className="min-w-0 flex-1">
            <p className="break-words text-ink">
              {labels.get(node.node_id) ??
                `历史规则节点 ${node.node_id.slice(-6)}`}
            </p>
            {node.reason ? (
              <p className="mt-1 text-muted">{node.reason}</p>
            ) : null}
          </div>
          <span
            className={
              node.truth === true
                ? "text-sage"
                : node.truth === null
                  ? "text-warning"
                  : "text-muted"
            }
          >
            {node.truth === true
              ? "满足"
              : node.truth === null
                ? "未知"
                : "不满足"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ExecutionHistory({
  scope,
  id,
  revision,
  ready,
  definition,
  capabilities,
}: {
  scope: string;
  id: string;
  revision: number;
  ready: boolean;
  definition: AutomationDefinition;
  capabilities: AutomationCapabilities;
}) {
  const query = useQuery({
    ...automationRunsOptions(scope, id),
    enabled: ready,
  });

  const runs = query.data?.runs ?? [];
  return (
    <section
      className="mt-5 border-t border-line pt-5"
      aria-label={`${definition.name}的触发与条件日志`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">触发与条件日志</h3>
        <Button
          size="small"
          disabled={!ready}
          status={query.isFetching ? "pending" : "idle"}
          onClick={() => {
            query
              .refetch()
              .catch((error: unknown) =>
                console.error("Automation history refresh failed", error),
              );
          }}
        >
          刷新
        </Button>
      </div>
      <p className="mb-4 text-xs leading-5 text-muted">
        最近 50 次触发运行 · 每秒刷新 · 时间按本机时区显示。
        只记录进入执行流程的触发，包含后续失败或取消。
      </p>
      {query.error ? (
        <Notice tone="error">{automationErrorMessage(query.error)}</Notice>
      ) : null}
      {query.isLoading ? (
        <p className="text-sm text-muted">正在读取触发日志…</p>
      ) : null}
      {query.data?.runs.length === 0 ? (
        <p className="text-sm text-muted">
          还没有触发执行记录。重复上报、基线更新和条件不满足不会产生运行日志。
        </p>
      ) : null}
      <div className="space-y-3">
        {runs.map((run) => (
          <details key={run.id} className="rounded-xl bg-surface p-3 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="font-medium">
                {inputKindLabels[run.input.kind]}
              </span>
              <time
                className="ml-auto text-xs text-muted"
                dateTime={run.created_at}
              >
                {executionTime(run.created_at)}
              </time>
            </summary>
            <div className="mt-4">
              <TriggerDetails run={run} capabilities={capabilities} />
            </div>
            <h4 className="mt-4 text-xs font-medium">条件判断结果</h4>
            <EvaluationDetails
              evaluation={run.evaluation}
              definition={run.revision === revision ? definition : undefined}
              capabilities={capabilities}
              eventLabels={{}}
            />
            <p className="mt-3 break-all text-xs text-muted">
              运行 ID：{run.id} · 规则版本 {run.revision}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
