import { mijiaAutomaticLoginBlockedAtom, performMijiaAtom } from "./commands";
import { atom } from "jotai";
import { queryOptions } from "@tanstack/react-query";
import { atomWithQuery } from "jotai-tanstack-query";
import {
  mijiaLoginAttemptAtom,
  mijiaAccountAtom,
  mijiaActiveLoginIdAtom,
} from "./account";
import { mediaBindingAtom } from "../playback/state";
import { mijiaPendingCommandAtom, mijiaActionErrorAtom } from "./commands";
import {
  householdSyncMessageAtom,
  householdSyncStatusAtom,
} from "../household/sync";
import { deviceCountAtom } from "../devices/state";
import { getLoginMaterial } from "./api";

export const loginMaterialQueryAtom = atomWithQuery((get) => {
  const login = get(mijiaLoginAttemptAtom);
  return queryOptions({
    queryKey: ["mijia-login-material", login?.id, login?.material_version],
    enabled:
      !!login?.id && ["pending", "security_required"].includes(login.status),
    queryFn: ({ signal }) => getLoginMaterial(login!.id!, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
});

export const loginViewAtom = atom((get) => {
  const activeLoginId = get(mijiaActiveLoginIdAtom);
  const account = get(mijiaAccountAtom);
  const binding = get(mediaBindingAtom);
  const publicLogin = get(mijiaLoginAttemptAtom);
  const material = get(loginMaterialQueryAtom);
  const currentMaterial =
    material.data?.id === publicLogin?.id &&
    material.data?.material_version === publicLogin?.material_version
      ? material.data
      : undefined;
  const login = publicLogin
    ? {
        ...publicLogin,
        id: publicLogin.id ?? "",
        qrImageUrl: currentMaterial?.qr_image_url ?? "",
        verificationUrl: currentMaterial?.verification_url ?? "",
        expiresAt: currentMaterial?.expires_at ?? "",
      }
    : undefined;
  const command = get(mijiaPendingCommandAtom);
  const syncMessage = get(householdSyncMessageAtom);
  const actionError = get(mijiaActionErrorAtom);
  const deviceCount = get(deviceCountAtom);
  const loginError = login && "error" in login ? login.error?.message : null;
  const cleanupError =
    account?.status === "idle" && binding?.status === "error"
      ? binding.error.message
      : null;
  return {
    login,
    account,
    cleanupPending: cleanupError !== null,
    activeLoginId,
    working: command !== null,
    loggingOut: command === "logout",
    startingLogin: command === "startLogin",
    cancellingLogin: command === "cancelLogin",
    verifyingLogin: command === "verifyLogin",
    canInterrupt: command === null || command === "verifyLogin",
    busy:
      command !== null ||
      login?.status === "creating" ||
      login?.status === "completing" ||
      account?.status === "restoring",
    syncMessage,
    syncStatus: get(householdSyncStatusAtom),
    error:
      actionError ??
      (material.isError ? "登录材料读取失败，请重试。" : null) ??
      loginError ??
      (account && "error" in account ? account.error.message : null) ??
      cleanupError,
    deviceCount,
    materialLoading: material.isLoading,
  };
});

export const mijiaAccountLabelAtom = atom((get) => {
  if (get(householdSyncStatusAtom) !== "synced") return "状态不可用";
  switch (get(mijiaAccountAtom)?.status) {
    case "authenticated":
      return "已登录";
    case "restoring":
      return "正在恢复";
    case "restore_error":
      return "恢复失败";
    case "reauth_required":
      return "需要重新登录";
    default:
      return "未登录";
  }
});
export const mijiaCanStartLoginAutomaticallyAtom = atom((get) => {
  const account = get(mijiaAccountAtom);
  const attempt = get(mijiaLoginAttemptAtom);
  return (
    !!account &&
    !!attempt &&
    get(householdSyncStatusAtom) === "synced" &&
    !get(mijiaAutomaticLoginBlockedAtom) &&
    (account.status === "idle" || account.status === "reauth_required") &&
    get(mediaBindingAtom)?.status !== "error" &&
    (attempt.status === "idle" || attempt.status === "expired")
  );
});
export const startMijiaLoginAutomaticallyAtom = atom(null, async (get, set) => {
  // Recheck shared state at dispatch: StrictMode or another mounted consumer
  // must not replace the attempt that the first caller has already started.
  if (!get(mijiaCanStartLoginAutomaticallyAtom)) return;
  await set(performMijiaAtom, { type: "startLogin" });
});
