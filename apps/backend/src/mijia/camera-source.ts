/** One lens source, independent of the Xiaomi and go2rtc wire formats. */
export type CameraSourceSpec = {
  deviceId: string;
  channel: 1 | 2;
  model: string;
  localIp?: string;
};
