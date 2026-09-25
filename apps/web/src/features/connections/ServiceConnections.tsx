import { LeaveDialog } from "../../components/LeaveDialog";
import { useCallback } from "react";
import { Disclosure } from "../../components/Disclosure";
import { AnimatePresence, m } from "motion/react";
import { Button } from "../../components/Button";
import { useForm, useWatch } from "react-hook-form";
import { useAtomValue } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import {
  configurationQueryAtom,
  servicesQueryAtom,
  saveConfigurationAtom,
} from "./state";
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
import { describeError } from "../../lib/api";
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
      ? "已连接"
      : state === "unavailable"
        ? "无法连接"
        : refreshing
          ? "正在检查"
          : "等待检查";

  return (
    <div className="connection-status">
      <span className={`status-badge status-${state}`}>
        <span className="status-dot" aria-hidden="true" />
        {label}
      </span>
      {service && !unavailable ? (
        <div className="status-detail">
          <p>{connectionMessage(service)}</p>
          <p>
            检查于{" "}
            <time dateTime={service.checkedAt}>
              {new Date(service.checkedAt).toLocaleTimeString("zh-CN")}
            </time>
          </p>
        </div>
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
  function refresh() {
    return Promise.all([configurationQuery.refetch(), statusQuery.refetch()]);
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

  const canEdit = !!configuration && !configError && !saving;

  return (
    <section className="connections-panel" aria-labelledby="connections-title">
      <LeaveDialog
        open={blocker.status === "blocked"}
        onCancel={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
      <div className="panel-heading">
        <div>
          <h2 id="connections-title">连接配置</h2>
          <p>使用 HTTP(S) 根地址，不包含路径、参数或账号密码。</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={refreshing || saving}
          onClick={() => void refresh()}
        >
          {refreshing ? "检查中…" : "立即检查"}
        </Button>
      </div>

      {configError ? (
        <div className="notice notice-error" role="alert">
          <strong>配置无法使用</strong>
          <p>{errorMessage(configError)}</p>
          {"issues" in configError && configError.issues?.length ? (
            <ul>
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
        <div className="notice notice-warning">
          配置文件或所在目录只读，当前无法从页面保存。
        </div>
      ) : null}

      <form onSubmit={handleSubmit(save)} noValidate>
        <div className="service-grid">
          {serviceNames.map((name) => {
            const issue = errors.services?.[name]?.url;
            const checked = statuses?.services[name];
            const currentStatus =
              checked?.url === configuration?.config.services[name].url
                ? checked
                : undefined;
            return (
              <div className="service-card" key={name}>
                <div className="service-title">
                  <h3>{serviceLabels[name]}</h3>
                </div>
                <p className="service-description">
                  {name === "agent"
                    ? "对话与智能任务服务"
                    : "摄像头与音视频连接服务"}
                </p>
                <label htmlFor={`${name}-url`}>服务地址</label>
                <input
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
                  <p id={`${name}-error`} className="field-error">
                    {issue.message}
                  </p>
                ) : null}
                <ConnectionStatus
                  service={currentStatus}
                  unavailable={!!configError || !!statusError}
                  refreshing={refreshing}
                />
                {dirtyFields.services?.[name]?.url &&
                configuration?.config.services[name].url !==
                  draft?.services?.[name]?.url ? (
                  <p className="active-address">
                    当前生效：{configuration?.config.services[name].url}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {statusError && !configError ? (
          <p className="notice notice-error" role="alert">
            状态检查失败：{statusError}
          </p>
        ) : null}
        {saveError ? (
          <p className="notice notice-error" role="alert">
            保存失败：{errorMessage(saveError)}
          </p>
        ) : null}
        <AnimatePresence>
          {savedMessage ? (
            <m.output
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="notice notice-success"
            >
              {savedMessage}
            </m.output>
          ) : null}
        </AnimatePresence>

        <div className="save-row">
          <p>
            {dirty
              ? "有未保存的修改，连接状态仍对应当前生效地址。"
              : "连接状态约每 10 秒自动更新。"}
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={!canEdit || !configuration?.writable || !dirty}
          >
            {saving ? "正在保存…" : "保存配置"}
          </Button>
        </div>
      </form>

      <div className="mt-7">
        <Disclosure title="配置说明与文件位置">
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
