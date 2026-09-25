import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useAtom, useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Minus } from "lucide-react";
import { connectionReadinessAtom, agentOfflineAtom } from "./state";
import { connectionNoticeCollapsedAtom } from "../../state/ui";

function StatusFace() {
  return (
    <span className="connection-face" aria-hidden="true">
      <i />
      <i />
      <b />
    </span>
  );
}

export function ConnectionNotice() {
  const readiness = useAtomValue(connectionReadinessAtom);
  const agentOffline = useAtomValue(agentOfflineAtom);
  const [collapsed, setCollapsed] = useAtom(connectionNoticeCollapsedAtom);
  const reduced = useReducedMotion();
  const title = agentOffline ? "Agent 未连接" : "连接需要检查";
  return (
    <AnimatePresence>
      {!readiness.ready && (
        <m.aside
          className="connection-notice"
          aria-label="服务连接提醒"
          initial={{ opacity: 0, y: reduced ? 0 : 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : 8 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
        >
          {collapsed ? (
            <button
              type="button"
              className="connection-notice-pill"
              onClick={() => setCollapsed(false)}
              aria-expanded={false}
              aria-label={title + "，展开详情"}
            >
              <StatusFace />
              <span>{title}</span>
              <span className="connection-notice-dot" />
            </button>
          ) : (
            <div className="connection-notice-card">
              <div className="connection-notice-top">
                <StatusFace />
                <div>
                  <span className="connection-notice-eyebrow">连接状态</span>
                  <h2>{title}</h2>
                </div>
                <button
                  type="button"
                  className="connection-notice-collapse"
                  aria-label="收起连接提醒"
                  aria-expanded={true}
                  onClick={() => setCollapsed(true)}
                >
                  <Minus size={16} />
                </button>
              </div>
              <output className="connection-notice-message">
                {readiness.message}
              </output>
              <Link to="/settings" className="connection-notice-action">
                检查连接 <ArrowUpRight size={14} />
              </Link>
            </div>
          )}
        </m.aside>
      )}
    </AnimatePresence>
  );
}
