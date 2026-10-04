import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import models from "../apps/backend/src/perception/identity/models.json";

const directory = resolve(
  import.meta.dir,
  "..",
  process.argv[2] ?? "data/identity/models",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const spec of Object.values(models.models)) {
  for (const asset of [
    { file: spec.file, url: spec.url, hash: spec.sha256 },
    { file: spec.licenseFile, url: spec.licenseUrl, hash: spec.licenseSha256 },
  ]) {
    const path = resolve(directory, asset.file);
    let existing: Buffer | undefined;
    try {
      existing = await readFile(path);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (
      existing &&
      createHash("sha256").update(existing).digest("hex") === asset.hash
    ) {
      console.info(`Verified ${asset.file}`);
      continue;
    }
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(
        `Model download failed: ${asset.file} (${response.status})`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== asset.hash)
      throw new Error(`Model fingerprint mismatch: ${asset.file}`);
    await writeFile(path, bytes, { mode: 0o600 });
    console.info(`Installed ${asset.file}`);
  }
}
