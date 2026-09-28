import { loginMaterialQueryAtom, loginViewAtom } from "./login";
import { useAtomValue, useSetAtom } from "jotai";
import { performMijiaAtom } from "./commands";
import { reconnectHouseholdAtom } from "../household/state";

export function useLogin() {
  const view = useAtomValue(loginViewAtom);
  const material = useAtomValue(loginMaterialQueryAtom);
  const perform = useSetAtom(performMijiaAtom);
  const refresh = useSetAtom(reconnectHouseholdAtom);
  return {
    ...view,
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
