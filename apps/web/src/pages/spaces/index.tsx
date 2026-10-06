import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { Plus, House, DoorOpen, ScanEye } from "lucide-react";
import type { spatialDeleteResultSchema } from "@home-agent/api/spatial";
import {
  householdSnapshotAtom,
  householdScopeEpochAtom,
} from "../../modules/household/state";
import { householdReliableAtom } from "../../modules/household/sync";
import {
  spatialQueryOptions,
  type SpatialSnapshot,
} from "../../modules/spatial/api";
import { useSpatialCommands } from "../../modules/spatial/use-spatial-commands";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { EmptyState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { SegmentedControl } from "../../components/SegmentedControl";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { requestErrorMessage } from "../../messages/zh-CN";
import { SpatialLists } from "./SpatialLists";
import { SpatialEditor } from "./SpatialEditor";
import { ReferenceConflict } from "./ReferenceConflict";
import { DeleteDialog } from "./DeleteDialog";
import { createSpatialLabels } from "./labels";
import type { Editor, Deletion } from "./types";

const areas = [
  {
    value: "space",
    label: "空间",
    icon: House,
    description: "登记客厅、卧室等需要独立引用的位置。",
  },
  {
    value: "passage",
    label: "通道",
    icon: DoorOpen,
    description: "选择两个空间，记录它们之间的门或开放入口。",
  },
  {
    value: "binding",
    label: "观测绑定",
    icon: ScanEye,
    description: "关联设备和观察目标，说明覆盖范围、方向与限制。",
  },
] as const;
export default function SpacesPage() {
  const epoch = useAtomValue(householdScopeEpochAtom) ?? "local";
  return <SpacesQuery key={epoch} scope={epoch} />;
}
function SpacesQuery({ scope }: { scope: string }) {
  const query = useQuery(spatialQueryOptions(scope));
  async function refresh() {
    await query.refetch({ throwOnError: true });
  }
  return (
    <>
      {query.isPending ? (
        <Skeleton className="h-52 rounded-2xl" aria-label="正在读取空间资料" />
      ) : null}
      {query.isError ? (
        <Notice tone="error">
          {requestErrorMessage(query.error)}
          <Button
            onClick={() => {
              refresh().catch((error: unknown) => {
                console.error("Spatial read failed", error);
              });
            }}
          >
            重试
          </Button>
        </Notice>
      ) : null}
      {query.data ? (
        <SpatialWorkspace
          key={JSON.stringify(query.data.scope)}
          scope={scope}
          snapshot={query.data}
          refresh={refresh}
        />
      ) : null}
    </>
  );
}
function SpatialWorkspace({
  scope,
  snapshot,
  refresh,
}: {
  scope: string;
  snapshot: SpatialSnapshot;
  refresh: () => Promise<void>;
}) {
  const household = useAtomValue(householdSnapshotAtom);
  const reliable = useAtomValue(householdReliableAtom);
  const inventory = household?.projection.device;
  const canSelectSource =
    reliable && household?.projection.household.household.status === "running";
  const devices = useMemo(
    () => (canSelectSource && inventory ? Object.values(inventory) : []),
    [canSelectSource, inventory],
  );
  const labels = useMemo(
    () => createSpatialLabels(snapshot, devices),
    [snapshot, devices],
  );
  const [area, setArea] = useState<Editor["resource"]>("space");
  const [editing, setEditing] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<Deletion | null>(null);
  const [conflict, setConflict] = useState<Extract<
    ReturnType<typeof spatialDeleteResultSchema.parse>,
    { status: "referenced" }
  > | null>(null);
  const [reloadError, setReloadError] = useState<unknown>(null);
  const commands = useSpatialCommands(scope, (result) => {
    setEditing(null);
    setDeleting(null);
    setConflict(result.status === "referenced" ? result : null);
  });
  function edit(value: Editor) {
    if (commands.pending) return;
    setArea(value.resource);
    setEditing(value);
    setConflict(null);
    commands.reset();
  }
  function add() {
    if (area === "space") edit({ resource: "space", record: null });
    else if (area === "passage") edit({ resource: "passage", record: null });
    else edit({ resource: "binding", record: null });
  }
  async function reload() {
    setReloadError(null);
    try {
      await refresh();
      setEditing(null);
      setDeleting(null);
      commands.reset();
    } catch (error) {
      setReloadError(error);
    }
  }
  const empty =
    (area === "space"
      ? snapshot.spaces
      : area === "passage"
        ? snapshot.passages
        : snapshot.observation_bindings
    ).length === 0;
  const currentArea = areas.find((item) => item.value === area)!;
  const AreaIcon = currentArea.icon;
  const feedback = (
    <>
      {commands.error ? (
        <Notice tone="error">{requestErrorMessage(commands.error)}</Notice>
      ) : null}
      {commands.message ? (
        <Notice tone="warning">
          {commands.message}
          {commands.unconfirmed ? (
            <Button
              disabled={commands.checking}
              onClick={() => {
                commands.confirm().catch((error: unknown) => {
                  setReloadError(error);
                });
              }}
            >
              读取确认
            </Button>
          ) : null}
          {commands.blocked ? (
            <Button
              onClick={() => {
                reload().catch((error: unknown) => {
                  setReloadError(error);
                });
              }}
            >
              放弃草稿并读取最新资料
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {reloadError ? (
        <Notice tone="error">{requestErrorMessage(reloadError)}</Notice>
      ) : null}
    </>
  );
  return (
    <>
      <PageHeaderContent slot="details">
        <span className="text-xs text-muted">
          {snapshot.spaces.length} 个空间 · {snapshot.passages.length} 条通道 ·{" "}
          {snapshot.observation_bindings.length} 条绑定
        </span>
      </PageHeaderContent>
      <div className="mb-5 border-b border-line">
        <SegmentedControl
          value={area}
          onValueChange={(value) => {
            setArea(value);
            setConflict(null);
          }}
          options={areas}
          label="空间资料"
          variant="underline"
          disabled={commands.pending || !!editing}
        />
      </div>
      {!editing && !empty ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">{currentArea.description}</span>
          <Button
            style={{ width: 144 }}
            icon={<Plus size={14} />}
            disabled={commands.pending}
            onClick={add}
          >
            添加{currentArea.label}
          </Button>
        </div>
      ) : null}
      {!deleting ? feedback : null}
      {area === "binding" && !devices.length ? (
        <Notice>设备清单就绪后可选择新来源，已有绑定仍可维护。</Notice>
      ) : null}
      {conflict ? (
        <ReferenceConflict
          pending={commands.pending}
          conflict={conflict}
          labels={labels}
          onEdit={edit}
        />
      ) : null}
      {editing ? (
        <SpatialEditor
          key={`${editing.resource}:${editing.record?.id ?? "new"}`}
          editor={editing}
          snapshot={snapshot}
          devices={devices}
          pending={commands.pending}
          onCancel={() => {
            setEditing(null);
            commands.reset();
          }}
          onSave={(command) => commands.submit({ ...command, action: "save" })}
        />
      ) : null}
      {empty && !editing ? (
        <EmptyState
          surface="plain"
          layout="stable"
          className="min-h-[55svh] max-[601px]:[&_p]:min-h-21"
          icon={<AreaIcon size={24} />}
          title={`添加第一${area === "space" ? "个空间" : area === "passage" ? "条通道" : "条观测绑定"}`}
          description={currentArea.description}
        >
          <Button
            style={{ width: 144 }}
            variant="primary"
            icon={<Plus size={14} />}
            disabled={commands.pending}
            onClick={add}
          >
            添加{currentArea.label}
          </Button>
        </EmptyState>
      ) : null}
      {!editing && !empty ? (
        <SpatialLists
          area={area}
          snapshot={snapshot}
          pending={commands.pending}
          labels={labels}
          onEdit={edit}
          onToggle={commands.submit}
          onDelete={(value) => {
            commands.reset();
            setConflict(null);
            setDeleting(value);
          }}
        />
      ) : null}
      <DeleteDialog
        deleting={deleting}
        pending={commands.pending}
        onCancel={() => setDeleting(null)}
        onDelete={commands.submit}
        feedback={feedback}
      />
    </>
  );
}
