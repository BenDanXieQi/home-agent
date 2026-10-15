import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nativeImports = () =>
  Object.keys(require.cache).filter((path) =>
    /[/\\](sharp|onnxruntime-node)[/\\]/.test(path),
  );
const beforeImport = nativeImports();
const { createDetectionPool } =
  await import("../../../src/perception/compute/pool");
const afterImport = nativeImports();
const imagePath = process.argv[2];
if (!imagePath) throw new Error("Missing probe image");
const pool = await createDetectionPool({
  initializeTimeoutMs: 3000,
  taskTimeoutMs: 3000,
  closeTimeoutMs: 1000,
});
try {
  const afterInitialization = nativeImports();
  const result = await pool.detectImage({ path: imagePath });
  const afterDetection = nativeImports();
  const separateProcess = pool.getStatus().processId !== process.pid;
  await pool.close();
  const afterClose = nativeImports();
  await import("sharp");
  await import("onnxruntime-node");
  const loaded = nativeImports();
  console.log(
    JSON.stringify({
      beforeImport,
      afterImport,
      afterInitialization,
      afterDetection,
      afterClose,
      detected: result.kind,
      separateProcess,
      positiveControl: {
        sharp: loaded.some((path) => /[/\\]sharp[/\\]/.test(path)),
        onnx: loaded.some((path) => /[/\\]onnxruntime-node[/\\]/.test(path)),
      },
    }),
  );
} finally {
  await pool.close();
}
