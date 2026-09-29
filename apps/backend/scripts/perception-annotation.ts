import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import writeFileAtomic from "write-file-atomic";
import { loadImage, type detectImage } from "../src/perception/detection/image";

// Runs only in the standalone debug command, never in the shared inference worker.
export async function saveAnnotatedImage(
  result: Awaited<ReturnType<typeof detectImage>>,
  outputPath: string,
) {
  const image = await loadImage({
    path: result.imagePath,
    resize: { width: result.width, height: result.height },
  });
  if (image.inputSha256 !== result.inputSha256)
    throw new Error("Image changed after detection; annotation was not saved");
  const boxes = result.detections
    .map(
      (box) =>
        `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${box.classId === 0 ? "#00ff88" : "#ffcc00"}" stroke-width="3"/><text x="${box.x}" y="${Math.max(18, box.y - 5)}" font-size="18" fill="#00ff88" stroke="#000" stroke-width="0.4">${box.className} ${box.confidence.toFixed(3)}</text>`,
    )
    .join("");
  const png = await sharp(image.frame.rgb, {
    raw: { width: result.width, height: result.height, channels: 3 },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${result.width}" height="${result.height}">${boxes}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, png, { mode: 0o600 });
  return path;
}
