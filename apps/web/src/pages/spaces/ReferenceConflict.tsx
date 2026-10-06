import type { spatialDeleteResultSchema } from "@home-agent/api/spatial";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import type { Editor } from "./types";
import type { createSpatialLabels } from "./labels";
export function ReferenceConflict({
  pending,
  conflict,
  labels,
  onEdit,
}: {
  pending: boolean;
  conflict: Extract<
    ReturnType<typeof spatialDeleteResultSchema.parse>,
    { status: "referenced" }
  >;
  labels: ReturnType<typeof createSpatialLabels>;
  onEdit: (editor: Editor) => void;
}) {
  return (
    <Notice tone="warning">
      <strong>存在引用，暂时无法删除。请先修改或删除以下记录。</strong>
      <ul className="grid gap-2">
        {conflict.references.passages.map((record) => (
          <li
            key={record.id}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              通道：{record.name} · {labels.spaceName(record.space_a_id)} ↔{" "}
              {labels.spaceName(record.space_b_id)}
            </span>
            <Button
              size="small"
              disabled={pending}
              onClick={() => onEdit({ resource: "passage", record })}
            >
              编辑通道
            </Button>
          </li>
        ))}
        {conflict.references.observation_bindings.map((record) => (
          <li
            key={record.id}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              观测绑定：{labels.bindingLabel(record)}
              {record.enabled ? "" : "（已停用）"}
            </span>
            <Button
              size="small"
              disabled={pending}
              onClick={() => onEdit({ resource: "binding", record })}
            >
              编辑绑定
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
