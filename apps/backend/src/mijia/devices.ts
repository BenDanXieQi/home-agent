import type { MiCloudDevice } from "./micloud";
import type { CameraSourceSpec } from "./camera-source";

export function isCamera(device: MiCloudDevice) {
  return (
    typeof device.model === "string" &&
    /(?:^|\.)(?:camera|cateye)(?:\.|$)/.test(device.model)
  );
}

export function cameraChannels(device: MiCloudDevice) {
  if (!isCamera(device)) return [];
  return (
    device.model === "mxiang.camera.c500ch" ? [1, 2] : [1]
  ) satisfies CameraSourceSpec["channel"][];
}

export function describeMijiaDevices(
  devices: readonly MiCloudDevice[],
  retainedChannels: (deviceId: string) => (1 | 2)[] = () => [],
) {
  return devices.map((device) => ({
    id: device.did,
    name: typeof device.name === "string" ? device.name : "未命名设备",
    model: typeof device.model === "string" ? device.model : "未知型号",
    online: device.isOnline === true,
    camera: isCamera(device),
    channels: cameraChannels(device),
    retainedChannels: retainedChannels(device.did),
  }));
}
