import type { inventoryDeviceSchema } from "@home-agent/api/devices";
import type { SpatialSnapshot } from "../../modules/spatial/api";

export function createSpatialLabels(
  snapshot: SpatialSnapshot,
  devices: ReturnType<typeof inventoryDeviceSchema.parse>[],
) {
  const spaces = new Map(
    snapshot.spaces.map((record) => [record.id, record.name]),
  );
  const passages = new Map(
    snapshot.passages.map((record) => [record.id, record.name]),
  );
  const sources = new Map(devices.map((device) => [device.id, device.name]));
  const spaceName = (id: string) => spaces.get(id) ?? id;
  function bindingLabel(
    binding: SpatialSnapshot["observation_bindings"][number],
  ) {
    const source = sources.get(binding.device_id) ?? binding.device_id;
    const target = binding.space_id
      ? spaceName(binding.space_id)
      : (passages.get(binding.passage_id!) ?? binding.passage_id);
    return `${source}${binding.channel === null ? "" : ` / 镜头 ${binding.channel}`} → ${target}`;
  }
  return { spaceName, bindingLabel };
}
