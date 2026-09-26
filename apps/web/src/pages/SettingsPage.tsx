import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleAlert } from "lucide-react";
import {
  mijiaStateAtom,
  mijiaBindingAtom,
  mijiaActionErrorAtom,
} from "../features/mijia/state";
import { connectionReadinessAtom } from "../features/connections/state";
import { ServiceConnections } from "../features/connections/ServiceConnections";
import { RequestFeedback } from "../components/RequestFeedback";
import { RetryConnectionButton } from "../features/mijia/RetryConnectionButton";

import { HomeSelection } from "../features/mijia/HomeSelection";

export default function SettingsPage() {
  const { ready, message } = useAtomValue(connectionReadinessAtom);
  const homeSelected =
    useAtomValue(mijiaStateAtom)?.homes.status === "selected";
  const binding = useAtomValue(mijiaBindingAtom);
  const actionError = useAtomValue(mijiaActionErrorAtom);
  return (
    <>
      <div className={`connection-summary ${ready ? "ready" : ""}`}>
        {ready ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
        <div>
          <h2>
            {ready
              ? "服务连接正常"
              : !binding
                ? "正在检查服务连接"
                : "需要检查服务连接"}
          </h2>
          <p>{ready ? "服务已就绪。" : message}</p>
        </div>
        <Link to="/cameras" className="button button-secondary">
          {ready ? "查看摄像头" : "稍后处理"}
        </Link>
      </div>
      <HomeSelection />
      <ServiceConnections />
      <section className="binding-connection">
        <div>
          <h2>米家摄像头接入</h2>
          <p>
            {binding?.status === "ready"
              ? homeSelected
                ? "已连接，摄像头可尝试播放。"
                : "服务已连接，选择家庭后可接入摄像头。"
              : binding?.status === "installing"
                ? "正在连接…"
                : binding?.status === "error"
                  ? binding.error.message
                  : "尚未连接摄像头服务。"}
          </p>
        </div>
        {binding?.status !== "ready" ? (
          <RetryConnectionButton />
        ) : (
          <CircleCheck size={17} className="text-sage" />
        )}
      </section>
      <RequestFeedback error={actionError} />
    </>
  );
}
