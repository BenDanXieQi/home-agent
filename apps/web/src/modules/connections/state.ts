import { atom } from "jotai";
import { mediaBindingAtom } from "../playback/state";
import { householdSyncStatusAtom } from "../household/sync";
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
import { requestJson } from "../../api/client";
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

export const checkConnectionsAtom = atomWithMutation((get) => ({
  mutationKey: ["check-connections"],
  mutationFn: async () => {
    const client = get(queryClientAtom);
    const results = await Promise.allSettled([
      client.fetchQuery({ ...serviceConfigQueryOptions, staleTime: 0 }),
      client.fetchQuery({ ...serviceStatusQueryOptions, staleTime: 0 }),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  },
}));

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
// Service reachability and account media setup are separate readiness steps.
const readinessStates = {
  checking: {
    ready: false,
    pending: true,
    title: "正在检查服务状态",
    message: "正在检查服务是否可用，请稍候。",
  },
  unknown: {
    ready: false,
    pending: false,
    title: "无法获取连接状态",
    message: "暂时无法检查服务状态，请确认本机后台正在运行。",
  },
  both: {
    ready: false,
    pending: false,
    title: "服务不可用",
    message: "Agent 和摄像头服务不可用，对话与实时预览暂不可用。",
  },
  agent: {
    ready: false,
    pending: false,
    title: "Agent 服务不可用",
    message: "Agent 服务不可用，对话暂不可用。",
  },
  video: {
    ready: false,
    pending: false,
    title: "摄像头服务不可用",
    message: "摄像头服务不可用，暂时无法查看实时画面。",
  },
  installing: {
    ready: false,
    pending: true,
    title: "正在接入米家摄像头",
    message: "服务可用，正在接入米家摄像头，请稍候。",
  },
  unbound: {
    ready: false,
    pending: false,
    title: "米家摄像头尚未接入",
    message: "服务可用，米家摄像头尚未接入。",
  },
  ready: {
    ready: true,
    pending: false,
    title: "连接正常",
    message: "服务可用，米家摄像头已接入。",
  },
};
export const connectionReadinessAtom = atom((get) => {
  const services = get(servicesQueryAtom);
  const binding = get(mediaBindingAtom);
  const syncing = get(householdSyncStatusAtom) !== "synced";
  if (services.isError || syncing) return readinessStates.unknown;
  if (!services.data) return readinessStates.checking;
  const agentReady = services.data.services.agent.status === "connected";
  const videoReady = get(go2rtcConnectedAtom);
  if (!agentReady && !videoReady) return readinessStates.both;
  if (!agentReady) return readinessStates.agent;
  if (!videoReady) return readinessStates.video;
  if (!binding) return readinessStates.checking;
  if (binding.status === "installing") return readinessStates.installing;
  if (binding.status === "error")
    return {
      ready: false,
      pending: false,
      title: "米家摄像头接入失败",
      message: binding.error.message,
    };
  return binding.status === "ready"
    ? readinessStates.ready
    : readinessStates.unbound;
});

/** One presentation source for the navigation mascot and its connection details. */
export const connectionNoticeAtom = atom((get) => {
  const backendOffline = get(backendStatusAtom) === "unavailable";
  const readiness = get(connectionReadinessAtom);
  const pending = readiness.pending;
  return {
    attention: backendOffline || (!readiness.ready && !pending),
    title: backendOffline ? "本机服务未连接" : readiness.title,
    message: backendOffline
      ? "暂时无法连接本机后台，请检查服务是否正在运行。"
      : readiness.message,
  };
});
