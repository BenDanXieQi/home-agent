import { AccountLoading } from "./AccountLoading";
import { lazy, Suspense, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import {
  householdAtom,
  householdConnectionFailedAtom,
} from "../../modules/household/state";
import WorkspaceLayout from "./index";
import { accountDialogOpenAtom } from "./account-dialog-state";
import {
  mijiaAccountAtom,
  mijiaAuthenticatedAtom,
  mijiaLoginAttemptAtom,
} from "../../modules/mijia/account";

const LoginPage = lazy(() => import("../login/index"));
/** Shared route UI gate. Preserve the requested URL throughout account recovery. */
export function AccountGate() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const account = useAtomValue(mijiaAccountAtom);
  const signedIn = useAtomValue(mijiaAuthenticatedAtom);
  const household = useAtomValue(householdAtom);
  const showCache =
    household?.account_id &&
    (account?.status === "restoring" || account?.status === "restore_error");
  const login = useAtomValue(mijiaLoginAttemptAtom);
  const connectionFailed = useAtomValue(householdConnectionFailedAtom);
  const closeLogin = useSetAtom(accountDialogOpenAtom);
  const observedLogin = useRef<string | null>(null);
  useEffect(() => {
    if (login && "id" in login && login.status !== "completed")
      observedLogin.current = login.id;
    if (signedIn && path === "/") {
      const completedHere =
        login?.status === "completed" && login.id === observedLogin.current;
      void navigate({
        to: completedHere ? "/settings" : "/devices",
        replace: true,
      });
    }
    if (!signedIn) {
      closeLogin(false);
      if (account || connectionFailed) document.title = "登录米家 · Home Agent";
    }
  }, [account, connectionFailed, login, signedIn, path, navigate, closeLogin]);
  if (!account && !connectionFailed) return <AccountLoading path={path} />;
  if (!signedIn && !showCache)
    return (
      <Suspense fallback={<AccountLoading path={path} />}>
        <LoginPage />
      </Suspense>
    );
  return <WorkspaceLayout />;
}
