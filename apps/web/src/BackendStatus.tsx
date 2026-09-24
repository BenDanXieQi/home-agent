import { useEffect, useState } from "react";
import { healthSchema } from "@home-agent/contracts";

export function BackendStatus() {
  const [status, setStatus] = useState("正在连接 backend…");

  useEffect(() => {
    const controller = new AbortController();
    async function checkHealth() {
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = healthSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setStatus(
            `Backend 已连接 · ${health.runtime} · ${new Date(health.timestamp).toLocaleTimeString()}`,
          );
        }
      } catch {
        if (!controller.signal.aborted) {
          setStatus("Backend 未连接，请确认后端已启动。");
        }
      }
    }
    void checkHealth();
    return () => controller.abort();
  }, []);

  return (
    <div className="backend-status">
      <output>{status}</output>
    </div>
  );
}
