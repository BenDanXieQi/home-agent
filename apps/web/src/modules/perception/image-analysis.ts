import {
  frameLimits,
  imageLimits,
  imageDetectionResponseSchema,
} from "@home-agent/api/contracts";
import { requestJson } from "../../api/client";
import { imageSize } from "image-size";

function assertImageDimensions(
  image: Pick<ReturnType<typeof imageSize>, "width" | "height">,
) {
  const { width, height } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > frameLimits.maxDimension ||
    height > frameLimits.maxDimension ||
    width * height > frameLimits.maxPixels
  )
    throw new Error(
      "图片每边最多 8192 像素，总像素不得超过 3840 × 2160；请先缩小图片。",
    );
}

export async function prepareAnalysisImage(file: File, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!file.size || file.size > imageLimits.maxFileBytes)
    throw new Error("请选择不超过 32 MiB 的图片。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  let dimensions;
  try {
    dimensions = imageSize(bytes);
  } catch (cause) {
    throw new Error("无法读取图片尺寸，请选择有效且支持的图片格式。", {
      cause,
    });
  }
  assertImageDimensions(dimensions);
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const canvas = document.createElement("canvas");
  try {
    signal.throwIfAborted();
    assertImageDimensions(bitmap);
    const { width, height } = bitmap;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法准备图片。");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("浏览器无法准备图片。"));
      }, "image/png");
    });
    signal.throwIfAborted();
    if (blob.size > imageLimits.maxFileBytes)
      throw new Error("处理后的图片超过 32 MiB，请先缩小图片。");
    // Preview and upload share this exact PNG, with EXIF orientation applied
    // and transparency flattened. No metadata rotation remains for sharp.
    return {
      name: file.name,
      blob,
      url: URL.createObjectURL(blob),
      width,
      height,
    };
  } finally {
    bitmap.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}

export function analyzeImage(blob: Blob, signal: AbortSignal) {
  return requestJson(
    (client, options) =>
      client.api.perception.images.detect.$post(
        {},
        {
          init: {
            ...options.init,
            body: blob,
            headers: { "Content-Type": "application/octet-stream" },
          },
        },
      ),
    imageDetectionResponseSchema,
    { signal, timeoutMs: 130_000 },
  );
}
