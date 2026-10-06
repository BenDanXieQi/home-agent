import { Pencil, House, DoorOpen, ScanEye } from "lucide-react";
import { Button } from "../../components/Button";
import { SpatialRecordRow } from "./SpatialRecordRow";
import type { Editor, Deletion } from "./types";
import type {
  SpatialSnapshot,
  SpatialCommand,
} from "../../modules/spatial/api";
import type { createSpatialLabels } from "./labels";
export function SpatialLists({
  area,
  snapshot,
  pending,
  labels,
  onEdit,
  onDelete,
  onToggle,
}: {
  area: Editor["resource"];
  snapshot: SpatialSnapshot;
  pending: boolean;
  labels: ReturnType<typeof createSpatialLabels>;
  onEdit: (editor: Editor) => void;
  onDelete: (command: Deletion) => void;
  onToggle: (command: Extract<SpatialCommand, { action: "enabled" }>) => void;
}) {
  return (
    <div className="grid gap-1.5 rounded-2xl bg-surface p-2">
      {area === "space"
        ? snapshot.spaces.map((record) => (
            <SpatialRecordRow
              key={record.id}
              id={record.id}
              name={record.name}
              icon={<House size={17} strokeWidth={1.5} />}
              description={record.description}
              actions={
                <>
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Pencil size={13} />}
                    disabled={pending}
                    onClick={() => onEdit({ resource: "space", record })}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      onDelete({
                        action: "delete",
                        resource: "space",
                        input: {
                          scope: snapshot.scope,
                          id: record.id,
                          expected_updated_at: record.updated_at,
                        },
                        label: record.name,
                      })
                    }
                  >
                    删除
                  </Button>
                </>
              }
            />
          ))
        : null}
      {area === "passage"
        ? snapshot.passages.map((record) => (
            <SpatialRecordRow
              key={record.id}
              id={record.id}
              name={record.name}
              icon={<DoorOpen size={17} strokeWidth={1.5} />}
              description={record.description}
              detail={
                <>
                  {labels.spaceName(record.space_a_id)} ↔{" "}
                  {labels.spaceName(record.space_b_id)}
                </>
              }
              actions={
                <>
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Pencil size={13} />}
                    disabled={pending}
                    onClick={() => onEdit({ resource: "passage", record })}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      onDelete({
                        action: "delete",
                        resource: "passage",
                        input: {
                          scope: snapshot.scope,
                          id: record.id,
                          expected_updated_at: record.updated_at,
                        },
                        label: record.name,
                      })
                    }
                  >
                    删除
                  </Button>
                </>
              }
            />
          ))
        : null}
      {area === "binding"
        ? snapshot.observation_bindings.map((record) => (
            <SpatialRecordRow
              key={record.id}
              id={record.id}
              name={labels.bindingLabel(record)}
              icon={<ScanEye size={17} strokeWidth={1.5} />}
              description={record.description}
              detail={
                <span
                  className={`inline-flex items-center gap-1.5 ${record.enabled ? "text-sage" : "text-muted"}`}
                >
                  <span
                    className={`size-1.5 rounded-full ${record.enabled ? "bg-sage" : "bg-muted/40"}`}
                  />
                  {record.enabled ? "已启用" : "已停用"}
                </span>
              }
              actions={
                <>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      onToggle({
                        action: "enabled",
                        resource: "binding",
                        input: {
                          scope: snapshot.scope,
                          id: record.id,
                          expected_updated_at: record.updated_at,
                          enabled: !record.enabled,
                        },
                      })
                    }
                  >
                    {record.enabled ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    icon={<Pencil size={13} />}
                    disabled={pending}
                    onClick={() => onEdit({ resource: "binding", record })}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      onDelete({
                        action: "delete",
                        resource: "binding",
                        input: {
                          scope: snapshot.scope,
                          id: record.id,
                          expected_updated_at: record.updated_at,
                        },
                        label: labels.bindingLabel(record),
                      })
                    }
                  >
                    删除
                  </Button>
                </>
              }
            />
          ))
        : null}
    </div>
  );
}
