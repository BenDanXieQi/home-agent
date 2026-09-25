import { lazy, Suspense, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import App from "../../App";
import { accountDialogOpenAtom } from "../../state/ui";
import {
  mijiaAccountAtom,
  mijiaAuthenticatedAtom,
  mijiaFetchErrorAtom,
  mijiaLoginAttemptAtom,
} from "./state";

const LoginPage = lazy(() => import("../../pages/LoginPage"));
function AccountLoading() {
  return (
    <main className="login-screen">
      <output>正在读取账号状态…</output>
    </main>
  );
}

/** Shared route UI gate. Preserve the requested URL throughout account recovery. */
export function AccountGate() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const account = useAtomValue(mijiaAccountAtom);
  const signedIn = useAtomValue(mijiaAuthenticatedAtom);
  const login = useAtomValue(mijiaLoginAttemptAtom);
  const fetchError = useAtomValue(mijiaFetchErrorAtom);
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
      document.title = "登录米家 · Home Agent";
    }
  }, [login, signedIn, path, navigate, closeLogin]);
  if (!account && !fetchError) return <AccountLoading />;
  if (!signedIn)
    return (
      <Suspense fallback={<AccountLoading />}>
        <LoginPage />
      </Suspense>
    );
  return <App />;
}
