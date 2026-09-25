import catalog from "./camera-capabilities.json";

/** Channel inventory from Xiaomi's camera metadata, not a model-name heuristic.
 * The default follows MIoTClient.get_cameras_async at the pinned source revision.
 */
export function cameraChannelCount(model: string | undefined) {
  return (
    catalog.models.find((entry) => entry.model === model)?.channel_count ??
    catalog.default_channel_count
  );
}
