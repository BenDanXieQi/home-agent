import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import {
  selectRoomFacts,
  propertyReadResultSchema,
  commandResultSchema,
} from "@home-agent/api/household";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../features/mijia/household-state";
import { requestJson } from "../lib/api";
import { Button } from "../components/Button";
import "../features/mijia/rooms.css";

const qualityLabels = {
  valid: "有效",
  unconfirmed: "待确认",
  unavailable: "来源不可用",
  unknown: "未知",
};
const reasonLabels = {
  missing: "尚未收到值",
  unverified: "有效期尚未确认",
  cloud_cache: "云端缓存，采样时间未知",
  baseline: "基线报告",
  subscription_pending: "订阅待确认",
  subscription_failed: "订阅失败",
  disconnected: "连接中断",
  offline: "设备离线",
  expired: "观测已过期",
  gap: "上报存在缺口",
  spec_unknown: "规格未知",
  spec_changed: "规格变化，等待新报告",
  invalid_value: "上报不符合规格",
  clock_changed: "系统时间变化",
  stopped: "采集停止",
  capacity: "采集容量不足",
  current: "符合当前有效性策略",
};
const subscriptionLabels = {
  pending: "等待确认",
  confirmed: "已订阅",
  failed: "订阅失败",
  cancelled: "订阅取消",
  unsupported: "尚未接通",
};
const collectionLabels = {
  idle: "等待家庭就绪",
  running: "持续采集中",
  paused: "采集已暂停",
  error: "部分采集异常",
};
function time(value: string | null) {
  return value
    ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";
}

export default function RoomsPage() {
  const snapshot = useAtomValue(householdSnapshotAtom);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyOn, setOnlyOn] = useState(true);
  const rooms = Object.values(snapshot?.projection.room ?? {});
  const roomId =
    selected === "unassigned"
      ? null
      : rooms.some((room) => room.room_id === selected)
        ? selected
        : (rooms[0]?.room_id ?? null);
  if (!snapshot) return <output className="notice">正在同步房间状态…</output>;
  return (
    <RoomFactsView
      key={`${snapshot.scope_epoch}/${roomId}`}
      snapshot={snapshot}
      roomId={roomId}
      onSelect={setSelected}
      onlyOn={onlyOn}
      onOnlyOnChange={setOnlyOn}
    />
  );
}

function RoomFactsView({
  snapshot,
  roomId,
  onSelect,
  onlyOn,
  onOnlyOnChange,
}: {
  snapshot: Parameters<typeof selectRoomFacts>[0];
  roomId: string | null;
  onSelect: (room: string) => void;
  onlyOn: boolean;
  onOnlyOnChange: (checked: boolean) => void;
}) {
  const synced = useAtomValue(householdSyncedAtom);
  const [feedback, setFeedback] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const rooms = Object.values(snapshot.projection.room);
  const facts = selectRoomFacts(snapshot, { room_id: roomId, limit: 2000 });
  const visibleDevices = facts.devices.filter((device) => {
    const properties = facts.properties.filter(
      (item) => item.device_id === device.id,
    );
    if (!showMissing && !properties.some((item) => item.has_value))
      return false;
    if (!onlyOn) return true;
    const powerService =
      device.category === "outlet"
        ? "switch"
        : device.category === "camera"
          ? "camera-control"
          : device.category;
    return (
      device.availability !== "offline" &&
      device.spec_status === "ready" &&
      properties.some(
        (property) =>
          property.type_name === "on" &&
          property.service_type_name === powerService &&
          property.has_value &&
          property.value === true &&
          ["current", "unverified", "cloud_cache", "baseline"].includes(
            property.reason,
          ),
      )
    );
  });
  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [],
  );
  async function read(deviceId: string) {
    if (!snapshot || !facts || pending) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(deviceId);
    setFeedback("");
    const properties = facts.properties
      .filter((item) => item.device_id === deviceId && item.readable)
      .slice(0, 100)
      .map(({ device_id, siid, piid }) => ({ did: device_id, siid, piid }));
    try {
      const result = await requestJson(
        (client, options) =>
          client.api.mijia.properties.read.$post(
            { json: { scope_epoch: snapshot.scope_epoch, properties } },
            options,
          ),
        propertyReadResultSchema,
        { signal: controller.signal, timeoutMs: 40_000 },
      );
      if (!controller.signal.aborted) {
        const counts = (outcome: string) =>
          result.items.filter((item) => item.outcome === outcome).length;
        setFeedback(
          `读取完成：采纳 ${counts("applied")} 项，缓存候选 ${counts("candidate")} 项，未改变 ${counts("unchanged")} 项，失败 ${counts("failed")} 项。值以后台推送为准，缓存不代表实时状态。`,
        );
      }
    } catch {
      if (!controller.signal.aborted)
        setFeedback("读取未完成，请查看连接状态后手动重试。");
    } finally {
      if (!controller.signal.aborted) setPending(null);
    }
  }
  async function retry() {
    if (!snapshot || pending) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending("retry");
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
    } catch {
      if (!controller.signal.aborted)
        setFeedback("暂时无法恢复采集，请稍后手动重试。");
    } finally {
      if (!controller.signal.aborted) setPending(null);
    }
  }
  if (!facts) return <output className="notice">正在同步房间状态…</output>;
  return (
    <div className="rooms-view">
      <div className="page-toolbar">
        <div>
          <strong>房间状态</strong>
          <span className="rooms-subtitle">设备上报后自动更新</span>
        </div>
        <Link to="/device-logs" className="button">
          查看上报日志
        </Link>
      </div>
      <div className="rooms-overview">
        <label>
          选择房间
          <select
            value={roomId ?? "unassigned"}
            onChange={(event) => onSelect(event.target.value)}
          >
            {rooms.map((room) => (
              <option key={room.room_id} value={room.room_id}>
                {room.name}
              </option>
            ))}
            <option value="unassigned">未分配房间</option>
          </select>
        </label>
        <div>
          <strong>{collectionLabels[facts.collection.status]}</strong>
          <p>
            {facts.coverage.devices} 台设备 · {facts.coverage.properties} 个属性
            · {facts.coverage.valid} 项有效 · {facts.coverage.missing} 项缺值
          </p>
        </div>
        <Button disabled={!synced || !!pending} onClick={() => void retry()}>
          重试采集
        </Button>
      </div>
      {!synced ? (
        <p className="notice notice-warning">
          页面正在重新同步，显示的是上次已知状态。
        </p>
      ) : null}
      {facts.collection.reason || facts.collection.capacity_degraded ? (
        <p className="notice notice-warning">
          采集状态：{facts.collection.reason ?? "容量不足"}；已记录{" "}
          {facts.collection.gaps} 次缺口，丢弃 {facts.collection.dropped}{" "}
          条，拒收 {facts.collection.rejected} 条。
        </p>
      ) : null}
      {facts.coverage.unconfirmed_subscriptions ||
      facts.coverage.unknown_specifications ? (
        <p className="notice">
          {facts.coverage.unconfirmed_subscriptions} 台设备的属性订阅未确认，
          {facts.coverage.unknown_specifications}{" "}
          台设备的规格尚未就绪。未覆盖项保留为未知。
        </p>
      ) : null}
      <p className="rooms-help">
        初始化会自动分批读取设备状态，再由上报持续更新。云端缓存标为待确认；只有确认来源与有效期的属性会标为有效。
      </p>
      <label className="rooms-toggle">
        <input
          type="checkbox"
          checked={onlyOn}
          onChange={(event) => onOnlyOnChange(event.target.checked)}
        />
        仅显示开启的设备
      </label>
      <label className="rooms-toggle">
        <input
          type="checkbox"
          checked={showMissing}
          onChange={(event) => setShowMissing(event.target.checked)}
        />
        显示缺值属性与尚未上报的设备
      </label>
      <p className="rooms-help">
        显示 {visibleDevices.length} / {facts.devices.length} 台设备
        {onlyOn
          ? "；按最近一次主开关值筛选，无开关或状态未知的设备隐藏。"
          : "。"}
      </p>
      {feedback ? <output className="notice">{feedback}</output> : null}
      {visibleDevices.map((device) => {
        const properties = facts.properties.filter(
          (item) =>
            item.device_id === device.id && (showMissing || item.has_value),
        );
        if (!showMissing && !properties.length) return null;
        const coverage = facts.device_coverage.find(
          (item) => item.device_id === device.id,
        );
        return (
          <section className="room-device" key={device.id}>
            <header>
              <div>
                <h2>{device.name}</h2>
                <p>
                  {device.model} ·{" "}
                  {synced
                    ? device.availability === "online"
                      ? "在线"
                      : device.availability === "offline"
                        ? "离线"
                        : "在线状态未知"
                    : "等待同步"}{" "}
                  ·{" "}
                  {coverage
                    ? subscriptionLabels[coverage.properties]
                    : "尚未订阅"}
                </p>
              </div>
              <Button
                disabled={
                  !synced ||
                  !!pending ||
                  !properties.some((item) => item.readable) ||
                  device.availability === "offline"
                }
                onClick={() => void read(device.id)}
              >
                {pending === device.id ? "正在读取…" : "读取一次"}
              </Button>
            </header>
            {properties.length ? (
              <div className="room-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>属性</th>
                      <th>最近值</th>
                      <th>有效性</th>
                      <th>最近上报</th>
                      <th>最近变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {properties.map((property) => (
                      <tr key={`${property.siid}/${property.piid}`}>
                        <td>
                          {property.description}
                          <small>
                            {property.siid}/{property.piid}
                          </small>
                        </td>
                        <td className="room-value">
                          {property.has_value
                            ? `${JSON.stringify(property.value)}${property.unit && property.unit !== "none" ? ` ${property.unit}` : ""}`
                            : "—"}
                          {property.read_candidate ? (
                            <small
                              title={`缓存读取于 ${property.read_candidate.received_at}`}
                            >
                              缓存候选：
                              {JSON.stringify(property.read_candidate.value)}
                            </small>
                          ) : null}
                        </td>
                        <td>
                          <span
                            className={`fact-quality ${synced ? property.quality : "unconfirmed"}`}
                          >
                            {synced
                              ? qualityLabels[property.quality]
                              : "待同步"}
                          </span>
                          <small>{reasonLabels[property.reason]}</small>
                        </td>
                        <td title={property.last_report_at ?? ""}>
                          {time(property.last_report_at)}
                          {property.last_read_at ? (
                            <small>读取 {time(property.last_read_at)}</small>
                          ) : null}
                        </td>
                        <td title={property.last_change_at ?? ""}>
                          {time(property.last_change_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rooms-help">
                尚无可用属性资料，采集仍会接收该设备的合法上报。
              </p>
            )}
          </section>
        );
      })}
      {onlyOn && facts.devices.length > 0 && visibleDevices.length === 0 ? (
        <p className="notice">
          没有最近状态为开启的设备，取消“仅显示开启的设备”可查看其他设备。
        </p>
      ) : null}
      {!onlyOn &&
      !showMissing &&
      facts.devices.length > 0 &&
      !facts.properties.some((item) => item.has_value) ? (
        <p className="notice">
          尚未取得这个房间的属性值，请等待初始化读取或设备上报。也可显示缺值属性后手动读取。
        </p>
      ) : null}
      {!facts.devices.length ? (
        <p className="notice">这个房间还没有设备。</p>
      ) : null}
      {facts.coverage.truncated ? (
        <p className="notice notice-warning">
          此视图最多展示 2,000 项属性，范围已裁减。
        </p>
      ) : null}
    </div>
  );
}
