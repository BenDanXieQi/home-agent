import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDetectionPool } from "../src/perception/compute/pool";
import { createPerceptionReport } from "./perception-report";
import { saveAnnotatedImage } from "./perception-annotation";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { "output-dir": { type: "string" } },
});
const images = positionals;
if (!images.length)
  throw new Error(
    "Usage: bun run detect:image [--output-dir <directory>] <image> [image ...]",
  );
const pool = await createDetectionPool();
try {
  console.log(
    JSON.stringify(
      await createPerceptionReport(pool.metadata, pool.getStatus().budget),
    ),
  );
  for (const [index, image] of images.entries()) {
    const outputPath = values["output-dir"]
      ? resolve(values["output-dir"], `${index}-${basename(image)}.png`)
      : undefined;
    const result = await pool.detectImage({ path: resolve(image) });
    const annotatedImage = outputPath
      ? await saveAnnotatedImage(result, outputPath)
      : undefined;
    console.log(JSON.stringify({ ...result, annotatedImage }));
  }
} finally {
  await pool.close();
}
