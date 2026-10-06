import {
  executionTime,
  inputKindLabels,
} from "../../modules/automations/execution";
import type {
  AutomationCapabilities,
  AutomationRun,
} from "@home-agent/api/automations";

function triggerFact(run: AutomationRun) {
  return run.input.facts.find(
    (fact) =>
      fact.device_id === run.input.report?.device_id &&
      `prop.${fact.siid}.${fact.piid}` === run.input.report.property_key,
  );
}

export function TriggerDetails({
  run,
  capabilities,
}: {
  run: AutomationRun;
  capabilities: AutomationCapabilities;
}) {
  const fact = triggerFact(run);
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-medium">
          触发来源 · {inputKindLabels[run.input.kind]}
        </h4>
        {fact ? (
          <p className="text-xs text-muted">
            {capabilities.properties.find(
              (item) =>
                item.device_id === fact.device_id &&
                item.property_key === `prop.${fact.siid}.${fact.piid}`,
            )?.device_name ?? fact.device_id}
            {` · ${fact.description} = ${String(fact.value)}`}
          </p>
        ) : run.input.event ? (
          <p className="text-xs text-muted">
            {run.input.event.event_type} · {run.input.event.id}
          </p>
        ) : (
          <p className="text-xs text-muted">
            {run.input.kind === "baseline"
              ? "记录当前条件，基线本身不会触发进入动作。"
              : run.input.kind === "ai"
                ? "AI 条件取得新判断，重新计算规则"
                : run.input.kind === "timer"
                  ? "持续期限或时间窗口到达，重新检查规则。"
                  : "缓存、在线状态或来源状态发生更新，本次没有新的属性触发上报。"}
          </p>
        )}
      </div>
      <details className="rounded-xl bg-white p-4 text-xs shadow-surface">
        <summary className="cursor-pointer">
          本次条件使用的设备值（{run.input.facts.length} 项）
        </summary>
        <div className="mt-2 space-y-2">
          {run.input.facts.map((value) => (
            <div
              key={`${value.device_id}:${value.siid}:${value.piid}`}
              className="border-t border-line pt-2"
            >
              <p>
                {capabilities.properties.find(
                  (item) =>
                    item.device_id === value.device_id &&
                    item.property_key === `prop.${value.siid}.${value.piid}`,
                )?.device_name ?? value.device_id}{" "}
                · {value.description}：
                {value.has_value ? String(value.value) : "缺值"}
              </p>
              <p className="mt-1 text-muted">
                {value.evidence?.source === "push" ? "设备推送" : "读取或缓存"}
                {value.evidence
                  ? ` · 接收于 ${executionTime(value.evidence.received_at)}`
                  : " · 没有观测证据"}
              </p>
            </div>
          ))}
        </div>
      </details>
      <p className="text-xs leading-5 text-muted">
        上报时间为后端接收时间，不代表人在房间内实际出现的时刻。
      </p>
    </div>
  );
}
