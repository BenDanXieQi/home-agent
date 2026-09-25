import { useAtomValue, useSetAtom } from "jotai";
import {
  mijiaLoginAttemptAtom,
  mijiaAccountAtom,
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
  const login = useAtomValue(mijiaLoginAttemptAtom);
  const command = useAtomValue(mijiaPendingCommandAtom);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const deviceCount = useAtomValue(mijiaDeviceCountAtom);
  const perform = useSetAtom(performMijiaAtom);
  const refresh = useSetAtom(refreshMijiaAtom);
  const loginError = login && "error" in login ? login.error?.message : null;
  return {
    login,
    account,
    activeLoginId,
    working: command !== null,
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
      (account && "error" in account ? account.error.message : null),
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
