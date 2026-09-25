import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleAlert } from "lucide-react";
import {
  mijiaBindingAtom,
  mijiaActionErrorAtom,
} from "../features/mijia/state";
import { connectionReadinessAtom } from "../features/connections/state";
import { ServiceConnections } from "../features/connections/ServiceConnections";
import { RequestFeedback } from "../components/RequestFeedback";
import { RetryConnectionButton } from "../features/mijia/RetryConnectionButton";

export default function SettingsPage() {
  const { ready, message } = useAtomValue(connectionReadinessAtom);
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
          <p>{ready ? "可以查看设备与摄像头了。" : message}</p>
        </div>
        <Link to="/cameras" className="button button-secondary">
          {ready ? "查看摄像头" : "稍后处理"}
        </Link>
      </div>
      <ServiceConnections />
      <section className="binding-connection">
        <div>
          <h2>米家摄像头接入</h2>
          <p>
            {binding?.status === "ready"
              ? "已连接，摄像头可尝试播放。"
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
