import cv from "@techstark/opencv-js";

let initialization: Promise<void> | undefined;

export function prepareOpenCv() {
  initialization ??= new Promise<void>((resolve) => {
    if (Reflect.get(cv, "calledRun")) resolve();
    else cv.onRuntimeInitialized = resolve;
  });
  return initialization;
}
