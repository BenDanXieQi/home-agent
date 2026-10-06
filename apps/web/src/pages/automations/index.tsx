import { useEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Pencil, Plus, Workflow } from "lucide-react";
import type {
  Automation,
  automationDeleteRequestSchema,
  automationSaveRequestSchema,
} from "@home-agent/api/automations";
import {
  automationCapabilitiesOptions,
  automationListOptions,
  deleteAutomation,
  saveAutomation,
} from "../../modules/automations/queries";
import {
  automationReadyAtom,
  automationScopeAtom,
} from "../../modules/automations/state";
import { HouseholdAccess } from "../../modules/household/HouseholdAccess";
import { devicesAtom } from "../../modules/devices/state";
import { RequestError } from "../../api/errors";
import { automationErrorMessage } from "../../modules/automations/messages";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Notice } from "../../components/Notice";
import { PageHeaderContent } from "../../components/PageHeaderContent";
import { AutomationForm } from "./AutomationForm";
import { ExecutionHistory } from "./ExecutionDetails";

function AutomationBrowser({ scope }: { scope: string }) {
  const ready = useAtomValue(automationReadyAtom);
  const store = useStore();
  const client = useQueryClient();
  const query = useQuery({ ...automationListOptions(scope), enabled: ready });
  const capabilities = useQuery({
    ...automationCapabilitiesOptions(scope),
    enabled: ready,
  });
  useEffect(() => {
    if (!ready) return undefined;
    function refreshCapabilities() {
      Promise.all([
        client.invalidateQueries({
          queryKey: automationCapabilitiesOptions(scope).queryKey,
        }),
        client.invalidateQueries({
          queryKey: automationListOptions(scope).queryKey,
        }),
      ]).catch((error: unknown) =>
        console.error("Automation capabilities refresh failed", error),
      );
    }
    const unsubscribe = store.sub(devicesAtom, refreshCapabilities);
    refreshCapabilities();
    return unsubscribe;
  }, [client, ready, scope, store]);
  const [editing, setEditing] = useState<{ initial: Automation | null } | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editSession, setEditSession] = useState(0);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async (
      command:
        | {
            kind: "save";
            input: ReturnType<typeof automationSaveRequestSchema.parse>;
          }
        | {
            kind: "delete";
            input: ReturnType<typeof automationDeleteRequestSchema.parse>;
          },
    ) => {
      if (
        !store.get(automationReadyAtom) ||
        store.get(automationScopeAtom) !== scope
      )
        throw new RequestError({ code: "request_cancelled" });
      if (command.kind === "save") return saveAutomation(command.input);
      await deleteAutomation(command.input);
      return null;
    },
    onSuccess: async (saved) => {
      if (store.get(automationScopeAtom) !== scope) return;
      setEditing(null);
      setDeleteId(null);
      setSelectedId(saved?.id ?? null);
      await client.invalidateQueries({
        queryKey: automationListOptions(scope).queryKey,
      });
      await client.invalidateQueries({ queryKey: ["automation-runs", scope] });
    },
  });
  const automations = query.data?.automations ?? [];

  function openEditor(initial: Automation | null) {
    mutation.reset();
    setEditSession((value) => value + 1);
    setEditing({ initial });
    setDeleteId(null);
  }
  return (
    <>
      <PageHeaderContent slot="details">
        <span className="text-xs text-muted">
          {automations.length} 条规则 ·{" "}
          {automations.filter((item) => item.enabled).length} 条已启用
        </span>
      </PageHeaderContent>
      <PageHeaderContent slot="actions">
        <Button
          size="small"
          icon={<Plus size={14} />}
          disabled={
            !ready || !capabilities.data || !!editing || mutation.isPending
          }
          onClick={() => openEditor(null)}
        >
          新建自动化
        </Button>
      </PageHeaderContent>
      {query.error || capabilities.error ? (
        <Notice tone="error">
          {automationErrorMessage(query.error ?? capabilities.error)}
          <Button
            size="small"
            disabled={!ready}
            onClick={() => {
              Promise.all([query.refetch(), capabilities.refetch()]).catch(
                (error: unknown) =>
                  console.error("Automation refresh failed", error),
              );
            }}
          >
            重试
          </Button>
        </Notice>
      ) : null}
      {!editing && mutation.error ? (
        <Notice tone="error">{automationErrorMessage(mutation.error)}</Notice>
      ) : null}
      {query.isLoading || capabilities.isLoading ? (
        <Notice>正在读取自动化与设备能力…</Notice>
      ) : null}
      {editing && capabilities.data ? (
        <AutomationForm
          key={editSession}
          scope={scope}
          initial={editing.initial}
          capabilities={capabilities.data}
          ready={ready}
          saving={mutation.isPending}
          saveError={mutation.error}
          onSave={(input) => mutation.mutate({ kind: "save", input })}
          onClose={() => {
            setEditing(null);
            mutation.reset();
          }}
        />
      ) : (
        <>
          {!automations.length && query.isSuccess ? (
            <EmptyState
              surface="plain"
              className="min-h-[55svh]"
              icon={<Workflow size={26} />}
              title="让家按你的规则运行"
              description="选择设备条件和动作，或用一句话生成规则树。每个条件可以标为触发或状态。"
            >
              <Button
                variant="primary"
                disabled={!ready || !capabilities.data}
                onClick={() => openEditor(null)}
              >
                创建第一条规则
              </Button>
            </EmptyState>
          ) : null}
          <div
            className={
              automations.length ? "space-y-1 rounded-2xl bg-surface p-2" : ""
            }
          >
            {automations.map((automation) => (
              <article
                key={automation.id}
                className="min-w-0 rounded-xl bg-white p-4 shadow-surface md:p-5"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h2 className="min-w-0 break-words text-sm font-medium">
                    {automation.definition.name}
                  </h2>
                  <span
                    className={`shrink-0 text-[11px] ${automation.readiness === "ready" ? "text-sage" : automation.readiness === "unavailable" ? "text-warning" : "text-muted"}`}
                  >
                    {automation.readiness === "ready"
                      ? "运行中"
                      : automation.readiness === "disabled"
                        ? "已停用"
                        : "暂不可运行"}
                  </span>
                </div>
                {automation.definition.description ? (
                  <p className="mb-4 text-xs leading-6 text-muted">
                    {automation.definition.description}
                  </p>
                ) : null}
                {automation.reasons.length ? (
                  <p className="mb-3 text-xs leading-6 text-warning">
                    {automation.reasons.join("；")}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="small"
                    icon={<Pencil size={13} />}
                    disabled={
                      !ready || mutation.isPending || !capabilities.data
                    }
                    onClick={() => openEditor(automation)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="small"
                    disabled={!ready || mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        kind: "save",
                        input: {
                          scope_epoch: scope,
                          id: automation.id,
                          expected_revision: automation.revision,
                          enabled: !automation.enabled,
                          definition: automation.definition,
                        },
                      })
                    }
                  >
                    {automation.enabled ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    aria-expanded={selectedId === automation.id}
                    icon={
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${selectedId === automation.id ? "rotate-180" : ""}`}
                      />
                    }
                    onClick={() =>
                      setSelectedId(
                        selectedId === automation.id ? null : automation.id,
                      )
                    }
                  >
                    {selectedId === automation.id
                      ? "收起日志"
                      : "触发与条件日志"}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    className="ml-auto"
                    disabled={!ready || mutation.isPending}
                    onClick={() => setDeleteId(automation.id)}
                  >
                    删除
                  </Button>
                </div>
                {deleteId === automation.id ? (
                  <div className="mt-4 rounded-xl bg-danger/5 p-3">
                    <p className="mb-2 text-sm">
                      删除这条自动化并停止后续执行？
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="small"
                        disabled={mutation.isPending}
                        onClick={() => setDeleteId(null)}
                      >
                        取消
                      </Button>
                      <Button
                        size="small"
                        disabled={!ready || mutation.isPending}
                        onClick={() =>
                          mutation.mutate({
                            kind: "delete",
                            input: {
                              scope_epoch: scope,
                              id: automation.id,
                              expected_revision: automation.revision,
                            },
                          })
                        }
                      >
                        确认删除
                      </Button>
                    </div>
                  </div>
                ) : null}
                {selectedId === automation.id && capabilities.data ? (
                  <ExecutionHistory
                    scope={scope}
                    id={automation.id}
                    revision={automation.revision}
                    ready={ready}
                    definition={automation.definition}
                    capabilities={capabilities.data}
                  />
                ) : null}
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default function AutomationsPage() {
  const scope = useAtomValue(automationScopeAtom);
  return (
    <HouseholdAccess fallback={<Notice>正在读取家庭状态…</Notice>}>
      {scope ? (
        <AutomationWorkspace key={scope} scope={scope} />
      ) : (
        <Notice>家庭连接就绪后可管理自动化。</Notice>
      )}
    </HouseholdAccess>
  );
}

function AutomationWorkspace({ scope }: { scope: string }) {
  return <AutomationBrowser scope={scope} />;
}
