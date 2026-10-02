import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { z } from "zod";
import { tracedFetch, withSpan } from "@home-agent/observability";
import { readLimitedJson } from "@home-agent/api/http/read-body";
import { apiErrorSchema } from "@home-agent/api/contracts";
import {
  householdQueryLimits,
  householdQueryScopeSchema,
  householdQueryResultSchema,
  householdOverviewInputSchema,
  householdOverviewResponseSchema,
  devicesQueryInputSchema,
  devicesQueryResponseSchema,
  deviceStateInputSchema,
  deviceStateResponseSchema,
  membersQueryInputSchema,
  membersQueryResponseSchema,
} from "@home-agent/api/household-queries";

export function createHouseholdTools(backendUrl: string) {
  async function query(
    path: string,
    input: object,
    schema: z.ZodType,
    config?: RunnableConfig,
  ) {
    const scope = householdQueryScopeSchema.parse({
      scope_epoch: config?.configurable?.household_scope,
    });
    const signal = AbortSignal.any([
      AbortSignal.timeout(householdQueryLimits.timeoutMs),
      ...(config?.signal ? [config.signal] : []),
    ]);
    return withSpan(
      "household.query",
      { "langsmith.span.kind": "tool", "household.query": path },
      async () => {
        try {
          const response = await tracedFetch(
            new URL(`/api/household/queries/${path}`, backendUrl),
            {
              method: "POST",
              redirect: "error",
              signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...input, ...scope }),
            },
          );
          const body = await readLimitedJson(
            response,
            householdQueryLimits.responseBytes,
            signal,
          );
          if (!response.ok) {
            const error = apiErrorSchema.safeParse(body);
            return JSON.stringify({
              status: "unavailable",
              code: error.success ? error.data.code : "household_query_failed",
              message: "家庭查询失败，不能据此判断设备状态或成员情况。",
            });
          }
          const result = schema.parse(body);
          const returnedScope = householdQueryResultSchema.parse(result);
          if (returnedScope.state_version.scope_epoch !== scope.scope_epoch)
            return JSON.stringify({
              status: "unavailable",
              code: "household_scope_changed",
              message: "家庭范围已经变化，不能使用本次查询结果。",
            });
          return JSON.stringify(result);
        } catch {
          config?.signal?.throwIfAborted();
          // Do not expose transport errors, URLs or arbitrary upstream content to the model.
          return JSON.stringify({
            status: "unavailable",
            code: signal.aborted
              ? "household_query_timeout"
              : "household_query_failed",
            message: "暂时无法获取家庭信息，请勿把查询失败当作没有设备或成员。",
          });
        }
      },
    );
  }
  return [
    tool(
      (input, config) =>
        query("overview", input, householdOverviewResponseSchema, config),
      {
        name: "get_household_overview",
        description:
          "只读查询当前家庭概览：房间 ID 与名称、设备数量、类别代码、人物及宠物数量。房间列表分页，next_offset 非空时还有后续。不能提供人物或宠物位置。",
        schema: householdOverviewInputSchema,
      },
    ),
    tool(
      (input, config) =>
        query("devices", input, devicesQueryResponseSchema, config),
      {
        name: "query_devices",
        description:
          "只读搜索当前家庭设备清单，按名称、别名、型号、类别或房间 ID 筛选。返回设备 ID、房间、类别与在线状态，不含开关等属性值；需要实际状态时继续调用 get_device_state。列表分页，不保证一次返回全部设备。",
        schema: devicesQueryInputSchema,
      },
    ),
    tool(
      (input, config) =>
        query("device-state", input, deviceStateResponseSchema, config),
      {
        name: "get_device_state",
        description:
          "只读查询一个设备最近收到的属性报告，不触发设备读取或控制。保留单位、枚举说明、quality、reason、观测时间和过期时间。只有 valid 是已确认有效值；其他质量不能当作当前事实，未知观测时间不能以收到时间替代。无属性不代表关闭。属性列表分页。",
        schema: deviceStateInputSchema,
      },
    ),
    tool(
      (input, config) =>
        query("members", input, membersQueryResponseSchema, config),
      {
        name: "query_members",
        description:
          "只读查询当前家庭已登记的人物和宠物资料，按 kind 或名字、物种、描述文字筛选。返回资料而非实时位置、活动或身份识别结果；不能据此回答小狗当前在哪里。列表分页。",
        schema: membersQueryInputSchema,
      },
    ),
  ];
}
