import catalog from "./camera-capabilities.json";

export function cameraChannelCount(model: string | undefined) {
  return (
    catalog.models.find((entry) => entry.model === model)?.channel_count ??
    catalog.default_channel_count
  );
}
