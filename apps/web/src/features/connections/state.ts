import { atom } from "jotai";
import { mijiaBindingAtom, mijiaFetchErrorAtom } from "../mijia/state";
import {
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import {
  configResponseSchema,
  type ServiceConfiguration,
  type ConfigResponse,
} from "@home-agent/api/contracts";
import { requestJson } from "../../lib/api";
import {
  serviceConfigQueryOptions,
  serviceStatusQueryOptions,
  backendHealthQueryOptions,
} from "./queries";

export const saveConfigurationAtom = atomWithMutation<
  ConfigResponse,
  ServiceConfiguration,
  Error
>((get) => {
  const client = get(queryClientAtom);
  return {
    mutationKey: ["save-config"],
    mutationFn: (config: ServiceConfiguration) =>
      requestJson(
        (api, options) => api.api.config.$put({ json: config }, options),
        configResponseSchema,
      ),
    onMutate: async () => {
      await Promise.all([
        client.cancelQueries({ queryKey: serviceConfigQueryOptions.queryKey }),
        client.cancelQueries({ queryKey: serviceStatusQueryOptions.queryKey }),
      ]);
    },
    onSuccess: (response) => {
      client.setQueryData(serviceConfigQueryOptions.queryKey, response);
    },
    onSettled: async () => {
      await Promise.allSettled([
        client.fetchQuery({ ...serviceConfigQueryOptions, staleTime: 0 }),
        client.fetchQuery({ ...serviceStatusQueryOptions, staleTime: 0 }),
      ]);
    },
  };
});
export const configurationQueryAtom = atomWithQuery((get) => ({
  ...serviceConfigQueryOptions,
  enabled: !get(saveConfigurationAtom).isPending,
  refetchInterval: 10_000,
}));
export const servicesQueryAtom = atomWithQuery((get) => ({
  ...serviceStatusQueryOptions,
  enabled: !get(saveConfigurationAtom).isPending,
  refetchInterval: 10_000,
}));
export const healthQueryAtom = atomWithQuery(() => backendHealthQueryOptions);

export const backendStatusAtom = atom((get) => {
  const health = get(healthQueryAtom);
  return health.isError
    ? "unavailable"
    : health.data
      ? "connected"
      : "checking";
});
export const agentOfflineAtom = atom((get) => {
  const services = get(servicesQueryAtom);
  return (
    !services.isError && services.data?.services.agent.status === "unavailable"
  );
});
export const go2rtcConnectedAtom = atom((get) => {
  const services = get(servicesQueryAtom);
  return (
    !services.isError && services.data?.services.go2rtc.status === "connected"
  );
});
const readinessStates = {
  unknown: {
    ready: false,
    message: "暂时无法检查服务状态，请确认本机后台正在运行。",
  },
  both: {
    ready: false,
    message: "Agent 和摄像头服务未连接，对话与实时预览暂不可用。",
  },
  agent: {
    ready: false,
    message: "Agent 未连接，对话服务暂不可用；不影响摄像头预览。",
  },
  video: { ready: false, message: "摄像头服务未连接，暂时无法查看实时画面。" },
  installing: { ready: false, message: "正在连接摄像头服务，请稍候。" },
  ready: { ready: true, message: "服务连接正常。" },
};
export const connectionReadinessAtom = atom((get) => {
  const services = get(servicesQueryAtom);
  const binding = get(mijiaBindingAtom);
  if (!services.data || services.isError || get(mijiaFetchErrorAtom))
    return readinessStates.unknown;
  const agentReady = services.data.services.agent.status === "connected";
  const videoReady = get(go2rtcConnectedAtom) && binding?.status === "ready";
  if (!agentReady && !videoReady) return readinessStates.both;
  if (!agentReady) return readinessStates.agent;
  if (!videoReady)
    return binding?.status === "installing"
      ? readinessStates.installing
      : readinessStates.video;
  return readinessStates.ready;
});
