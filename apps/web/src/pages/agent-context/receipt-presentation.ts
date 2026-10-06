import { observationReasonLabels } from "../../modules/agent-context/presentation";
import {
  reasonLabels,
  sourceLabels,
  subscriptionLabels,
  collectionLabels,
  connectionLabels,
} from "../../modules/devices/presentation";
import { formatDevicePropertyValue } from "../../modules/devices/presentation";
import type {
  agentReceiptChangeSchema,
  agentReceiptDeviceSchema,
  agentReceiptPropertyMetadataSchema,
} from "@home-agent/api/agent-receipts";
import type { z } from "zod";
import { partLabels, statusLabels, time } from "./presentation";
import {
  mediaStateLabel,
  windowInputStates,
  petSoundSummary,
} from "../../modules/perception/window-presentation";

type Change = z.infer<typeof agentReceiptChangeSchema>;
export function deviceSubject(
  metadata: z.infer<typeof agentReceiptDeviceSchema>,
) {
  return `${metadata.device_name === null ? "房间未知" : (metadata.room_name ?? "未分配房间")} / ${metadata.device_name ?? metadata.device_id}`;
}
export function propertySubject(
  metadata: z.infer<typeof agentReceiptPropertyMetadataSchema>,
) {
  return `${deviceSubject(metadata)} / ${metadata.capability?.description ?? `属性 ${metadata.siid}.${metadata.piid}（名称未知）`}`;
}
export function propertyDisplayValue(
  metadata: z.infer<typeof agentReceiptPropertyMetadataSchema>,
  value: Extract<Change, { kind: "property" }>["after"],
) {
  if (!value) return "未提供";
  if (!value.has_value) return "无值";
  return formatDevicePropertyValue(value.value, metadata.capability ?? {});
}
export function presentReceiptChange(change: Change) {
  const operation =
    "after" in change
      ? change.after === null
        ? "已删除"
        : change.before === null
          ? "首次接收"
          : "更新"
      : change.initial
        ? "首次接收"
        : "更新";
  switch (change.kind) {
    case "property": {
      const old = propertyDisplayValue(change.metadata, change.before);
      const next = propertyDisplayValue(change.metadata, change.after);
      const unchanged =
        change.before &&
        change.after &&
        change.before.has_value === change.after.has_value &&
        change.before.value === change.after.value;
      const updates: string[] = [];
      if (change.before && change.after) {
        const before = change.before;
        const after = change.after;
        if (before.reason !== after.reason)
          updates.push(
            `可用性：${reasonLabels[before.reason]} → ${reasonLabels[after.reason]}`,
          );
        if (before.evidence?.observation_id !== after.evidence?.observation_id)
          updates.push(
            after.evidence
              ? `收到${sourceLabels[after.evidence.source]}报告`
              : "已清除原报告",
          );
        else if (
          JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)
        )
          updates.push("报告来源信息更新");
        for (const [key, label] of [
          ["last_report_at", "最近上报时间"],
          ["last_read_at", "最近读取时间"],
          ["expires_at", "有效期截止"],
          ["applied_at", "状态应用时间"],
          ["last_change_at", "数值变化时间"],
        ] as const) {
          if (before[key] !== after[key])
            updates.push(
              `${label}：${time(before[key])} → ${time(after[key])}`,
            );
        }
        if (
          JSON.stringify(before.read_candidate) !==
          JSON.stringify(after.read_candidate)
        )
          updates.push(
            after.read_candidate
              ? `读取候选值：${formatDevicePropertyValue(after.read_candidate.value, change.metadata.capability ?? {})}（尚未采用）`
              : "已清除读取候选值",
          );
      }
      return {
        subject: propertySubject(change.metadata),
        detail:
          change.after === null
            ? `${old} → 已删除`
            : change.before === null
              ? `首次接收：${next}`
              : unchanged
                ? `当前值：${next}（未变化）${updates.length ? `；${updates.join("；")}` : ""}`
                : `${old} → ${next}${updates.length ? `；${updates.join("；")}` : ""}`,
      };
    }
    case "online":
      return {
        subject: `${deviceSubject(change.metadata)} / 在线状态`,
        detail: `${change.before === null ? "未提供" : change.before ? "在线" : "离线"} → ${change.after === null ? "已删除" : change.after ? "在线" : "离线"}`,
      };
    case "source_health":
      return {
        subject: `来源连接 / ${change.key}`,
        detail: `${change.before ? connectionLabels[change.before.status] : "未提供"} → ${change.after ? connectionLabels[change.after.status] : "已删除"}${change.after?.reason ? ` · ${change.after.reason}` : ""}`,
      };
    case "device_coverage":
      return {
        subject: `${deviceSubject(change.metadata)} / 订阅覆盖`,
        detail: change.after
          ? `属性 ${subscriptionLabels[change.after.properties]} · 在线 ${subscriptionLabels[change.after.online]}${change.after.reason ? ` · ${change.after.reason}` : ""}`
          : "已删除订阅覆盖",
      };
    case "collection":
      return {
        subject: "采集状态",
        detail: change.after
          ? `${change.before ? collectionLabels[change.before.status] : "未提供"} → ${collectionLabels[change.after.status]} · 缺口 ${change.after.gaps} · 拒收 ${change.after.rejected} · 丢弃 ${change.after.dropped}${change.after.capacity_degraded ? " · 容量受限" : ""}${change.after.reason ? ` · ${change.after.reason}` : ""}`
          : "已删除采集状态",
      };
    case "observation": {
      const record = change.after ?? change.before;
      const old = change.before?.window_material;
      const next = change.after?.window_material;
      const details: string[] = [];
      if (change.before && change.after) {
        for (const id of change.after.member_sighting_ids) {
          const previous = change.before.member_sighting_revisions[id];
          const current = change.after.member_sighting_revisions[id];
          if (previous !== undefined && previous !== current)
            details.push(`成员出现归因修订：${previous} → ${current} (${id})`);
        }
      }
      if (old && next) {
        if (old.revision !== next.revision)
          details.push(`窗口内容修订：${old.revision} → ${next.revision}`);
        if (old.speech_count !== next.speech_count)
          details.push(
            `语音转写：${old.speech_count} → ${next.speech_count} 段`,
          );
        if (old.speech_enabled !== next.speech_enabled)
          details.push(
            `语音转写：${old.speech_enabled ? "已启用" : "未启用"} → ${next.speech_enabled ? "已启用" : "未启用"}`,
          );
        if (petSoundSummary(old) !== petSoundSummary(next))
          details.push(
            `猫狗叫声：${petSoundSummary(old)} → ${petSoundSummary(next)}`,
          );
        if (old.inputState !== next.inputState)
          details.push(
            `原始音视频：${windowInputStates[old.inputState]} → ${windowInputStates[next.inputState]}`,
          );
        if (old.sampledMedia?.state !== next.sampledMedia?.state)
          details.push(
            `片段：${mediaStateLabel(old.sampledMedia?.state)} → ${mediaStateLabel(next.sampledMedia?.state)}`,
          );
        if (
          old.sampledMedia?.error !== next.sampledMedia?.error &&
          next.sampledMedia?.error
        )
          details.push(`生成原因：${next.sampledMedia.error}`);
        if (
          old.sampledMedia?.readableUntil !== next.sampledMedia?.readableUntil
        )
          details.push(
            `片段有效期：${time(old.sampledMedia?.readableUntil)} → ${time(next.sampledMedia?.readableUntil)}`,
          );
        if (
          old.sampledMedia?.selection.representation !==
            next.sampledMedia?.selection.representation ||
          old.sampledMedia?.selection.includeAudio !==
            next.sampledMedia?.selection.includeAudio
        )
          details.push("片段生成选项更新");
      }
      return {
        subject: record
          ? record.reasons
              .map((reason) => observationReasonLabels[reason])
              .join("、")
          : change.key,
        detail: `${operation}观察 · ${time(record?.startedAt)} · ${record?.member_sighting_ids.length ?? 0} 条成员引用${record?.window_id ? " · 音视频窗口" : ""}${details.length ? ` · ${details.join(" · ")}` : ""}`,
      };
    }
    case "member_sighting": {
      const record = change.after ?? change.before;
      return {
        subject:
          record?.attribution.kind === "known"
            ? `成员最后出现 / ${record.attribution.association.memberId}`
            : "未归因目标最后出现",
        detail: `${operation}出现记录 · ${time(record?.lastObservedAt)} · ${record?.deviceId ?? change.key} / 镜头 ${record?.channel ?? "未知"}`,
      };
    }
    case "observation_source":
      return {
        subject:
          change.key === "member_sightings" ? "成员观察来源" : "感知来源",
        detail: `${change.before ? statusLabels[change.before.status] : "未提供"} → ${change.after ? statusLabels[change.after.status] : "已删除"}${change.after?.reason ? ` · ${change.after.reason}` : ""}${change.after?.truncated ? " · 集合已截断" : ""}`,
      };
    case "space":
    case "passage":
      return {
        subject: change.after?.name ?? change.before?.name ?? change.key,
        detail: `${operation}${change.kind === "space" ? "空间" : "通道"}资料`,
      };
    case "observation_binding": {
      const fields = (
        binding: Extract<Change, { kind: "observation_binding" }>["before"],
        metadata: Extract<
          Change,
          { kind: "observation_binding" }
        >["metadata"]["before"],
      ) =>
        binding
          ? {
              source: `${metadata?.device_name ? `${metadata.device_name} (${binding.device_id})` : binding.device_id}${binding.channel === null ? "" : ` / 镜头 ${binding.channel}`}`,
              target: `${binding.space_id !== null ? "空间" : "通道"}：${metadata?.target_name ? `${metadata.target_name} (${binding.space_id ?? binding.passage_id})` : (binding.space_id ?? binding.passage_id)}`,
              enabled: binding.enabled ? "启用" : "停用",
              description: binding.description || "无说明",
            }
          : null;
      const old = fields(change.before, change.metadata.before);
      const next = fields(change.after, change.metadata.after);
      const current = next ?? old;
      const details: string[] = [];
      if (old && next) {
        if (old.source !== next.source)
          details.push(`来源：${old.source} → ${next.source}`);
        if (old.target !== next.target)
          details.push(`目标：${old.target} → ${next.target}`);
        if (old.enabled !== next.enabled)
          details.push(`状态：${old.enabled} → ${next.enabled}`);
        if (old.description !== next.description)
          details.push(`说明：${old.description} → ${next.description}`);
      }
      return {
        subject: current
          ? `${current.source} / ${current.target}`
          : `观测绑定 / ${change.key}`,
        detail: `${operation}观测绑定 · ${old && next ? details.join(" · ") || "资料版本更新" : `${current?.enabled ?? "未提供"} · ${current?.description ?? "无说明"}`}`,
      };
    }
    case "member":
      return {
        subject: change.after?.name ?? change.before?.name ?? change.key,
        detail: `${operation}成员资料`,
      };
    case "inventory_device": {
      const device = change.after ?? change.before;
      return {
        subject: `${device?.room_name ?? "未分配房间"} / ${device?.name ?? change.key}`,
        detail: `${operation}设备资料`,
      };
    }
    case "household_metadata":
      return {
        subject: {
          household: "家庭状态",
          home: "家庭资料",
          room: "房间资料",
          specs: "设备属性定义",
        }[change.key],
        detail: `${operation}资料`,
      };
    case "availability":
      return {
        subject: `${partLabels[change.key]} / 数据可用性`,
        detail: change.after
          ? `${statusLabels[change.after.status]}${change.after.reason ? `：${change.after.reason}` : ""}`
          : "已删除",
      };
  }
  throw new Error("Unknown receipt change kind");
}
