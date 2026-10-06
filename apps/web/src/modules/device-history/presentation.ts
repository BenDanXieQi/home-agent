import { deviceHistoryRecordId } from "@home-agent/api/device-history";
import type { devicesAtom } from "../devices/state";
import type { HistoryResponse } from "./page";

function displayValue(record: HistoryResponse["records"][number]) {
  if (record.kind === "online") return record.value ? "在线" : "离线";
  const label = record.metadata.value_list?.find(
    (item) => item.value === record.value,
  )?.description;
  const value = label ?? String(record.value);
  return record.metadata.unit ? `${value} ${record.metadata.unit}` : value;
}

function describeLogEntry(
  record: HistoryResponse["records"][number],
  deviceName: string,
) {
  return {
    id: deviceHistoryRecordId(record),
    received_at: record.received_at,
    device_id: record.device_id,
    device_name: deviceName,
    kind: record.kind,
    property:
      record.kind === "property" ? `${record.siid}.${record.piid}` : "online",
    description:
      record.kind === "property" ? record.metadata.property_name : "在线状态",
    displayValue: displayValue(record),
    source: record.source,
    record,
  };
}

const logEntries = new WeakMap<
  HistoryResponse["records"][number],
  ReturnType<typeof describeLogEntry>
>();

export function historyLogEntries(
  records: HistoryResponse["records"],
  devices: ReturnType<typeof devicesAtom.read>,
) {
  const inventory = new Map(devices.map((device) => [device.id, device]));
  return records.map((record) => {
    const deviceName =
      inventory.get(record.device_id)?.name ?? record.device_id;
    const cached = logEntries.get(record);
    if (cached?.device_name === deviceName) return cached;
    const entry = describeLogEntry(record, deviceName);
    logEntries.set(record, entry);
    return entry;
  });
}

export type LogEntry = ReturnType<typeof historyLogEntries>[number];

export function historyDevices(devices: ReturnType<typeof devicesAtom.read>) {
  return devices
    .filter((device) => !device.archived)
    .map((device) => ({
      id: device.id,
      name: device.name,
      room: device.room_name ?? "未分配房间",
    }));
}
