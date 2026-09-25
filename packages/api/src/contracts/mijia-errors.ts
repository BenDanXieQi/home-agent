// Shared wire codes, HTTP statuses and safe messages. Never include upstream data.
export const mijiaErrorDefinitions = {
  mijia_invalid_input: {
    status: 400,
    message: "米家请求参数无效。",
  },
  mijia_device_not_found: {
    status: 404,
    message: "当前账号设备列表中没有此设备，请刷新设备列表。",
  },
  mijia_spec_unavailable: {
    status: 404,
    message: "该设备没有可用的 MIoT 能力规格。",
  },
  mijia_spec_invalid_response: {
    status: 502,
    message: "设备规格服务返回了无法识别的数据，请稍后重试。",
  },
  mijia_spec_failed: {
    status: 502,
    message: "无法读取设备能力规格，请检查网络后重试。",
  },
  mijia_credential_storage: {
    status: 503,
    message: "无法安全读取或保存米家授权，请检查数据库、迁移和凭据加密密钥。",
  },
  mijia_property_not_readable: {
    status: 400,
    message: "所选属性不属于当前设备的可读取规格。",
  },
  mijia_network: {
    status: 502,
    message: "无法连接米家服务，请检查网络后重试。",
  },
  mijia_timeout: { status: 504, message: "米家请求超时，请重试。" },
  mijia_cancelled: { status: 408, message: "本次操作已取消。" },
  mijia_expired: { status: 410, message: "二维码已过期，请重新扫码。" },
  mijia_cloud_invalid_response: {
    status: 502,
    message: "米家返回了无法识别的响应，请稍后重试。",
  },
  mijia_missing_credentials: {
    status: 502,
    message: "登录结果缺少设备或摄像头所需凭据，请重新扫码。",
  },
  mijia_authentication: { status: 401, message: "米家会话无效，请重新扫码。" },
  mijia_security_required: {
    status: 409,
    message: "请完成小米账号安全验证。",
  },
  mijia_security_code_invalid: {
    status: 400,
    message: "验证码无效，请检查短信或邮件后重试。",
  },
  mijia_unsupported_security: {
    status: 409,
    message: "当前安全验证方式无法自动完成，请在小米账号完成验证后重新扫码。",
  },
  mijia_invalid_state: {
    status: 409,
    message: "登录流程已结束，请重新扫码。",
  },
  mijia_unsupported_region: {
    status: 400,
    message: "当前仅支持米家中国大陆区域。",
  },
  mijia_stale_session: {
    status: 409,
    message: "会话或摄像头已改变，请刷新后重试。",
  },
  mijia_not_bound: { status: 409, message: "请先完成米家扫码登录。" },
  mijia_camera_invalid: {
    status: 400,
    message: "只能选择当前账号设备列表中的摄像头。",
  },
  mijia_camera_offline: {
    status: 409,
    message: "摄像头处于离线状态，请先在米家确认设备在线。",
  },
  mijia_go2rtc_unavailable: {
    status: 503,
    message:
      "摄像头服务未就绪，请检查服务地址和本项目的 go2rtc 镜像后重试连接。",
  },
  mijia_go2rtc_cleanup: {
    status: 503,
    message:
      "旧摄像头连接清理失败，已停止播放；请恢复原 go2rtc 服务后重试连接。",
  },
  mijia_go2rtc_lost: {
    status: 409,
    message: "摄像头服务会话已失效，播放已停止，请重试连接。",
  },
  mijia_camera_failed: {
    status: 502,
    message: "摄像头连接失败，请确认设备在线、型号受 go2rtc 支持并重试。",
  },
  mijia_playback_conflict: {
    status: 409,
    message: "该观看连接已使用不同的播放参数，请释放后重新创建。",
  },
  mijia_playback_failed: {
    status: 502,
    message: "摄像头未能建立视频连接，请确认设备在线和浏览器支持其编码。",
  },
  mijia_adapter_unavailable: {
    status: 503,
    message:
      "当前 go2rtc 缺少本项目的凭据接口，请运行 bun run dev --mode docker 构建并启动专用镜像。",
  },
  mijia_credentials_rejected: {
    status: 502,
    message: "go2rtc 未能使用本次米家凭据登录，请重试连接；仍失败时重新扫码。",
  },
  mijia_invalid_credentials: {
    status: 502,
    message: "米家返回的摄像头凭据不完整，请重新扫码。",
  },
  mijia_session_expired: {
    status: 409,
    message: "go2rtc 会话已过期或被替换，请重试连接。",
  },
  mijia_camera_unavailable: {
    status: 502,
    message:
      "摄像头型号或局域网 IPv4 地址不可用，请确认设备与本机处于可互通的局域网。",
  },
  mijia_camera_connection_failed: {
    status: 502,
    message:
      "无法从摄像头建立媒体连接，请检查型号支持、局域网连通性及米家在线状态。",
  },
  mijia_unsupported_codec: {
    status: 502,
    message:
      "摄像头的视频编码与此浏览器不匹配；当前不提供转码，请在摄像头设置中使用受支持的编码。",
  },
  mijia_signaling_failed: {
    status: 502,
    message: "WebRTC 信令建立失败，请重新播放。",
  },
  mijia_webrtc_unavailable: {
    status: 503,
    message: "go2rtc WebRTC 服务不可用，请检查运行配置。",
  },
  mijia_invalid_offer: {
    status: 400,
    message: "浏览器的视频接收请求无效，请刷新页面后重新播放。",
  },
  mijia_camera_not_found: {
    status: 409,
    message: "摄像头采集连接已失效，请重新播放。",
  },
  mijia_request_timeout: {
    status: 504,
    message: "摄像头服务请求超时，请检查连接后重试。",
  },
  mijia_request_cancelled: { status: 408, message: "播放请求已取消。" },
  mijia_invalid_response: {
    status: 502,
    message: "摄像头服务响应不符合本项目接口，请检查所用镜像和服务地址。",
  },
  mijia_devices_failed: {
    status: 502,
    message: "设备列表读取失败，请重试；会话失效时需重新扫码。",
  },
  mijia_internal_error: { status: 500, message: "米家操作失败，请重试。" },
  mijia_stale_playback: {
    status: 409,
    message: "播放请求已被替换，请重新播放。",
  },
} as const;

export type MijiaErrorCode = keyof typeof mijiaErrorDefinitions;
export type MijiaFailureReason = MijiaErrorCode extends `mijia_${infer Reason}`
  ? Reason
  : never;

export function isMijiaErrorCode(value: string): value is MijiaErrorCode {
  return Object.hasOwn(mijiaErrorDefinitions, value);
}

export const mijiaErrorCodes = Object.keys(mijiaErrorDefinitions).filter(
  isMijiaErrorCode,
);

export function isMijiaFailureReason(
  value: unknown,
): value is MijiaFailureReason {
  return (
    typeof value === "string" &&
    Object.hasOwn(mijiaErrorDefinitions, `mijia_${value}`)
  );
}

export function mijiaFailureMessage(code: MijiaErrorCode) {
  return mijiaErrorDefinitions[code].message;
}
