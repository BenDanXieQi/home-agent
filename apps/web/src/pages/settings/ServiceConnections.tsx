import { Notice } from "../../components/Notice";
import { twMerge } from "tailwind-merge";
import { LeaveDialog } from "../../components/LeaveDialog";
import { useCallback } from "react";
import { Disclosure } from "../../components/Disclosure";
import { AnimatePresence, m } from "motion/react";
import { Button } from "../../components/Button";
import { expand } from "../../utils/motion";
import { useForm, useWatch } from "react-hook-form";
import { useAtomValue } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  checkConnectionsAtom,
  configurationQueryAtom,
  servicesQueryAtom,
  saveConfigurationAtom,
} from "../../modules/connections/state";
import { useBlocker } from "@tanstack/react-router";
import {
  serviceConfigurationSchema,
  type ServiceConfiguration,
  type ServiceStatus,
} from "@home-agent/api/contracts";
import {
  errorMessage,
  issueMessage,
  connectionMessage,
} from "../../messages/zh-CN";
import { describeError } from "../../messages/zh-CN";
const emptyConfiguration: ServiceConfiguration = {
  services: { agent: { url: "" }, go2rtc: { url: "" } },
};
const serviceNames = ["agent", "go2rtc"] as const;
const serviceLabels = {
  agent: "Agent",
  go2rtc: "摄像头服务（go2rtc）",
};

function ConnectionStatus({
  service,
  unavailable,
  refreshing,
}: {
  service: ServiceStatus | undefined;
  unavailable: boolean;
  refreshing: boolean;
}) {
  const state = unavailable ? "unknown" : (service?.status ?? "unknown");
  const label =
    state === "connected"
      ? "服务可用"
      : state === "unavailable"
        ? "无法连接"
        : refreshing
          ? "正在检查"
          : "等待检查";

  return (
    <div
      className="flex flex-wrap items-center gap-2 max-md:col-start-1"
      title={
        service
          ? `检查于 ${new Date(service.checkedAt).toLocaleTimeString("zh-CN")}`
          : undefined
      }
    >
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] data-[status=connected]:text-sage data-[status=unavailable]:text-danger data-[status=unknown]:text-muted"
        data-status={state}
      >
        <span
          className={twMerge(
            "size-1.5 rounded-full bg-current",
            state === "connected" && "status-ping",
          )}
          aria-hidden="true"
        />
        {label}
      </span>
      {service && !unavailable && state !== "connected" ? (
        <span className="text-xs leading-6 text-muted [&_p_+_p]:text-xs">
          {connectionMessage(service)}
        </span>
      ) : null}
    </div>
  );
}

export function ServiceConnections() {
  const client = useAtomValue(queryClientAtom);
  const configurationQuery = useAtomValue(configurationQueryAtom);
  const statusQuery = useAtomValue(servicesQueryAtom);
  const saveMutation = useAtomValue(saveConfigurationAtom);
  const configuration = configurationQuery.data;
  const form = useForm<ServiceConfiguration>({
    defaultValues: emptyConfiguration,
    values: configuration?.config ?? emptyConfiguration,
    resetOptions: { keepDirtyValues: true },
    mode: "onBlur",
  });
  const {
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    control,
    formState: { isDirty: dirty, dirtyFields, errors },
  } = form;
  const draft = useWatch({ control });
  const statuses = statusQuery.data;
  const configError = configurationQuery.error
    ? describeError(configurationQuery.error)
    : null;
  const statusError = statusQuery.error
    ? errorMessage(describeError(statusQuery.error))
    : null;
  const saving = saveMutation.isPending;
  const refreshing = configurationQuery.isFetching || statusQuery.isFetching;
  const saveError = saveMutation.error
    ? describeError(saveMutation.error)
    : null;
  const savedMessage = saveMutation.isSuccess ? "配置已保存。" : null;
  const shouldBlockNavigation = useCallback(
    () => dirty || saving,
    [dirty, saving],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    withResolver: true,
    enableBeforeUnload: dirty || saving,
  });
  const checkMutation = useAtomValue(checkConnectionsAtom);
  const checkStatus = checkMutation.status;
  function refresh() {
    checkMutation.mutate();
  }
  async function save(value: ServiceConfiguration) {
    if (
      !configuration?.writable ||
      saving ||
      client.isMutating({ mutationKey: ["save-config"] }) ||
      !dirty ||
      configError
    )
      return;
    try {
      const response = await saveMutation.mutateAsync(value);
      reset(response.config);
    } catch (error) {
      const details = describeError(error);
      for (const issue of ("issues" in details ? details.issues : []) ?? []) {
        const name = serviceNames.find(
          (service) => issue.path === `services.${service}.url`,
        );
        if (name)
          setError(
            `services.${name}.url`,
            { type: "server", message: issueMessage(issue) },
            { shouldFocus: true },
          );
      }
    }
  }

  const needsCheck =
    !!configError ||
    !!statusError ||
    serviceNames.some(
      (name) => statuses?.services[name].status === "unavailable",
    );
  const canEdit = !!configuration && !configError && !saving;

  return (
    <section
      className="mb-6 w-full rounded-2xl bg-white p-6 shadow-panel"
      aria-labelledby="connections-title"
    >
      <LeaveDialog
        open={blocker.status === "blocked"}
        onCancel={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-6 [&_p]:text-muted">
        <div>
          <h2 id="connections-title">连接配置</h2>
        </div>
        {needsCheck || checkStatus === "pending" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={refreshing || saving}
            status={checkStatus}
            onClick={() => {
              refresh();
            }}
          >
            {checkStatus === "pending" ? "检查中…" : "重新检查"}
          </Button>
        ) : null}
      </div>

      {configError ? (
        <div
          className="[form_>_&]:mt-4 [form_>_div_>_&]:mt-4 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl px-5 py-4 text-sm leading-6 bg-danger/5 text-danger"
          role="alert"
        >
          <strong className="block w-full font-medium">配置无法使用</strong>
          <p>{errorMessage(configError)}</p>
          {"issues" in configError && configError.issues?.length ? (
            <ul className="w-full">
              {configError.issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <code>{issue.path}</code>：{issueMessage(issue)}
                </li>
              ))}
            </ul>
          ) : null}
          <p>请修复配置文件。页面会自动重试，恢复后即可继续使用。</p>
        </div>
      ) : null}
      {!configError && configuration && !configuration.writable ? (
        <Notice tone="warning">
          配置文件或所在目录只读，当前无法从页面保存。
        </Notice>
      ) : null}

      <form onSubmit={handleSubmit(save)} noValidate>
        <div className="grid gap-6">
          {serviceNames.map((name) => {
            const issue = errors.services?.[name]?.url;
            const checked = statuses?.services[name];
            const currentStatus =
              checked?.url === configuration?.config.services[name].url
                ? checked
                : undefined;
            return (
              <div
                className="grid grid-cols-2 gap-x-8 gap-y-2 py-2 max-md:grid-cols-[1fr]"
                key={name}
              >
                <div className="flex flex-wrap items-center gap-2 [&_h3]:text-base [&_h3]:font-semibold">
                  <h3>{serviceLabels[name]}</h3>
                  <ConnectionStatus
                    service={currentStatus}
                    unavailable={!!configError || !!statusError}
                    refreshing={refreshing}
                  />
                </div>
                <p className="col-start-1 text-[13px] text-muted">
                  {name === "agent"
                    ? "对话与智能任务服务"
                    : "摄像头与音视频连接服务"}
                </p>
                <label
                  className="col-start-2 row-start-1 max-md:col-start-1 max-md:row-auto max-md:mt-5 sr-only"
                  htmlFor={`${name}-url`}
                >
                  服务地址
                </label>
                <input
                  className="col-start-2 row-start-1 row-span-2 self-center font-mono text-[13px] max-md:col-start-1 max-md:row-auto"
                  id={`${name}-url`}
                  aria-label={`${serviceLabels[name]} 服务地址`}
                  type="url"
                  placeholder={
                    name === "agent"
                      ? "http://127.0.0.1:1811"
                      : "http://127.0.0.1:1984"
                  }
                  disabled={!canEdit}
                  readOnly={!configuration?.writable}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!issue}
                  aria-describedby={issue ? `${name}-error` : undefined}
                  title="使用 HTTP(S) 根地址，不包含路径、参数或账号密码。"
                  {...register(`services.${name}.url`, {
                    validate: (value) =>
                      serviceConfigurationSchema.shape.services.shape[
                        name
                      ].shape.url.safeParse(value).success ||
                      "请输入 HTTP(S) 根地址，不包含账号密码、路径或参数。",
                    onChange: () => {
                      clearErrors(`services.${name}.url`);
                      saveMutation.reset();
                    },
                  })}
                />
                {issue ? (
                  <p
                    id={`${name}-error`}
                    className="mt-1 text-xs text-danger col-start-2 max-md:col-start-1 max-md:row-auto"
                  >
                    {issue.message}
                  </p>
                ) : null}

                {dirtyFields.services?.[name]?.url &&
                configuration?.config.services[name].url !==
                  draft?.services?.[name]?.url ? (
                  <p className="col-span-2 mt-2 text-[11px] text-muted max-md:col-start-1">
                    当前生效：{configuration?.config.services[name].url}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {statusError && !configError ? (
          <Notice tone="error">状态检查失败：{statusError}</Notice>
        ) : null}
        {saveError ? (
          <Notice tone="error">保存失败：{errorMessage(saveError)}</Notice>
        ) : null}
        <AnimatePresence>
          {savedMessage ? (
            <m.div className="overflow-hidden" {...expand}>
              <output className="[form_>_&]:mt-4 [form_>_div_>_&]:mt-4 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl px-5 py-4 text-sm leading-6 [&_strong]:block [&_strong]:w-full [&_strong]:font-medium [&_ul]:w-full bg-sage/10 text-sage">
                {savedMessage}
              </output>
            </m.div>
          ) : null}
        </AnimatePresence>

        <div className="mt-6 flex items-center justify-between gap-4 max-md:flex-wrap">
          <p className="text-xs text-muted">
            {dirty
              ? "有未保存的修改，连接状态仍对应当前生效地址。"
              : "连接状态约每 10 秒自动更新。"}
          </p>
          <Button
            type="submit"
            variant="primary"
            feedback="result"
            disabled={!canEdit || !configuration?.writable || !dirty}
            status={
              saving
                ? "pending"
                : saveMutation.isError
                  ? "error"
                  : saveMutation.isSuccess
                    ? "success"
                    : "idle"
            }
          >
            {saving ? "正在保存…" : "保存配置"}
          </Button>
        </div>
      </form>

      <div className="mt-3">
        <Disclosure title="配置说明与文件位置">
          <p id="service-url-help">
            使用 HTTP(S) 根地址，不包含路径、参数或账号密码。
          </p>
          <p>
            已连接仅表示服务接口可用，不代表模型、米家授权或摄像头出流已就绪。
          </p>
          {configuration ? (
            <p>
              配置文件：<code>{configuration.path}</code>
            </p>
          ) : null}
          <p>手动修改文件后，下次请求生效。请错开手动编辑与页面保存。</p>
        </Disclosure>
      </div>
    </section>
  );
}
