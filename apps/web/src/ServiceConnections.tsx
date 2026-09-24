import {
  errorMessage,
  issueMessage,
  connectionMessage,
  type DisplayError,
} from "./messages/zh-CN";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  apiErrorSchema,
  configResponseSchema,
  servicesStatusSchema,
  type ConfigResponse,
  type ServiceConfiguration,
  type ServiceStatus,
  type ServicesStatus,
} from "@home-agent/api/contracts";

const serviceNames = ["agent", "go2rtc"] as const;
const serviceLabels = { agent: "Agent", go2rtc: "go2rtc" };

class RequestError extends Error {
  details: DisplayError;

  constructor(details: DisplayError) {
    super(details.code);
    this.details = details;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  schema: { parse: (data: unknown) => T },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(12_000),
      ]),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const details = apiErrorSchema.safeParse(payload);
      throw new RequestError(
        details.success ? details.data : { code: "invalid_response" },
      );
    }
    try {
      return schema.parse(payload);
    } catch {
      throw new RequestError({ code: "invalid_response" });
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof SyntaxError)
      throw new RequestError({ code: "invalid_response" });
    throw new RequestError({
      code:
        error instanceof DOMException && error.name === "TimeoutError"
          ? "request_timeout"
          : "network_error",
    });
  }
}

function describeError(error: unknown): DisplayError {
  return error instanceof RequestError
    ? error.details
    : { code: "network_error" };
}

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
  const [configuration, setConfiguration] = useState<ConfigResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<ServiceConfiguration | null>(null);
  const [statuses, setStatuses] = useState<ServicesStatus | null>(null);
  const [configError, setConfigError] = useState<DisplayError | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<DisplayError | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const refreshController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (savingRef.current) return;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setRefreshing(true);

    const [configResult, statusResult] = await Promise.allSettled([
      requestJson(
        "/api/config",
        { signal: controller.signal },
        configResponseSchema,
      ),
      requestJson(
        "/api/services/status",
        { signal: controller.signal },
        servicesStatusSchema,
      ),
    ]);
    // A save, a newer refresh or unmount invalidates the entire snapshot.
    if (controller.signal.aborted || refreshController.current !== controller)
      return;

    if (configResult.status === "fulfilled") {
      setConfiguration(configResult.value);
      setConfigError(null);
      if (!dirtyRef.current) setDraft(configResult.value.config);
    } else {
      setSavedMessage(null);
      setConfigError(describeError(configResult.reason));
    }
    if (statusResult.status === "fulfilled") {
      setStatuses(statusResult.value);
      setStatusError(null);
    } else {
      setStatuses(null);
      setStatusError(errorMessage(describeError(statusResult.reason)));
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 10_000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      refreshController.current?.abort();
      saveController.current?.abort();
    };
  }, [refresh]);

  function changeAddress(service: (typeof serviceNames)[number], url: string) {
    if (!draft) return;
    const next = { services: { ...draft.services, [service]: { url } } };
    const changed = serviceNames.some(
      (name) =>
        next.services[name].url !== configuration?.config.services[name].url,
    );
    dirtyRef.current = changed;
    setDirty(changed);
    setDraft(next);
    setSaveError(null);
    setSavedMessage(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !configuration?.writable || configError || savingRef.current)
      return;
    savingRef.current = true;
    refreshController.current?.abort();
    setRefreshing(false);
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    setStatuses(null);
    const controller = new AbortController();
    saveController.current = controller;

    try {
      const result = await requestJson(
        "/api/config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
          signal: controller.signal,
        },
        configResponseSchema,
      );
      if (controller.signal.aborted) return;
      setConfiguration(result);
      setDraft(result.config);
      dirtyRef.current = false;
      setDirty(false);
      setConfigError(null);
      setSavedMessage("配置已保存，后续请求使用新地址。");
    } catch (error) {
      if (controller.signal.aborted) return;
      setSaveError(describeError(error));
    } finally {
      savingRef.current = false;
      if (!controller.signal.aborted) {
        setSaving(false);
        void refresh();
      }
    }
  }

  const canEdit = !!configuration && !configError && !saving;

  return (
    <section className="connections-panel" aria-labelledby="connections-title">
      <div className="panel-heading">
        <div>
          <h2 id="connections-title">连接配置</h2>
          <p>使用 HTTP(S) 根地址，不包含路径、参数或账号密码。</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={refreshing || saving}
          onClick={() => void refresh()}
        >
          {refreshing ? "检查中…" : "立即检查"}
        </button>
      </div>

      {configError ? (
        <div className="notice notice-error" role="alert">
          <strong>配置无法使用</strong>
          <p>{errorMessage(configError)}</p>
          {configError.issues?.length ? (
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

      <form onSubmit={(event) => void save(event)} noValidate>
        <div className="service-grid">
          {serviceNames.map((name, index) => {
            const issue = saveError?.issues?.find(
              (item) => item.path === `services.${name}.url`,
            );
            const checked = statuses?.services[name];
            const currentStatus =
              checked?.url === configuration?.config.services[name].url
                ? checked
                : undefined;
            return (
              <div className="service-card" key={name}>
                <div className="service-title">
                  <span className="service-number">0{index + 1}</span>
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
                  name={`${name}-url`}
                  type="url"
                  value={draft?.services[name].url ?? ""}
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
                  onChange={(event) => changeAddress(name, event.target.value)}
                />
                {issue ? (
                  <p id={`${name}-error`} className="field-error">
                    {issueMessage(issue)}
                  </p>
                ) : null}
                <ConnectionStatus
                  service={currentStatus}
                  unavailable={!!configError || !!statusError}
                  refreshing={refreshing}
                />
                {dirty &&
                configuration?.config.services[name].url !==
                  draft?.services[name].url ? (
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
        {savedMessage ? (
          <output className="notice notice-success">{savedMessage}</output>
        ) : null}

        <div className="save-row">
          <p>
            {dirty
              ? "有未保存的修改，连接状态仍对应当前生效地址。"
              : "连接状态约每 10 秒自动更新。"}
          </p>
          <button
            type="submit"
            className="primary-button"
            disabled={!canEdit || !configuration?.writable || !dirty}
          >
            {saving ? "正在保存…" : "保存配置"}
          </button>
        </div>
      </form>

      <div className="configuration-note">
        <p>
          已连接仅表示服务接口可用，不代表模型、米家授权或摄像头出流已就绪。
        </p>
        {configuration ? (
          <p>
            配置文件：<code>{configuration.path}</code>
          </p>
        ) : null}
        <p>手动修改文件后，下次请求生效。请错开手动编辑与页面保存。</p>
      </div>
    </section>
  );
}
