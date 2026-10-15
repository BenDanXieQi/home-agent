import type { z } from "zod";
import type { cameraVideoQualitySchema } from "@home-agent/api/contracts";

export type CameraSourceSpec = {
  deviceId: string;
  channel: 1 | 2;
  channelCount: number;
  model: string;
  localIp?: string;
  videoQuality?: z.infer<typeof cameraVideoQualitySchema>;
};
