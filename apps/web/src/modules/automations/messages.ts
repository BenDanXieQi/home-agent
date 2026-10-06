import { RequestError } from "../../api/errors";
import { requestErrorMessage } from "../../messages/zh-CN";
import type { z } from "zod";

const validationMessages: Record<string, string> = {
  name: "请填写名称，并控制在长度限制内。",
  description: "说明不能超过 2000 个字。",
  tree: "请完整配置每个条件；条件组不能为空。",
  actions: "请配置 1—16 个动作，并填写有效的动作参数。",
  value: "请填写与设备属性类型一致的值。",
  device_id: "请选择当前家庭中的有效设备。",
  property_key: "请选择有效的设备属性。",
  operator: "请选择属性支持的比较方式。",
  duration_seconds: "持续时间须为 1—604800 秒的整数。",
  cooldown_seconds: "执行间隔须为 0—604800 秒的整数。",
  action_ttl_seconds: "动作有效期须为 1—3600 秒的整数。",
  decision: "请填写 Agent 的动作决策目标，最多 4000 个字。",
  goal: "请填写判断目标，最多 4000 个字。",
  property_refs: "请选择 1—50 个设备属性。",
  interval_seconds: "检查间隔须在 5 分钟至 24 小时之间。",
  max_calls_per_day: "24 小时模型调用上限须为 1—48 次的整数。",
  result_ttl_seconds: "判断有效期须在 1 分钟至 24 小时之间。",
  start: "请填写有效的开始时间。",
  end: "请填写有效的结束时间。",
  time_zone: "请填写有效的时区，例如 Asia/Shanghai。",
  weekdays: "请至少选择一个生效日。",
};

export function automationValidationMessages(error: z.ZodError) {
  return [
    ...new Set(
      error.issues.map((issue) =>
        issue.code === "custom"
          ? issue.message
          : (validationMessages[String(issue.path[0])] ??
            "配置未填写完整，请检查条件和动作。"),
      ),
    ),
  ];
}

export function automationErrorMessage(error: unknown) {
  if (
    error instanceof RequestError &&
    "params" in error.details &&
    typeof error.details.params?.reason === "string"
  ) {
    return error.details.params.reason;
  }
  return requestErrorMessage(error);
}
