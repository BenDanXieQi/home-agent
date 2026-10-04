import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Collapsible } from "radix-ui";
import { m, AnimatePresence, useReducedMotion } from "motion/react";
import { Box, Video, ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  propertyReadResultSchema,
  type Projection,
} from "@home-agent/api/household";
import { useAtomValue } from "jotai";
import {
  createDevicePropertiesAtom,
  createDeviceCoverageAtom,
} from "../../modules/devices/facts";
import { Button } from "../../components/Button";
import { requestJson } from "../../api/client";
import { requestErrorMessage } from "../../messages/zh-CN";
import { expand } from "../../utils/motion";
import {
  summarizeProperties,
  qualityLabels,
  reasonLabels,
  subscriptionLabels,
  propertyValue,
  time,
} from "./fact-presentation";

export const DeviceStateRow = memo(function DeviceStateRow({
  device,
  scope,
  reliable,
  open,
  onOpenChange,
}: {
  device: Projection["device"][string];
  scope: string;
  reliable: boolean;
  open: boolean;
  onOpenChange: (deviceId: string, open: boolean) => void;
}) {
  const propertiesAtom = useMemo(
    () => createDevicePropertiesAtom(device.id),
    [device.id],
  );
  const properties = useAtomValue(propertiesAtom);
  const changeOpen = useCallback(
    (next: boolean) => onOpenChange(device.id, next),
    [device.id, onOpenChange],
  );
  const reduced = useReducedMotion();
  const id = useId();
  const recent = summarizeProperties(properties, device);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={changeOpen}
      className="overflow-hidden rounded-xl bg-white shadow-surface"
    >
      <Collapsible.Trigger
        className="grid min-h-[76px] w-full grid-cols-[minmax(160px,1.5fr)_minmax(100px,1fr)_70px_24px] items-center gap-5 px-4 py-3 text-left hover:bg-surface/50 max-md:grid-cols-[minmax(0,1fr)_52px_24px] max-md:gap-2 max-md:px-3"
        aria-label={`${open ? "收起" : "展开"}${device.name}详情`}
        aria-controls={id}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center text-muted">
            {device.camera ? (
              <Video size={20} strokeWidth={1.4} />
            ) : (
              <Box size={20} strokeWidth={1.4} />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block wrap-anywhere text-sm font-medium">
              {device.name}
            </strong>
            <span className="mt-1 block text-xs text-muted">
              {device.room_name ?? "未分配房间"}
            </span>
          </span>
        </span>
        <span className="min-w-0 text-xs leading-6 max-md:col-start-1 max-md:row-start-2 max-md:pl-11">
          {recent.length ? (
            recent.map((property) => (
              <span
                className="block wrap-anywhere"
                key={`${property.siid}/${property.piid}`}
              >
                <span className="text-muted">{property.description} </span>
                {propertyValue(property)}
                <span className="ml-2 text-muted">
                  {reliable ? qualityLabels[property.quality] : "待同步"}
                </span>
              </span>
            ))
          ) : (
            <span className="text-muted">尚未收到属性值</span>
          )}
        </span>
        <span
          className="text-xs text-muted data-[availability=online]:text-sage data-[availability=offline]:text-warning max-md:col-start-2 max-md:row-start-1"
          data-availability={reliable ? device.availability : "unknown"}
        >
          {!reliable
            ? "待确认"
            : device.availability === "online"
              ? "在线"
              : device.availability === "offline"
                ? "离线"
                : "未知"}
        </span>
        <ChevronRight
          size={15}
          aria-hidden="true"
          className={`text-muted motion-safe:transition-transform motion-safe:duration-200 max-md:col-start-3 max-md:row-start-1 ${open ? "rotate-90" : ""}`}
        />
      </Collapsible.Trigger>
      <AnimatePresence initial={false}>
        {open ? (
          <Collapsible.Content id={id} forceMount asChild>
            <m.div className="overflow-hidden" {...(reduced ? {} : expand)}>
              <DeviceDetails
                device={device}
                properties={properties}
                scope={scope}
                reliable={reliable}
              />
            </m.div>
          </Collapsible.Content>
        ) : null}
      </AnimatePresence>
    </Collapsible.Root>
  );
});

function DeviceDetails({
  device,
  properties,
  scope,
  reliable,
}: Pick<
  Parameters<typeof DeviceStateRow>[0],
  "device" | "scope" | "reliable"
> & { properties: Parameters<typeof summarizeProperties>[0] }) {
  const coverageAtom = useMemo(
    () => createDeviceCoverageAtom(device.account_id, device.id),
    [device.account_id, device.id],
  );
  const coverage = useAtomValue(coverageAtom);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const readable = properties.filter((property) => property.readable);
  async function read() {
    if (pending || !reliable || !readable.length) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setFeedback("");
    try {
      const result = await requestJson(
        (client, options) =>
          client.api.mijia.properties.read.$post(
            {
              json: {
                scope_epoch: scope,
                properties: readable
                  .slice(0, 100)
                  .map(({ device_id, siid, piid }) => ({
                    did: device_id,
                    siid,
                    piid,
                  })),
              },
            },
            options,
          ),
        propertyReadResultSchema,
        { signal: controller.signal, timeoutMs: 40_000 },
      );
      if (!controller.signal.aborted)
        setFeedback(
          `读取完成：采纳 ${result.items.filter((item) => item.outcome === "applied").length} 项，缓存候选 ${result.items.filter((item) => item.outcome === "candidate").length} 项，失败 ${result.items.filter((item) => item.outcome === "failed").length} 项。值以后台推送为准，缓存不代表实时状态。`,
        );
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(requestErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <div className="border-t border-line px-4 py-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="break-all text-xs text-muted">
          {device.model} ·{" "}
          {coverage ? subscriptionLabels[coverage.properties] : "尚未订阅"}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {device.camera ? (
            <Link to="/cameras" className="text-xs text-muted underline">
              查看画面
            </Link>
          ) : null}
          <Link to="/device-logs" className="text-xs text-muted underline">
            查看上报日志
          </Link>
          <Button
            disabled={
              !reliable ||
              pending ||
              !readable.length ||
              device.availability === "offline"
            }
            onClick={read}
          >
            {pending ? "正在读取…" : "读取一次"}
          </Button>
        </div>
      </div>
      {feedback ? (
        <output className="mb-3 block text-xs text-muted">{feedback}</output>
      ) : null}
      {readable.length > 100 ? (
        <p className="mb-3 text-xs text-muted">
          一次最多读取前 100 项可读属性。
        </p>
      ) : null}
      {properties.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[650px] text-left text-xs [&_th]:py-2 [&_th]:font-normal [&_th]:text-muted [&_td]:border-t [&_td]:border-line [&_td]:py-3 [&_td]:pr-4 [&_td]:align-top">
            <thead>
              <tr>
                <th>属性</th>
                <th>最近值</th>
                <th>有效性与来源</th>
                <th>最近上报 / 读取</th>
                <th>最近变化</th>
              </tr>
            </thead>
            <tbody>
              {properties.map((property) => (
                <tr key={`${property.siid}/${property.piid}`}>
                  <td>
                    {property.description}
                    <small className="mt-1 block text-muted">
                      {property.siid}/{property.piid}
                    </small>
                  </td>
                  <td className="max-w-60 wrap-anywhere">
                    {propertyValue(property)}
                    {property.read_candidate ? (
                      <small className="mt-1 block text-muted">
                        缓存候选：
                        {JSON.stringify(property.read_candidate.value)} ·{" "}
                        {time(property.read_candidate.received_at)}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    {reliable ? qualityLabels[property.quality] : "待同步"}
                    <small className="mt-1 block text-muted">
                      {reasonLabels[property.reason]}
                    </small>
                  </td>
                  <td title={property.last_report_at ?? ""}>
                    {time(property.last_report_at)}
                    {property.last_read_at ? (
                      <small className="mt-1 block text-muted">
                        读取 {time(property.last_read_at)}
                      </small>
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
        <p className="text-xs text-muted">
          尚未取得属性资料。设备仍保留在设备清单中，状态上报后自动更新。
        </p>
      )}
    </div>
  );
}
