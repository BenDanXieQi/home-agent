import cv from "@techstark/opencv-js";

let initialization: Promise<void> | undefined;

// Emscripten exposes a self-resolving thenable; await its initialization callback.
export function prepareOpenCv() {
  initialization ??= new Promise<void>((resolve) => {
    if (Reflect.get(cv, "calledRun")) resolve();
    else cv.onRuntimeInitialized = resolve;
  });
  return initialization;
}
