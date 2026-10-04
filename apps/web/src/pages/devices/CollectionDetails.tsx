import { householdSnapshotAtom } from "../../modules/household/state";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { commandResultSchema } from "@home-agent/api/household";
import { Disclosure } from "../../components/Disclosure";
import { Button } from "../../components/Button";
import { requestJson } from "../../api/client";
import { requestErrorMessage } from "../../messages/zh-CN";
import { collectionLabels } from "./fact-presentation";

export function CollectionDetails({ reliable }: { reliable: boolean }) {
  const snapshot = useAtomValue(householdSnapshotAtom);
  const collection = snapshot?.projection.collection.collection;
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  async function retry() {
    if (!snapshot || !reliable || pending) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setFeedback("");
    try {
      await requestJson(
        (client, options) =>
          client.api.mijia.collection.retry.$post(
            { json: { scope_epoch: snapshot.scope_epoch } },
            options,
          ),
        commandResultSchema,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setFeedback("重试请求已接收，等待采集状态更新。");
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(requestErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  if (!collection) return null;
  return (
    <Disclosure
      className="mt-5"
      title={`家庭采集诊断 · ${reliable ? collectionLabels[collection.status] : "待同步"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span>
          缺口 {collection.gaps} 次 · 丢弃 {collection.dropped} 条 · 拒收{" "}
          {collection.rejected} 条
        </span>
        <Button disabled={!reliable || pending} onClick={retry}>
          {pending ? "正在重试…" : "重试采集"}
        </Button>
      </div>
      {collection.reason || collection.capacity_degraded ? (
        <p className="text-xs text-warning">
          {collection.reason ?? "采集容量不足"}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        初始化分批读取设备状态，再由上报持续更新。云端缓存保留待确认标记；家庭采集不受房间选择和设备筛选影响。
      </p>
      {feedback ? (
        <output className="mt-3 block text-xs text-muted">{feedback}</output>
      ) : null}
    </Disclosure>
  );
}
