import {
  observationBindingEnabledSchema,
  spatialDeleteSchema,
  spatialLayoutApplySchema,
  spaceSaveSchema,
  passageSaveSchema,
  observationBindingSaveSchema,
  isObservationSourceDevice,
  type ObservationSourceDevice,
} from "@home-agent/api/spatial";
import type { createSpatialRepository } from "./repository";
import { SpatialError } from "./errors";

export function createSpatialService(
  repository: ReturnType<typeof createSpatialRepository> | undefined,
  readDevices: () => ObservationSourceDevice[],
) {
  function storage() {
    if (!repository) throw new SpatialError("storage_unavailable");
    return repository;
  }
  return {
    read() {
      return storage().read();
    },
    applyLayout(input: ReturnType<typeof spatialLayoutApplySchema.parse>) {
      return storage().applyLayout(spatialLayoutApplySchema.parse(input));
    },
    saveSpace(input: ReturnType<typeof spaceSaveSchema.parse>) {
      return storage().saveSpace(spaceSaveSchema.parse(input));
    },
    savePassage(input: ReturnType<typeof passageSaveSchema.parse>) {
      return storage().savePassage(passageSaveSchema.parse(input));
    },
    saveObservationBinding(
      input: ReturnType<typeof observationBindingSaveSchema.parse>,
    ) {
      const command = observationBindingSaveSchema.parse(input);
      return storage().saveObservationBinding(command, (existing) => {
        if (
          existing?.device_id === command.device_id &&
          existing.channel === command.channel
        )
          return;
        const device = readDevices().find(
          (candidate) => candidate.id === command.device_id,
        );
        if (
          !device ||
          !isObservationSourceDevice(device) ||
          (device.camera
            ? command.channel === null ||
              !device.channels.includes(command.channel)
            : command.channel !== null)
        )
          throw new SpatialError("source_invalid");
      });
    },
    setObservationBindingEnabled(
      input: ReturnType<typeof observationBindingEnabledSchema.parse>,
    ) {
      return storage().setObservationBindingEnabled(
        observationBindingEnabledSchema.parse(input),
      );
    },
    deleteSpace(input: ReturnType<typeof spatialDeleteSchema.parse>) {
      return storage().deleteSpace(spatialDeleteSchema.parse(input));
    },
    deletePassage(input: ReturnType<typeof spatialDeleteSchema.parse>) {
      return storage().deletePassage(spatialDeleteSchema.parse(input));
    },
    deleteObservationBinding(
      input: ReturnType<typeof spatialDeleteSchema.parse>,
    ) {
      return storage().deleteObservationBinding(
        spatialDeleteSchema.parse(input),
      );
    },
  };
}
