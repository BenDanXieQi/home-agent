/** One lens source, independent of the Xiaomi and go2rtc wire formats. */
export type CameraSourceSpec = {
  deviceId: string;
  channel: 1 | 2;
  channelCount: number;
  model: string;
  localIp?: string;
};
