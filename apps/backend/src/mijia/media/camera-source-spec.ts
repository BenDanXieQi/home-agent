import type { z } from "zod";
import type { cameraVideoQualitySchema } from "@home-agent/api/contracts";

/** One lens source, independent of the Xiaomi and go2rtc wire formats. */
export type CameraSourceSpec = {
  deviceId: string;
  channel: 1 | 2;
  channelCount: number;
  model: string;
  localIp?: string;
  videoQuality?: z.infer<typeof cameraVideoQualitySchema>;
};
