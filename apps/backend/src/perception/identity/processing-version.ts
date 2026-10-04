import { identityCapacity } from "@home-agent/api/contracts";
import { createHash } from "node:crypto";
import models from "./models.json";
import profile from "./profile.json";
import opencv from "@techstark/opencv-js/package.json";
import nudged from "nudged/package.json";
import ort from "onnxruntime-node/package.json";
import sharp from "sharp";

export const faceEngine = {
  engine: "opencv-wasm-onnxruntime" as const,
  version: `${opencv.version}/${ort.version}`,
};
// SFace's published five-landmark 112x112 template; estimation belongs to nudged.
export const faceAlignment = {
  estimator: "nudged-TSR",
  version: nudged.version,
  landmarks: [
    { x: 38.2946, y: 51.6963 },
    { x: 73.5318, y: 51.5014 },
    { x: 56.0252, y: 71.7366 },
    { x: 41.5493, y: 92.3655 },
    { x: 70.7299, y: 92.2041 },
  ],
};

export const faceImagePreparation = {
  camera: { fit: "fill", kernel: "lanczos3" },
  photo: { fit: "contain", kernel: "lanczos3", background: "black" },
} as const;

export function faceProcessingVersions(minimumSharpness: number) {
  return {
    modelVersion: `${models.models.yunet.sha256}:${models.models.sface.sha256}`,
    processingVersion: createHash("sha256")
      .update(
        JSON.stringify({
          profile,
          minimumSharpness,
          image: faceImagePreparation,
          photoAutoOrientation: true,
          feature: "sface-rgb-float32-nchw",
          engine: faceEngine,
          alignment: faceAlignment,
          referenceEncoding: {
            sharp: sharp.versions.sharp,
            format: "jpeg",
            quality: 95,
          },
        }),
      )
      .digest("hex"),
  };
}

export const petProfile = {
  side: 224,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  minimumSide: 56,
  featureDimensions: identityCapacity.petFeatureDimensions,
  minimumSharpness: 20,
  resize: { fit: "fill", kernel: "lanczos3" },
} as const;
function petProcessingVersions(className: "cat" | "dog") {
  return {
    modelVersion: models.models.pet.sha256,
    processingVersion: createHash("sha256")
      .update(
        JSON.stringify({
          petProfile,
          className,
          frame: {
            width: profile.width,
            height: profile.height,
            preparation: faceImagePreparation.camera,
          },
          photoAutoOrientation: true,
          opencv: opencv.version,
          referenceEncoding: { format: "jpeg", quality: 95 },
          sharp: sharp.versions.sharp,
          ort: ort.version,
          crop: "measured-animal-box",
        }),
      )
      .digest("hex"),
  };
}
export function identityProcessingVersions(minimumSharpness: number) {
  const human = faceProcessingVersions(minimumSharpness);
  const cat = petProcessingVersions("cat");
  const dog = petProcessingVersions("dog");
  return {
    modelVersion: `${human.modelVersion}:${cat.modelVersion}`,
    processingVersion: createHash("sha256")
      .update(
        `${human.processingVersion}:${cat.processingVersion}:${dog.processingVersion}`,
      )
      .digest("hex"),
    adapters: { human, cat, dog },
  };
}
