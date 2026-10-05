import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";

export const real28Source = {
  page: "https://wanfb.github.io/dataset.html",
  download:
    "https://drive.google.com/file/d/1PQuhZJ05WBY62gdMMFiD8wBCItzKegWY/view",
  license: "https://wanfb.github.io/resources/licence.txt",
  archiveSha256:
    "bb84e9dfed9e1a9801bfd7617e6addc44cee36d483d777b2db5d1308170d5de8",
  split:
    "sha256(real28-appearance-split:identity), first 14 tune, last 14 holdout; first 10 in each enrolled, last 4 unknown",
} as const;
export const fingerprint = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const labelSchema = z.strictObject({
  identity: z.coerce.number().int().min(1).max(28),
  camera: z.coerce.number().int().min(1).max(4),
  clothing: z.coerce.number().int().min(1).max(3),
  image: z.coerce.number().int().positive(),
});

export async function readReal28(directory: string) {
  const archive = await readFile(join(directory, "Real28.zip"));
  if (fingerprint(archive) !== real28Source.archiveSha256)
    throw new Error(
      "Real28 archive fingerprint differs from the fixed release",
    );
  const license = await readFile(join(directory, "LICENSE.txt"), "utf8");
  if (!license.includes("Apache License, Version 2.0"))
    throw new Error("Keep the author's Real28 license alongside the archive");
  const temporary = await mkdtemp(join(tmpdir(), "real28-calibration-"));
  const close = () => rm(temporary, { recursive: true, force: true });
  try {
    await writeFile(join(temporary, "release.zip"), archive);
    await promisify(execFile)("unzip", [
      "-q",
      join(temporary, "release.zip"),
      "-d",
      join(temporary, "images"),
    ]);
    const samples = [];
    for (const subset of ["gallery", "query"] as const) {
      const files = await readdir(join(temporary, "images", subset));
      for (const file of files.toSorted()) {
        const parts = /^(\d+)_(\d+)_(\d+)_(\d+)\.jpeg$/.exec(file);
        if (!parts)
          throw new Error(`Unexpected Real28 file: ${subset}/${file}`);
        const [, identity, camera, clothing, image] = parts;
        samples.push({
          ...labelSchema.parse({ identity, camera, clothing, image }),
          subset,
          file: `${subset}/${file}`,
        });
      }
    }
    if (samples.length !== 4324)
      throw new Error("Expected all 4324 images from the fixed Real28 release");
    const identities = [...new Set(samples.map((sample) => sample.identity))]
      .map((identity) => ({
        identity,
        hash: fingerprint(`real28-appearance-split:${identity}`),
      }))
      .toSorted((a, b) => a.hash.localeCompare(b.hash));
    if (identities.length !== 28)
      throw new Error("Expected 28 Real28 identities");
    const assignment = new Map(
      identities.map(({ identity }, index) => [
        identity,
        {
          split: index < 14 ? ("tune" as const) : ("holdout" as const),
          enrolled: index % 14 < 10,
        },
      ]),
    );
    const references = new Set<string>();
    for (const { identity } of identities) {
      if (!assignment.get(identity)!.enrolled) continue;
      const candidates = samples
        .filter(
          (sample) =>
            sample.identity === identity &&
            sample.clothing === 1 &&
            sample.subset === "gallery",
        )
        .toSorted((a, b) => a.camera - b.camera || a.image - b.image);
      for (const camera of [1, 2, 3, 4]) {
        const sample = candidates.find((item) => item.camera === camera);
        if (sample) references.add(sample.file);
      }
      for (const sample of candidates) {
        if (candidates.filter((item) => references.has(item.file)).length >= 5)
          break;
        references.add(sample.file);
      }
      if (!candidates.length)
        throw new Error(`No clothing-1 reference for ${identity}`);
    }
    return {
      source: { ...real28Source, licenseSha256: fingerprint(license) },
      imageDirectory: join(temporary, "images"),
      close,
      samples: samples.map((sample) => ({
        ...sample,
        ...assignment.get(sample.identity)!,
        role: references.has(sample.file)
          ? ("reference" as const)
          : ("target" as const),
      })),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
