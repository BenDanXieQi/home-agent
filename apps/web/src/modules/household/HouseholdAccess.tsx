import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Link } from "@tanstack/react-router";
import { Notice } from "../../components/Notice";
import { RequestFeedback } from "../../components/RequestFeedback";
import { householdAtom, reconnectHouseholdAtom } from "./state";
import { householdSyncMessageAtom } from "./sync";
import { mijiaActionErrorAtom } from "../mijia/commands";

/** Shared household access and synchronization feedback, independent of a route's content. */
export function HouseholdAccess({
  fallback,
  children,
}: {
  fallback: ReactNode;
  children: ReactNode;
}) {
  const household = useAtomValue(householdAtom);
  const syncMessage = useAtomValue(householdSyncMessageAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  const reconnect = useSetAtom(reconnectHouseholdAtom);
  return (
    <>
      {household?.status === "initializing" ? (
        <Notice>
          {household.sync_status === "error"
            ? "家庭初始化失败，请重试。"
            : household.stage === "account"
              ? "正在恢复账号，设备清单尚未同步。"
              : "正在初始化家庭…"}
        </Notice>
      ) : null}
      {household && household.homes.status !== "selected" ? (
        <Notice tone="warning">
          {household.homes.status === "unavailable"
            ? "所选家庭已不可访问。"
            : "尚未选择要接入的家庭。"}
          {household.home_id === null ? (
            <Link to="/settings" className="underline">
              前往设置选择家庭
            </Link>
          ) : (
            "请恢复原账号的家庭访问权限后重试。"
          )}
        </Notice>
      ) : null}
      <RequestFeedback
        syncMessage={syncMessage}
        error={actionError}
        refresh={reconnect}
      />
      {!household
        ? fallback
        : household.homes.status === "selected"
          ? children
          : null}
    </>
  );
}
