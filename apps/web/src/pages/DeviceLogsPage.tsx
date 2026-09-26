import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Activity, Download, Pause, Play, Search, Square } from "lucide-react";
import {
  deviceLogSnapshotSchema,
  type DeviceLogSnapshot,
} from "@home-agent/api/device-logs";
import { Button } from "../components/Button";
import { requestJson, requestErrorMessage } from "../lib/api";
import { householdSnapshotAtom } from "../features/mijia/household-state";
import { useDeviceLogs } from "../features/device-logs/use-device-logs";
import "../features/device-logs/device-logs.css";

const time = (value: string) =>
  new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const statusLabels = {
  capturing: "采集中",
  complete: "采集完成",
  stopped: "已停止",
  interrupted: "采集中断",
  error: "采集异常",
};
const changeLabels = {
  first: "首次上报",
  changed: "值变化",
  same: "同值上报",
  control: "连接记录",
};
const kindLabels = {
  property: "属性",
  online: "在线状态",
  connection: "连接",
  subscription: "订阅",
};

export default function DeviceLogsPage() {
  const household = useAtomValue(householdSnapshotAtom)?.projection.household
    .household;
  const scope = JSON.stringify([household?.account_id, household?.home_id]);
  const { data, connected } = useDeviceLogs(scope);
  const { run, entries } = data;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("reports");
  const [change, setChange] = useState("all");
  const [frozen, setFrozen] = useState<DeviceLogSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = frozen !== null && frozen.run?.id === run?.id;
  const displayed = paused ? frozen.entries : entries;
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return displayed
      .filter(
        (row) =>
          (kind === "all" ||
            (kind === "reports"
              ? row.kind === "property" || row.kind === "online"
              : row.kind === kind)) &&
          (change === "all" || row.change === change) &&
          (!search ||
            [
              row.device_name,
              row.device_id,
              row.room_name,
              row.property,
              row.description,
              row.value,
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(search)),
      )
      .toReversed();
  }, [displayed, query, kind, change]);
  async function capture(action: "start" | "stop") {
    setPending(true);
    setError(null);
    try {
      if (action === "start")
        await requestJson(
          (client, options) =>
            client.api.mijia.logs.capture.$post(
              { json: { duration_seconds: 600 } },
              options,
            ),
          deviceLogSnapshotSchema,
        );
      else
        await requestJson(
          (client, options) =>
            client.api.mijia.logs.capture.$delete({}, options),
          deviceLogSnapshotSchema,
        );
      setFrozen(null);
    } catch (cause) {
      setError(requestErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  const capturing = run?.status === "capturing";
  const reports = (run?.property_reports ?? 0) + (run?.online_reports ?? 0);
  const elapsed = Math.floor(run?.elapsed_seconds ?? 0);
  const remaining = Math.max(0, (run?.duration_seconds ?? 600) - elapsed);
  const activeDevices =
    run?.devices.filter((device) => device.packets > 0) ?? [];
  const minutes = Array.from(
    { length: Math.ceil((run?.duration_seconds ?? 600) / 60) },
    (_, offset) => ({
      offset,
      count:
        run?.minutes.find((minute) => minute.offset === offset)?.packets ?? 0,
    }),
  );
  const maximum = Math.max(1, ...minutes.map((minute) => minute.count));
  const unseen = paused
    ? Math.max(0, (run?.total_rows ?? 0) - (frozen.run?.total_rows ?? 0))
    : 0;

  return (
    <section className="device-logs">
      <div className="log-heading">
        <div>
          <h2>设备上报日志</h2>
          <p>查看家庭里的 MQTT 推送与上报密度</p>
        </div>
        <div className="log-actions">
          {run && (
            <a
              className="button button-secondary"
              href="/api/mijia/logs/download"
              download
            >
              <Download size={15} />
              下载完整日志
            </a>
          )}
          <Button
            variant={capturing ? "secondary" : "primary"}
            disabled={
              pending ||
              !connected ||
              (!capturing && household?.status !== "running")
            }
            onClick={() => void capture(capturing ? "stop" : "start")}
          >
            {capturing ? <Square size={14} /> : <Play size={14} />}
            {pending ? "处理中…" : capturing ? "停止采集" : "采集 10 分钟"}
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="notice notice-error">
          {error}
        </div>
      )}
      <div className="log-session">
        <div className="log-session-line">
          <span className={`log-status ${capturing ? "is-live" : ""}`}>
            <i />
            {run
              ? statusLabels[run.status]
              : connected
                ? "等待采集"
                : "正在连接"}
          </span>
          <strong>{run?.home_name ?? "当前家庭"}</strong>
          <span>
            {run
              ? `${run.device_count} 台设备 · ${run.confirmed_topics}/${run.expected_topics} 项订阅确认`
              : "从当前家庭全部可订阅设备采集"}
          </span>
        </div>
        <span className="log-timing">
          {run
            ? `${time(run.started_at)} 开始 · ${capturing ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒` : `已记录 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}`
            : "点击采集后开始记录"}
        </span>
      </div>
      {!connected && (
        <output className="notice">
          页面连接恢复中，后台采集不受页面断线影响。
        </output>
      )}
      {run?.reason && <output className="notice">{run.reason}</output>}
      {!!run?.failed_topics && (
        <div className="notice notice-error">
          有 {run.failed_topics} 项订阅失败，当前样本覆盖不完整。
        </div>
      )}
      {capturing && run.connection !== "connected" && (
        <div className="notice notice-error">
          MQTT 连接中断或重连中，这段时间可能漏报。
        </div>
      )}
      {!!run?.excluded_devices.length && (
        <div className="notice">
          有 {run.excluded_devices.length} 台设备的标识不支持订阅，未纳入采集。
        </div>
      )}
      <div className="log-metrics">
        <div>
          <span>收到消息包</span>
          <strong>
            {run?.packets ?? 0}
            <small>包</small>
          </strong>
          <p>
            {run && elapsed ? ((run.packets * 60) / elapsed).toFixed(1) : "0.0"}{" "}
            包 / 分钟
          </p>
        </div>
        <div>
          <span>设备状态上报</span>
          <strong>
            {reports}
            <small>条</small>
          </strong>
          <p>
            属性 {run?.property_reports ?? 0} · 在线 {run?.online_reports ?? 0}
          </p>
        </div>
        <div>
          <span>同值重复上报</span>
          <strong>
            {run?.same_value_reports ?? 0}
            <small>条</small>
          </strong>
          <p>
            首次 {run?.first_reports ?? 0} · 值变化 {run?.value_changes ?? 0}
          </p>
        </div>
        <div>
          <span>有上报的设备</span>
          <strong>
            {activeDevices.length}
            <small>/ {run?.device_count ?? "—"}</small>
          </strong>
          <p>仅统计本次窗口收到的推送</p>
        </div>
      </div>
      <div className="log-density">
        <div className="log-density-copy">
          <Activity size={17} />
          <strong>每分钟消息密度</strong>
          <span>按接收时间统计</span>
        </div>
        <div className="log-bars" aria-label="每分钟消息包数量">
          {minutes.map((minute) => (
            <div
              key={minute.offset}
              className={`log-bar-column ${run && minute.offset * 60 > elapsed ? "is-future" : ""}`}
              title={`第 ${minute.offset + 1} 分钟：${minute.count} 包`}
            >
              <span>{minute.count || "—"}</span>
              <div className="log-bar-track">
                <i
                  style={{
                    height: `${Math.max(2, (minute.count / maximum) * 100)}%`,
                  }}
                />
              </div>
              <small>{minute.offset + 1} 分</small>
            </div>
          ))}
        </div>
      </div>
      <div className="log-view">
        <div className="log-filters">
          <label className="log-search">
            <Search size={15} />
            <input
              aria-label="搜索设备日志"
              placeholder="搜索设备、房间、属性或值"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="日志类型"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="reports">设备上报</option>
            <option value="property">属性上报</option>
            <option value="online">在线状态</option>
            <option value="all">全部（含连接记录）</option>
          </select>
          <select
            aria-label="变化类型"
            value={change}
            onChange={(event) => setChange(event.target.value)}
          >
            <option value="all">全部变化</option>
            <option value="changed">值变化</option>
            <option value="same">同值上报</option>
            <option value="first">首次上报</option>
          </select>
          <Button
            onClick={() => setFrozen(paused ? null : data)}
            disabled={!run}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? `恢复显示${unseen ? `（+${unseen}）` : ""}` : "暂停显示"}
          </Button>
        </div>
        <div className="log-list-caption">
          <span>
            {paused ? "显示已暂停，采集继续" : "新上报显示在顶部"} · 当前筛选{" "}
            {rows.length} 条
          </span>
          <span>页面保留最近 500 条，下载包含完整记录</span>
        </div>
        <div className="log-table-wrap">
          <table className="log-table">
            <thead>
              <tr>
                <th>接收时间</th>
                <th>设备 / 房间</th>
                <th>属性 / 类型</th>
                <th>上报值</th>
                <th>变化</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sequence}>
                  <td className="log-clock">
                    {time(row.received_at)}
                    <small>#{row.sequence}</small>
                  </td>
                  <td>
                    <strong>{row.device_name}</strong>
                    <small>{row.room_name || "—"}</small>
                  </td>
                  <td>
                    {row.description}
                    <small>{row.property || kindLabels[row.kind]}</small>
                  </td>
                  <td className="log-value">
                    <code>{row.value}</code>
                    {row.change === "changed" && (
                      <small>之前：{row.previous_value}</small>
                    )}
                  </td>
                  <td>
                    <span className={`log-change log-change-${row.change}`}>
                      {changeLabels[row.change]}
                    </span>
                  </td>
                  <td>
                    <details>
                      <summary aria-label={`查看第 ${row.sequence} 条详情`}>
                        上报详情
                      </summary>
                      <pre>{JSON.stringify(row.observation, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="log-empty">
              <Activity size={24} />
              <strong>
                {query || change !== "all" || kind !== "reports"
                  ? "没有符合筛选条件的日志"
                  : capturing
                    ? "正在等待设备上报"
                    : "暂无设备上报"}
              </strong>
              <span>
                {capturing
                  ? "设备有推送时会自动出现在这里；静默设备不会生成日志。"
                  : "开始一次采集，查看设备上报的实际频率。"}
              </span>
            </div>
          )}
        </div>
      </div>
      {activeDevices.length > 0 && (
        <details className="log-device-summary">
          <summary>设备上报分布 · {activeDevices.length} 台有上报</summary>
          <div>
            {activeDevices
              .toSorted((a, b) => b.packets - a.packets)
              .map((device) => (
                <p key={device.id}>
                  <span>
                    {device.room} · {device.name}
                  </span>
                  <strong>
                    {device.packets} 包{" "}
                    <small> / {device.properties + device.online} 条</small>
                  </strong>
                </p>
              ))}
          </div>
        </details>
      )}
      <p className="log-footnote">
        统计已解析的属性与在线消息，一个消息包可能含多条属性。首次上报不等于状态变化；同值与保留消息均保留。连接记录不计入消息密度。
        {run
          ? `保留消息 ${run.retained_reports} 条 · 断线 ${run.disconnections} 次。`
          : ""}
        暂停显示、切换页面或刷新不会停止后台采集；后端重启会中断采集。
      </p>
    </section>
  );
}
