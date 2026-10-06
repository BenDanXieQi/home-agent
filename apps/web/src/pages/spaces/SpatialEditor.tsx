import type { inventoryDeviceSchema } from "@home-agent/api/devices";
import type {
  SpatialSnapshot,
  SpatialSaveCommand,
} from "../../modules/spatial/api";
import { SpaceForm, PassageForm, BindingForm } from "./forms";
import type { Editor } from "./types";
export function SpatialEditor({
  editor,
  snapshot,
  devices,
  pending,
  onCancel,
  onSave,
}: {
  editor: Editor;
  snapshot: SpatialSnapshot;
  devices: ReturnType<typeof inventoryDeviceSchema.parse>[];
  pending: boolean;
  onCancel: () => void;
  onSave: (command: SpatialSaveCommand) => void;
}) {
  const actions = { pending, onCancel, scope: snapshot.scope };
  if (editor.resource === "space")
    return (
      <SpaceForm
        {...actions}
        record={editor.record}
        onSave={(input) => onSave({ resource: "space", input })}
      />
    );
  if (editor.resource === "passage")
    return (
      <PassageForm
        {...actions}
        record={editor.record}
        spaces={snapshot.spaces}
        onSave={(input) => onSave({ resource: "passage", input })}
      />
    );
  return (
    <BindingForm
      {...actions}
      record={editor.record}
      snapshot={snapshot}
      devices={devices}
      onSave={(input) => onSave({ resource: "binding", input })}
    />
  );
}
