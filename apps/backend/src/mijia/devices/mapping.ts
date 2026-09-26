import type { MiCloudDevice } from "../protocols/micloud";
import type { CameraSourceSpec } from "../media/camera-source-spec";
import { cameraChannelCount } from "../protocols/micloud/camera-capabilities";

export function isCamera(device: MiCloudDevice) {
  return (
    typeof device.model === "string" &&
    /(?:^|\.)(?:camera|cateye)(?:\.|$)/.test(device.model)
  );
}

export function cameraChannels(device: MiCloudDevice) {
  if (!isCamera(device)) return [];
  const count = cameraChannelCount(device.model);
  // The media boundary supports one or two lenses. Never silently truncate a
  // larger declared inventory into a working-looking but incomplete camera.
  return (
    count === 2 ? [1, 2] : count === 1 ? [1] : []
  ) satisfies CameraSourceSpec["channel"][];
}

export function describeMijiaDevice(device: MiCloudDevice) {
  return {
    id: device.did,
    name: typeof device.name === "string" ? device.name : "未命名设备",
    model: typeof device.model === "string" ? device.model : "未知型号",
    home_id: device.home_id ?? null,
    home_name: device.home_name ?? null,
    room_id: device.room_id ?? null,
    room_name: device.room_name ?? null,
    online: device.isOnline === true,
    camera: isCamera(device),
    channels: cameraChannels(device),
  };
}
