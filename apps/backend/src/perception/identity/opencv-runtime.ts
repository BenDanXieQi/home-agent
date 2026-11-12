import cvModule from "@techstark/opencv-js";

export function prepareOpenCv() {
  return Promise.resolve(cvModule);
}
