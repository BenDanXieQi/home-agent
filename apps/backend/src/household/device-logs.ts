import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  deviceLogSnapshotSchema,
  type DeviceLogSnapshot,
  type DeviceLogEntry,
} from "@home-agent/api/device-logs";
import { MijiaError } from "../mijia/errors";
import { subscribableDevice } from "../mijia/protocols/miot/messages";
import type { MiotObservation } from "../mijia/protocols/miot/messages";
import type { HouseholdRuntime } from "./runtime";
import type { MijiaService } from "../mijia/service";

const RECENT_ROWS = 500;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Owns bounded diagnostic sampling; observations never become household facts. */
export class DevicePushLogs {
  private data: DeviceLogSnapshot = { run: null, entries: [] };
  readonly ready;
  private starting = false;
  private stopping = false;
  private capture: ReturnType<DevicePushLogs["createCapture"]> | undefined;
  private persistence = Promise.resolve();

  constructor(
    private readonly household: HouseholdRuntime,
    private readonly directory: string,
    private readonly source: Pick<
      MijiaService,
      "observeDevices" | "getDeviceSpec"
    >,
  ) {
    this.ready = this.restore();
  }

  private async restore() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.data = deviceLogSnapshotSchema.parse(
        JSON.parse(await readFile(join(this.directory, "latest.json"), "utf8")),
      );
      if (this.data.run?.status === "capturing") {
        this.data.run.status = "interrupted";
        this.data.run.reason = "后端重启，采集已中断";
        this.data.run.finished_at = new Date(
          Date.parse(this.data.run.started_at) +
            this.data.run.elapsed_seconds * 1000,
        ).toISOString();
        await this.persist();
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        console.warn("设备日志记录无法恢复，将从新的采集开始。");
    }
  }

  snapshot() {
    const scope = this.household.snapshot().projection.household.household;
    const run = this.data.run;
    if (
      !run ||
      run.account_id !== scope.account_id ||
      run.home_id !== scope.home_id
    )
      return { run: null, entries: [] } satisfies DeviceLogSnapshot;
    return {
      run: {
        ...run,
        elapsed_seconds:
          run.status === "capturing"
            ? Math.max(0, (Date.now() - Date.parse(run.started_at)) / 1000)
            : run.elapsed_seconds,
      },
      entries: this.data.entries,
    };
  }

  private persist() {
    if (this.data.run?.status === "capturing")
      this.data.run.elapsed_seconds = Math.max(
        0,
        (Date.now() - Date.parse(this.data.run.started_at)) / 1000,
      );
    const contents = JSON.stringify(this.data);
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.directory, "latest.json.tmp"), contents, {
          mode: 0o600,
        });
        await rename(
          join(this.directory, "latest.json.tmp"),
          join(this.directory, "latest.json"),
        );
      });
    return this.persistence;
  }

  async start(duration: number) {
    await this.ready;
    if (this.starting || this.stopping || this.capture)
      throw new MijiaError("invalid_state");
    if (!this.household.ready) throw new MijiaError("devices_failed");
    this.starting = true;
    try {
      const snapshot = this.household.snapshot();
      const scope = snapshot.projection.household.household;
      if (!scope.account_id || !scope.home_id)
        throw new MijiaError("not_bound");
      const all = Object.values(snapshot.projection.device).filter(
        (device) => !device.archived,
      );
      const devices = all.filter((device) => subscribableDevice(device.id));
      if (!devices.length) throw new MijiaError("device_not_found");
      const id = crypto.randomUUID();
      await writeFile(
        join(this.directory, `${id}.snapshot.json`),
        JSON.stringify(snapshot),
        { mode: 0o600 },
      );
      const started = new Date().toISOString();
      this.data = {
        run: {
          id,
          account_id: scope.account_id,
          home_id: scope.home_id,
          home_name:
            Object.values(snapshot.projection.home).find(
              (home) => home.home_id === scope.home_id,
            )?.name ?? "当前家庭",
          scope_epoch: snapshot.scope_epoch,
          status: "capturing",
          reason: null,
          started_at: started,
          finished_at: null,
          duration_seconds: duration,
          elapsed_seconds: 0,
          device_count: devices.length,
          excluded_devices: all
            .filter((device) => !subscribableDevice(device.id))
            .map((device) => ({ id: device.id, name: device.name })),
          expected_topics: devices.length * 2,
          confirmed_topics: 0,
          failed_topics: 0,
          all_confirmed_at: null,
          connection: "unknown",
          disconnections: 0,
          packets: 0,
          payload_bytes: 0,
          property_reports: 0,
          online_reports: 0,
          first_reports: 0,
          value_changes: 0,
          same_value_reports: 0,
          retained_reports: 0,
          total_rows: 0,
          minutes: [],
          devices: devices.map((device) => ({
            id: device.id,
            name: device.name,
            room: device.room_name ?? "未分配房间",
            packets: 0,
            properties: 0,
            online: 0,
          })),
        },
        entries: [],
      };
      const capture = this.createCapture(this.data.run!);
      this.capture = capture;
      try {
        await this.persist();
        const watch = await this.source.observeDevices(
          devices.map((device) => device.id),
          capture.receive,
          capture.controller.signal,
        );
        if (this.capture !== capture) watch.cancel();
      } catch {
        await this.stop("无法建立设备观察，请检查账号或设备连接", "error");
      }
      return this.snapshot();
    } finally {
      this.starting = false;
    }
  }

  private createCapture(run: NonNullable<DeviceLogSnapshot["run"]>) {
    const controller = new AbortController();
    const stream = createWriteStream(join(this.directory, `${run.id}.jsonl`), {
      flags: "wx",
      mode: 0o600,
    });
    const values = new Map<string, string>();
    const topics = new Map<string, string>();
    const devices = new Map(run.devices.map((device) => [device.id, device]));
    let previousPacket: string | undefined;
    let bytes = 0;
    let stopping = false;
    const receive = (event: MiotObservation) => {
      if (stopping || event.kind === "directory") return;
      if (
        Date.now() >=
        Date.parse(run.started_at) + run.duration_seconds * 1000
      ) {
        void this.stop(null, "complete");
        return;
      }
      const did =
        "did" in event
          ? event.did
          : event.kind === "subscription"
            ? (/^device\/([^/]+)\//.exec(event.topic)?.[1] ?? null)
            : null;
      const device = did ? devices.get(did) : undefined;
      const row: DeviceLogEntry = {
        sequence: ++run.total_rows,
        received_at: event.received_at,
        kind: event.kind,
        device_id: did,
        device_name: device?.name ?? "MQTT 连接",
        room_name: device?.room ?? "",
        property: "",
        description: "",
        value: "",
        previous_value: null,
        change: "control",
        observation: { ...event },
      };
      if (event.kind === "property" || event.kind === "online") {
        const offset = Math.floor(
          Math.max(
            0,
            Date.parse(event.received_at) - Date.parse(run.started_at),
          ) / 60_000,
        );
        let minute = run.minutes.find((item) => item.offset === offset);
        if (!minute) {
          minute = { offset, packets: 0, properties: 0, online: 0 };
          run.minutes.push(minute);
        }
        if (event.packet_id !== previousPacket) {
          previousPacket = event.packet_id;
          run.packets++;
          run.payload_bytes += event.packet_bytes;
          minute.packets++;
          if (device) device.packets++;
        }
        if (event.delivery_kind === "baseline") run.retained_reports++;
        row.property =
          event.kind === "property"
            ? `prop.${event.siid}.${event.piid}`
            : "online";
        row.value = JSON.stringify(
          event.kind === "property" ? event.value : event.online,
        );
        const key = `${event.did}/${row.property}`;
        row.previous_value = values.get(key) ?? null;
        row.change =
          row.previous_value === null
            ? "first"
            : row.previous_value === row.value
              ? "same"
              : "changed";
        if (row.change === "first") run.first_reports++;
        else if (row.change === "same") run.same_value_reports++;
        else run.value_changes++;
        values.set(key, row.value);
        if (event.kind === "property") {
          run.property_reports++;
          minute.properties++;
          if (device) device.properties++;
          try {
            row.description =
              this.source.getDeviceSpec(event.did).spec[row.property]
                ?.description ?? "未命名属性";
          } catch {
            row.description = "规格尚未就绪";
          }
        } else {
          run.online_reports++;
          minute.online++;
          if (device) device.online++;
          row.description = "在线状态";
          row.value = event.online ? "在线" : "离线";
          if (row.previous_value !== null)
            row.previous_value =
              row.previous_value === "true" ? "在线" : "离线";
        }
      } else if (event.kind === "connection") {
        run.connection = event.status;
        if (event.status === "closed") run.disconnections++;
        row.description = "连接状态";
        row.value = event.status;
      } else {
        topics.set(event.topic, event.status);
        run.confirmed_topics = [...topics.values()].filter(
          (status) => status === "confirmed",
        ).length;
        run.failed_topics = [...topics.values()].filter(
          (status) => status === "failed",
        ).length;
        if (
          run.confirmed_topics === run.expected_topics &&
          !run.all_confirmed_at
        )
          run.all_confirmed_at = event.received_at;
        row.description = event.topic.includes("properties_changed")
          ? "属性订阅"
          : "在线订阅";
        row.value = event.status;
      }
      this.data.entries.push(row);
      if (this.data.entries.length > RECENT_ROWS) this.data.entries.shift();
      const line = `${JSON.stringify(row)}\n`;
      bytes += Buffer.byteLength(line);
      stream.write(line);
      if (bytes >= MAX_FILE_BYTES || stream.writableLength > MAX_BUFFER_BYTES)
        void this.stop("日志容量已达上限，采集已停止", "error");
      if (event.kind === "subscription" && event.status === "cancelled")
        void this.stop("设备范围已变化，请重新开始采集", "interrupted");
    };
    const timer = setTimeout(
      () => void this.stop(null, "complete"),
      run.duration_seconds * 1000,
    );
    const flush = setInterval(() => {
      void this.persist().catch(() => this.stop("日志保存失败", "error"));
    }, 5000);
    const detach = this.household.subscribe(() => {
      if (
        this.household.epoch !== run.scope_epoch ||
        this.household.snapshot().projection.household.household.status ===
          "stopping"
      )
        void this.stop("家庭作用域变化或后端停止", "interrupted");
    });
    stream.on("error", () => {
      void this.stop("日志文件写入失败", "error");
    });
    return {
      controller,
      receive,
      close: async () => {
        stopping = true;
        clearTimeout(timer);
        clearInterval(flush);
        detach();
        controller.abort();
        if (!stream.destroyed)
          await new Promise<void>((done) => {
            stream.once("error", done);
            stream.end(done);
          });
      },
    };
  }

  async stop(
    reason: string | null = "手动停止",
    status: NonNullable<DeviceLogSnapshot["run"]>["status"] = "stopped",
  ) {
    const capture = this.capture;
    if (!capture) return this.snapshot();
    this.capture = undefined;
    this.stopping = true;
    const run = this.data.run!;
    run.status = status;
    run.reason = reason;
    run.finished_at = new Date().toISOString();
    run.elapsed_seconds = Math.max(
      0,
      (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000,
    );
    try {
      await capture.close();
      await this.persist();
      await writeFile(
        join(this.directory, `${run.id}.summary.json`),
        JSON.stringify(run, null, 2),
        { mode: 0o600 },
      );
    } catch {
      run.status = "error";
      run.reason = "日志保存失败，文件可能不完整";
      console.warn("设备日志保存失败。");
    } finally {
      this.stopping = false;
    }
    return this.snapshot();
  }

  download() {
    const run = this.snapshot().run;
    if (!run) throw new MijiaError("invalid_state");
    return {
      file: Bun.file(join(this.directory, `${run.id}.jsonl`)),
      name: `mqtt-${run.id}.jsonl`,
    };
  }
}
