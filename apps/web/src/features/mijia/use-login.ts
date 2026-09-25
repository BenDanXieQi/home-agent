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
  const login = useAtomValue(mijiaLoginAttemptAtom);
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
      loginError ??
      (account && "error" in account ? account.error.message : null) ??
      cleanupError,
    deviceCount,
    refresh: () => {
      void refresh();
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
