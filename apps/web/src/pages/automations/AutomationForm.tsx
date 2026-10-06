import { useCallback, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useStore } from "jotai";
import { Sparkles } from "lucide-react";
import { z } from "zod";
import {
  automationDefinitionSchema,
  type Automation,
  type AutomationAction,
  type AutomationCapabilities,
  type AutomationDefinition,
  type automationSaveRequestSchema,
} from "@home-agent/api/automations";
import {
  newQuery,
  nodeToQuery,
  queryToNode,
} from "../../modules/automations/editor";
import {
  evaluateAutomation,
  generateAutomation,
} from "../../modules/automations/queries";
import {
  automationReadyAtom,
  automationScopeAtom,
} from "../../modules/automations/state";
import { RequestError } from "../../api/errors";
import {
  automationErrorMessage,
  automationValidationMessages,
} from "../../modules/automations/messages";
import { Button } from "../../components/Button";
import { LeaveDialog } from "../../components/LeaveDialog";
import { Notice } from "../../components/Notice";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { RuleTreeEditor } from "./RuleTreeEditor";
import { ActionsEditor } from "./ActionsEditor";
import { EvaluationDetails } from "./ExecutionDetails";

export function AutomationForm({
  scope,
  initial,
  capabilities,
  ready,
  saving,
  saveError,
  onSave,
  onClose,
}: {
  scope: string;
  initial: Automation | null;
  capabilities: AutomationCapabilities;
  ready: boolean;
  saving: boolean;
  saveError: unknown;
  onSave: (input: ReturnType<typeof automationSaveRequestSchema.parse>) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const [id] = useState(() => initial?.id ?? crypto.randomUUID());
  const [name, setName] = useState(initial?.definition.name ?? "");
  const [description, setDescription] = useState(
    initial?.definition.description ?? "",
  );
  const [query, setQuery] = useState(() =>
    initial ? nodeToQuery(initial.definition.tree) : newQuery(capabilities),
  );
  const [actions, setActions] = useState<AutomationAction[]>(
    initial?.definition.actions ?? [],
  );
  const [decision, setDecision] = useState(!!initial?.definition.decision);
  const [decisionGoal, setDecisionGoal] = useState(
    initial?.definition.decision?.goal ?? "",
  );

  const [cooldown, setCooldown] = useState(
    initial?.definition.cooldown_seconds ?? 0,
  );
  const [ttl, setTtl] = useState(initial?.definition.action_ttl_seconds ?? 60);
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [prompt, setPrompt] = useState("");
  const [behavior, setBehavior] = useState("");
  const [clarifications, setClarifications] = useState<string[]>([]);
  const [clarificationContext, setClarificationContext] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [validation, setValidation] = useState<string[]>([]);
  function currentDefinition() {
    return automationDefinitionSchema.parse({
      name,
      description,
      tree: queryToNode(query),
      actions,
      cooldown_seconds: cooldown,
      action_ttl_seconds: ttl,
      ...(decision ? { decision: { goal: decisionGoal } } : {}),
    });
  }
  function checkScope() {
    if (
      !store.get(automationReadyAtom) ||
      store.get(automationScopeAtom) !== scope
    )
      throw new RequestError({ code: "request_cancelled" });
  }
  function applyDefinition(definition: AutomationDefinition) {
    setName(definition.name);
    setDescription(definition.description);
    setQuery(nodeToQuery(definition.tree));
    setActions(definition.actions);
    setDecision(!!definition.decision);
    setDecisionGoal(definition.decision?.goal ?? "");
    setCooldown(definition.cooldown_seconds);
    setTtl(definition.action_ttl_seconds);
    setEnabled(false);
    setValidation([]);
    setDirty(true);
  }
  const generation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      checkScope();
      let definition: AutomationDefinition | undefined;
      try {
        definition = currentDefinition();
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
      }
      const text = clarificationContext
        ? `${clarificationContext}\n用户补充：${prompt}`
        : prompt;
      const draft = await generateAutomation({
        scope_epoch: scope,
        text,
        ...(definition ? { definition } : {}),
      });
      return {
        ...draft,
        requestText: text,
        submittedPrompt: prompt,
        followUp: !!clarificationContext,
      };
    },
    onSuccess: (draft) => {
      if (store.get(automationScopeAtom) !== scope) return;
      if (draft.definition) applyDefinition(draft.definition);
      setBehavior(draft.behavior);
      setClarifications(draft.clarifications);
      setConfirmed(false);
      setClarificationContext(
        draft.clarifications.length
          ? `${draft.requestText}\n待确认：${draft.clarifications.join("；")}`.slice(
              0,
              2900,
            )
          : "",
      );
      if (draft.clarifications.length) setPrompt("");
    },
  });
  const evaluation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      checkScope();
      const definition = currentDefinition();
      return {
        definition,
        evaluation: await evaluateAutomation({
          scope_epoch: scope,
          definition,
        }),
      };
    },
  });
  const busy = saving || generation.isPending;
  const shouldBlock = useCallback(() => dirty || busy, [dirty, busy]);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    withResolver: true,
    enableBeforeUnload: dirty || busy,
  });
  function changed() {
    setDirty(true);
    setValidation([]);
    evaluation.reset();
  }
  function save() {
    setValidation([]);
    try {
      checkScope();
      if (enabled && clarifications.length && !confirmed) {
        setValidation(["请先确认生成结果中的待确认事项，或保存为停用状态。"]);
        return;
      }
      onSave({
        scope_epoch: scope,
        id,
        expected_revision: initial?.revision ?? 0,
        enabled,
        definition: currentDefinition(),
      });
    } catch (error) {
      setValidation(
        error instanceof z.ZodError
          ? automationValidationMessages(error)
          : [automationErrorMessage(error)],
      );
    }
  }
  return (
    <section className="automation-form mx-auto w-full max-w-5xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-medium tracking-tight">
          {initial ? "编辑自动化" : "新建自动化"}
        </h2>
        <Button
          size="small"
          disabled={busy}
          onClick={() => (dirty ? setDiscarding(true) : onClose())}
        >
          取消
        </Button>
      </div>
      <div className="rounded-2xl bg-surface p-2">
        <div className="rounded-xl bg-white p-5 shadow-surface md:p-6">
          <label
            htmlFor="automation-prompt"
            className="text-sm font-medium text-ink"
          >
            用一句话描述，或修改当前规则
          </label>
          <textarea
            id="automation-prompt"
            className="automation-input mt-2 min-h-20 w-full resize-y"
            value={prompt}
            disabled={busy || !ready}
            maxLength={clarificationContext ? 1000 : 4000}
            placeholder={
              clarificationContext
                ? "补充说明，原始需求会一起交给 Agent"
                : "例如：客厅照度低于 50 时，如果灯关闭，就打开灯"
            }
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="mt-2 flex justify-end">
            {clarificationContext ? (
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setClarificationContext("");
                  setClarifications([]);
                  setBehavior("");
                  generation.reset();
                }}
              >
                开始新描述
              </Button>
            ) : null}
            <Button
              icon={<Sparkles size={14} />}
              size="small"
              disabled={!ready || busy || !prompt.trim()}
              status={generation.status}
              onClick={() => generation.mutate()}
            >
              {generation.isPending
                ? "正在生成草稿…"
                : clarificationContext
                  ? "补充并生成"
                  : "生成规则草稿"}
            </Button>
          </div>
          <output className="mt-3 block text-sm leading-6">
            {generation.isPending
              ? "正在根据你的描述生成规则草稿，请稍候。"
              : generation.isSuccess
                ? generation.data.definition
                  ? "草稿已生成并填入下方，请核对后保存。"
                  : generation.data.clarifications.length
                    ? generation.data.followUp
                      ? "补充已处理，仍有事项需要确认，尚未生成规则草稿。"
                      : "需要补充信息，尚未生成规则草稿。"
                    : "本次未生成规则草稿，请重试。"
                : null}
          </output>
          {generation.isSuccess && generation.data.clarifications.length ? (
            <p className="mt-2 whitespace-pre-wrap text-xs text-muted">
              已提交：{generation.data.submittedPrompt}
            </p>
          ) : null}
          {generation.error ? (
            <Notice tone="error" className="mt-3 mb-0">
              {automationErrorMessage(generation.error)}
            </Notice>
          ) : null}
          {!generation.isPending && behavior ? (
            <p className="mt-3 text-sm leading-6">{behavior}</p>
          ) : null}
          {!generation.isPending && clarifications.length ? (
            <div className="mt-3 space-y-2 text-sm text-warning">
              <p>待确认：</p>
              <ul className="list-disc space-y-1 pl-5">
                {clarifications.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对并在规则中明确以上事项
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <fieldset
        disabled={!ready || busy}
        className="min-w-0 rounded-2xl bg-surface p-2"
      >
        <div className="divide-y divide-line/70 rounded-xl bg-white px-5 shadow-surface md:px-6">
          <div className="grid gap-4 py-6 md:grid-cols-2">
            <label className="m-0 space-y-2 text-xs">
              <span>名称</span>
              <input
                className="automation-input block w-full"
                value={name}
                maxLength={128}
                placeholder="例如：夜间自动开灯"
                onChange={(event) => {
                  setName(event.target.value);
                  changed();
                }}
              />
            </label>
            <label className="m-0 space-y-2 text-xs">
              <span>说明</span>
              <input
                className="automation-input block w-full"
                value={description}
                maxLength={2000}
                onChange={(event) => {
                  setDescription(event.target.value);
                  changed();
                }}
              />
            </label>
          </div>
          <div className="py-6">
            <h3 className="mb-2 text-sm font-medium">满足这些条件</h3>
            <p className="mb-3 text-xs leading-6 text-muted">
              触发条件决定何时评估，状态条件只检查是否允许执行。任一满足组只接受来自已满足分支的触发。
            </p>
            <RuleTreeEditor
              capabilities={capabilities}
              eventLabels={{}}
              query={query}
              disabled={!ready || busy}
              onChange={(next) => {
                setQuery(next);
                changed();
              }}
            />
          </div>
          <div className="py-6">
            <h3 className="mb-3 text-sm font-medium">执行方式</h3>
            <Select
              className="mb-4 w-full sm:w-72"
              label="动作执行方式"
              value={decision ? "agent" : "fixed"}
              disabled={!ready || busy}
              onValueChange={(value) => {
                setDecision(value === "agent");
                changed();
              }}
              options={[
                { value: "fixed", label: "按固定动作执行" },
                { value: "agent", label: "让 Agent 从这些动作中选择" },
              ]}
            />
            {decision ? (
              <div className="mb-4 space-y-2">
                <label className="block text-sm">
                  决策目标
                  <textarea
                    className="automation-input mt-2 min-h-20 w-full resize-y"
                    value={decisionGoal}
                    maxLength={4000}
                    placeholder="说明在什么情况下选择哪些动作"
                    onChange={(event) => {
                      setDecisionGoal(event.target.value);
                      changed();
                    }}
                  />
                </label>
                <p className="text-xs leading-6 text-muted">
                  Agent
                  可从下面的动作中选择，也可决定不执行；设备、参数和消息内容沿用你的配置。
                </p>
              </div>
            ) : null}
            <h3 className="mb-3 text-sm font-medium">
              {decision ? "可选择的动作" : "执行动作"}
            </h3>
            <ActionsEditor
              actions={actions}
              onChange={(next) => {
                setActions(next);
                changed();
              }}
              capabilities={capabilities}
              disabled={!ready || busy}
            />
          </div>
          <div className="flex flex-wrap items-end gap-5 py-6">
            <label className="space-y-2 text-xs text-muted">
              <span className="block">两次执行最短间隔（秒）</span>
              <input
                type="number"
                min={0}
                max={604800}
                className="automation-input w-28"
                value={Number.isFinite(cooldown) ? cooldown : ""}
                onChange={(event) => {
                  setCooldown(event.target.valueAsNumber);
                  changed();
                }}
              />
            </label>
            <label className="space-y-2 text-xs text-muted">
              <span className="block">动作有效期（秒）</span>
              <input
                type="number"
                min={1}
                max={3600}
                className="automation-input w-28"
                value={Number.isFinite(ttl) ? ttl : ""}
                onChange={(event) => {
                  setTtl(event.target.valueAsNumber);
                  changed();
                }}
              />
            </label>
            <Switch
              className="min-h-10 text-xs"
              checked={enabled}
              onCheckedChange={(value) => {
                setEnabled(value);
                changed();
              }}
            >
              保存后启用
            </Switch>
          </div>
        </div>
      </fieldset>
      {validation.length ? (
        <Notice tone="error">
          <ul>
            {validation.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {saveError ? (
        <Notice tone="error">{automationErrorMessage(saveError)}</Notice>
      ) : null}
      {evaluation.error ? (
        <Notice tone="error">
          {evaluation.error instanceof z.ZodError
            ? "请先填写完整的名称、条件与动作。"
            : automationErrorMessage(evaluation.error)}
        </Notice>
      ) : null}
      {evaluation.data ? (
        <div className="rounded-xl bg-surface p-4">
          <h3 className="text-sm font-medium">当前条件检查</h3>
          <p className="mt-1 text-xs text-muted">
            这里只检查当前状态，不发出设备动作；事件条件需要实际事件到达。
          </p>
          <EvaluationDetails
            {...evaluation.data}
            capabilities={capabilities}
            eventLabels={{}}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line/70 pt-5">
        <Button
          disabled={!ready || busy}
          status={evaluation.status}
          onClick={() => evaluation.mutate()}
        >
          检查当前条件
        </Button>
        <Button
          variant="primary"
          disabled={!ready || busy}
          status={saving ? "pending" : "idle"}
          onClick={save}
        >
          {enabled ? "保存并启用" : "保存为停用"}
        </Button>
      </div>
      <LeaveDialog
        open={discarding || blocker.status === "blocked"}
        onCancel={() => {
          setDiscarding(false);
          blocker.reset?.();
        }}
        onLeave={() => {
          if (blocker.status === "blocked") blocker.proceed?.();
          else onClose();
        }}
      />
    </section>
  );
}
