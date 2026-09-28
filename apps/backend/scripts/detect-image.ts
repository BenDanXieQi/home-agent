import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDetectionPool } from "../src/perception/compute/pool";
import { createPerceptionReport } from "./perception-report";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { "output-dir": { type: "string" } },
});
const [model, ...images] = positionals;
if (!model || !images.length)
  throw new Error(
    "Usage: bun run detect:image [--output-dir <directory>] <det_4C.onnx> <image> [image ...]",
  );
const pool = await createDetectionPool(resolve(model));
try {
  console.log(JSON.stringify(await createPerceptionReport(pool.metadata)));
  for (const [index, image] of images.entries()) {
    const outputPath = values["output-dir"]
      ? resolve(values["output-dir"], `${index}-${basename(image)}.png`)
      : undefined;
    const result = await pool.detectImage({ path: resolve(image), outputPath });
    console.log(JSON.stringify(result));
  }
} finally {
  await pool.close();
}
