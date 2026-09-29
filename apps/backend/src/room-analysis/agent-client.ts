import {
  analysisResponseSchema,
  roomAnalysisLimits,
  type analysisRequestSchema,
} from "@home-agent/api/room-analysis";
import { apiErrorSchema } from "@home-agent/api/contracts";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { tracedFetch } from "@home-agent/observability";
import type { z } from "zod";

class AnalysisServiceError extends Error {}

export function createRoomAnalysisClient(readAgentUrl: () => Promise<string>) {
  return async (
    input: z.infer<typeof analysisRequestSchema>,
    signal: AbortSignal,
  ) => {
    try {
      const url = await readAgentUrl();
      signal.throwIfAborted();
      const response = await tracedFetch(new URL("/api/room-analysis", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal,
      });
      const body = await readLimitedJson(
        response,
        roomAnalysisLimits.responseBytes,
        signal,
      );
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(body);
        if (error.success && error.data.code === "model_not_configured")
          throw new AnalysisServiceError(
            "Agent 尚未配置模型：请在本地 .env 设置 AGENT_MODEL、OPENAI_API_KEY，按需设置 OPENAI_BASE_URL，然后重启 Agent。设备上下文已准备好。",
          );
        if (error.success && error.data.code === "thread_busy")
          throw new AnalysisServiceError("Agent 正忙，请稍后手动重试。");
        throw new AnalysisServiceError(
          "Agent 未能生成符合展示规则的总结，请检查模型服务或稍后重试。",
        );
      }
      const parsed = analysisResponseSchema.safeParse(body);
      if (!parsed.success)
        throw new AnalysisServiceError("AI 返回的数据格式无效，结果未采纳。");
      return parsed.data;
    } catch (error) {
      if (signal.aborted)
        throw new AnalysisServiceError(
          "房间分析已取消或超过 90 秒，请稍后重试。",
          { cause: error },
        );
      // Provider/transport messages can contain credentials; only expose our own messages.
      if (error instanceof AnalysisServiceError) throw error;
      throw new AnalysisServiceError(
        "暂时无法连接 Agent，或返回内容超过分析上限，请检查服务后重试。",
        { cause: error },
      );
    }
  };
}
