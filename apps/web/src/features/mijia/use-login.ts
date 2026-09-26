import { useQuery } from "@tanstack/react-query";
import { getLoginMaterial } from "./api";
import { useAtomValue, useSetAtom } from "jotai";
import {
  mijiaLoginAttemptAtom,
  mijiaAccountAtom,
  mijiaBindingAtom,
  mijiaActiveLoginIdAtom,
  mijiaPendingCommandAtom,
  mijiaFetchErrorAtom,
  mijiaActionErrorAtom,
  mijiaDeviceCountAtom,
  performMijiaAtom,
  refreshMijiaAtom,
} from "./state";

export function useLogin() {
  const activeLoginId = useAtomValue(mijiaActiveLoginIdAtom);
  const account = useAtomValue(mijiaAccountAtom);
  const binding = useAtomValue(mijiaBindingAtom);
  const publicLogin = useAtomValue(mijiaLoginAttemptAtom);
  const material = useQuery({
    queryKey: [
      "mijia-login-material",
      publicLogin?.id,
      publicLogin?.material_version,
    ],
    enabled:
      !!publicLogin?.id &&
      ["pending", "security_required"].includes(publicLogin.status),
    queryFn: ({ signal }) => getLoginMaterial(publicLogin!.id!, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
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
  const command = useAtomValue(mijiaPendingCommandAtom);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const deviceCount = useAtomValue(mijiaDeviceCountAtom);
  const perform = useSetAtom(performMijiaAtom);
  const refresh = useSetAtom(refreshMijiaAtom);
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
    canInterrupt: command === null || command === "verifyLogin",
    busy:
      command !== null ||
      login?.status === "creating" ||
      login?.status === "completing" ||
      account?.status === "restoring",
    fetchError,
    error:
      actionError ??
      (material.isError ? "登录材料读取失败，请重试。" : null) ??
      loginError ??
      (account && "error" in account ? account.error.message : null) ??
      cleanupError,
    deviceCount,
    refresh: () => {
      if (material.isError) void material.refetch();
      refresh();
    },
    startLogin: () => {
      void perform({ type: "startLogin" });
    },
    cancelLogin: (loginId: string) => {
      void perform({ type: "cancelLogin", loginId });
    },
    verifyLogin: (loginId: string, ticket: string) => {
      void perform({ type: "verifyLogin", loginId, ticket });
    },
    logout: () => {
      void perform({ type: "logout" });
    },
  };
}
