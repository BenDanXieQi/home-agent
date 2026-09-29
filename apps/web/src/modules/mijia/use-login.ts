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
      if (material.isError)
        material.refetch().catch((backgroundError: unknown) => {
          console.error("use-login: material.refetch failed", backgroundError);
        });
      refresh();
    },
    startLogin: () => {
      perform({ type: "startLogin" }).catch((backgroundError: unknown) => {
        console.error("use-login: perform failed", backgroundError);
      });
    },
    cancelLogin: (loginId: string) => {
      perform({ type: "cancelLogin", loginId }).catch(
        (backgroundError: unknown) => {
          console.error("use-login: perform failed", backgroundError);
        },
      );
    },
    verifyLogin: (loginId: string, ticket: string) => {
      perform({ type: "verifyLogin", loginId, ticket }).catch(
        (error: unknown) => {
          console.error("use-login: perform failed", error);
        },
      );
    },
    logout: () => {
      perform({ type: "logout" }).catch((backgroundError: unknown) => {
        console.error("use-login: perform failed", backgroundError);
      });
    },
  };
}
