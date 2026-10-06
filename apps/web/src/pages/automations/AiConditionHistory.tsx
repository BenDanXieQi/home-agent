import { useQuery } from "@tanstack/react-query";
import {
  collectAutomationConditions,
  type AutomationDefinition,
} from "@home-agent/api/automations";
import { reviewRunsOptions } from "../../modules/automations/reviews";
import { automationErrorMessage } from "../../modules/automations/messages";
import { Notice } from "../../components/Notice";

export function AiConditionHistory({
  scope,
  id,
  ready,
  definition,
}: {
  scope: string;
  id: string;
  ready: boolean;
  definition: AutomationDefinition;
}) {
  const conditions = collectAutomationConditions(definition.tree).filter(
    (node) => node.predicate.kind === "ai",
  );
  const query = useQuery({
    ...reviewRunsOptions(scope, id),
    enabled: ready && conditions.length > 0,
  });
  if (!conditions.length) return null;
  return (
    <section className="mt-4 space-y-3" aria-label="AI 条件判断历史">
      <h3 className="text-sm font-medium">AI 条件判断历史</h3>
      {query.error ? (
        <Notice tone="error">{automationErrorMessage(query.error)}</Notice>
      ) : null}
      {!query.data?.items.length ? (
        <p className="text-xs text-muted">暂无判断记录</p>
      ) : null}
      {query.data?.items.map((run) => {
        const predicate = conditions.find(
          (node) => node.id === run.node_id,
        )?.predicate;
        return (
          <article
            key={run.request_id}
            className="rounded-xl bg-surface p-4 text-xs"
          >
            <p className="font-medium">
              {predicate?.kind === "ai" ? predicate.goal : run.node_id}
            </p>
            <p className="mt-1 text-muted">
              {new Date(run.created_at).toLocaleString()} ·{" "}
              {run.status === "succeeded"
                ? run.result?.judgment === true
                  ? "成立"
                  : run.result?.judgment === false
                    ? "不成立"
                    : "未知"
                : run.status === "skipped"
                  ? "已跳过"
                  : ["pending", "dispatching", "running"].includes(run.status)
                    ? "等待或正在判断"
                    : "本次未取得有效判断"}
            </p>
            <p className="mt-1">{run.reason ?? run.result?.explanation}</p>
          </article>
        );
      })}
    </section>
  );
}
