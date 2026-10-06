import type {
  ApiError,
  ConnectionReasonCode,
  ErrorCode,
  MessageParams,
  ServiceStatus,
  ValidationIssue,
} from "@home-agent/api/contracts";
import {
  isMijiaErrorCode,
  mijiaFailureMessage,
  type MijiaErrorCode,
} from "@home-agent/api/mijia";

import { RequestError, type ClientErrorCode } from "../api/errors";
export type DisplayError = {
  code: ErrorCode | ClientErrorCode;
  params?: MessageParams | undefined;
  issues?: ValidationIssue[] | undefined;
};

const errorMessages = {
  invalid_request: "请求内容无效，请检查输入。",
  invalid_json: "请求内容必须是有效的 JSON。",
  content_type_required: "请求必须使用 application/json。",
  request_too_large: "请求内容过大，请缩短后重试。",
  local_access_required: "请从本机 backend 或 Vite 页面访问管理接口。",
  not_found: "请求的资源不存在。",
  spatial_record_changed: "这条资料已被修改，请读取最新内容后重新编辑。",
  spatial_scope_changed: "家庭绑定已变化，请重新读取当前家庭的空间资料。",
  spatial_record_exists: "该空间资料已存在，请刷新后编辑。",
  spatial_reference_invalid: "关联的空间或通道不存在，请刷新后重新选择。",
  spatial_source_invalid: "请从当前设备清单选择设备及有效镜头。",
  spatial_storage_unavailable:
    "空间资料存储暂时不可用，请恢复连接并刷新确认保存结果后再重试。",
  internal_error: "服务内部发生错误，请稍后重试。",
  http_error: "请求未能完成，请稍后重试。",
  connection_config_argument_invalid:
    "请只指定一次 --config，并提供配置文件路径。",
  connection_config_input_invalid: "请提供完整、有效的服务连接配置。",
  connection_config_invalid: "配置文件无效，请修复 YAML 后重试。",
  connection_config_unavailable:
    "无法访问配置文件，请检查路径、编码和目录权限。",
  connection_config_read_only: "配置文件或所在目录不可写，请检查权限。",
  connection_config_too_large: "保存后的配置过大，请缩短注释或地址。",
  connection_config_save_failed: "配置保存失败，请检查磁盘空间和文件权限。",
  agent_timeout: "Agent 请求超时，请稍后重试。",
  agent_unavailable: "无法连接 Agent，请检查地址和服务进程。",
  model_not_configured: "请配置 AGENT_MODEL 和 OPENAI_API_KEY。",
  request_cancelled: "请求已取消。",
  run_timeout: "Agent 执行超时。",
  agent_execution_failed: "Agent 执行失败，请查看运行记录。",
  identity_enrollment_unavailable: "登记已过期或已取消，请重新开始。",
  identity_reference_unavailable: "该人物或参考资料已变化，请刷新后重试。",
  identity_recording_invalid: "录像无法解析或超过限制，请重新录制。",
  identity_source_unavailable:
    "所选摄像头已不在当前家庭设备清单中，请重新选择。",
  perception_image_invalid: "图片无法解码或超过输入限制，请选择其他图片。",
  perception_busy: "图片分析正忙，请稍后重试。",
  perception_unavailable: "图片分析暂时不可用，请稍后重试。",
  perception_timeout: "图片分析超时，请重试。",
  perception_failed: "图片检测失败，请稍后重试。",
  perception_media_unavailable: "窗口媒体已过期或访问已撤销。",
  perception_media_ineligible: "当前窗口不能生成所选媒体。",
  perception_media_not_ready: "窗口媒体尚未生成完成。",
  perception_media_capacity: "窗口媒体处理已达到资源限制，请稍后重试。",
  network_error: "无法连接后端，请确认后端已启动。",
  request_timeout: "请求超时，请确认后端仍在运行。",
  invalid_response: "后端返回了无效响应，请检查服务状态。",
  ice_gathering_timeout: "浏览器网络候选地址收集超时，请检查本机网络。",
  missing_local_sdp: "浏览器未生成有效的播放协商信息。",
} satisfies Record<
  Exclude<ErrorCode, MijiaErrorCode> | ClientErrorCode,
  string
>;

const issueMessages = {
  invalid_type: "字段缺失或类型不正确。",
  invalid_format: "字段格式不正确。",
  invalid_value: "字段值无效。",
  too_small: "内容未达到最小长度或数值要求。",
  too_big: "内容超过最大长度或数值限制。",
  unknown_fields: "包含未定义的字段。",
  invalid_service_url:
    "请输入 HTTP(S) 根地址，不包含账号密码、路径、query 或 fragment。",
  invalid_yaml: "YAML 语法无效或包含不支持的内容，请检查重复字段和别名引用。",
  file_too_large: "配置文件不能超过 64 KiB。",
  not_regular_file: "配置路径必须指向普通文件。",
} satisfies Record<ValidationIssue["code"], string>;

const connectionMessages = {
  reachable: "服务接口可用。",
  unreachable: "无法连接服务，请确认地址与服务进程。",
  http_error: "服务返回 HTTP 错误。",
  invalid_json: "服务未返回预期 JSON。",
  empty_response: "服务返回空响应。",
  response_too_large: "服务响应超过大小限制。",
  unexpected_response: "响应与预期服务不匹配。",
  cancelled: "检查已取消。",
  timeout: "连接检查超时。",
} satisfies Record<ConnectionReasonCode, string>;

export function errorMessage(error: DisplayError | ApiError) {
  if (isMijiaErrorCode(error.code)) return mijiaFailureMessage(error.code);
  if (
    error.code === "request_too_large" &&
    typeof error.params?.maxBytes === "number"
  ) {
    return `请求内容不能超过 ${error.params.maxBytes / 1024} KiB。`;
  }
  return errorMessages[error.code];
}

export function issueMessage(issue: ValidationIssue) {
  return issueMessages[issue.code];
}

export function connectionMessage(service: ServiceStatus) {
  if (
    service.reasonCode === "http_error" &&
    typeof service.params?.status === "number"
  ) {
    return `服务返回 HTTP ${service.params.status}。`;
  }
  if (
    service.reasonCode === "timeout" &&
    typeof service.params?.timeoutMs === "number"
  ) {
    return `连接检查超时（${service.params.timeoutMs / 1000} 秒）。`;
  }
  return connectionMessages[service.reasonCode];
}

export function describeError(error: unknown) {
  return error instanceof RequestError
    ? error.details
    : ({ code: "network_error" } satisfies DisplayError);
}

export function requestErrorMessage(error: unknown) {
  if (!(error instanceof RequestError)) return "操作失败，请重试。";
  return `${errorMessage(error.details)}（${error.details.code}）`;
}
