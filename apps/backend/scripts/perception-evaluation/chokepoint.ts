import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export const chokePointSource = {
  page: "https://arma.sourceforge.net/chokepoint/",
  download: "https://zenodo.org/records/815657",
  attribution:
    "NICTA; Wong, Chen, Mau, Sanderson and Lovell, CVPR Workshops 2011, doi:10.1109/CVPRW.2011.5981881",
  license:
    "non-commercial research and personal experimentation; retain the original license notice",
  archiveSha256:
    "3e310249afa86309175a13a04eb3e5cbea60f38e4018f9e4b8bd3fd80e39fcba",
  groundtruthSha256:
    "2ba86bf1ebd3dbe14d170a8fede5d0911ab383feae1ab30ca2e779ae7671dc1d",
  fps: 30,
} as const;
export async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const pointSchema = z.object({
  "@_x": z.coerce.number().min(0).max(800),
  "@_y": z.coerce.number().min(0).max(600),
});
const truthSchema = z.object({
  dataset: z.object({
    "@_name": z.string(),
    frame: z.array(
      z.object({
        "@_number": z.coerce.number().int().min(0).max(4409),
        person: z
          .array(
            z.object({
              "@_id": z.coerce.number().int().positive(),
              leftEye: pointSchema,
              rightEye: pointSchema,
            }),
          )
          .default([]),
      }),
    ),
  }),
});
const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  isArray: (name) => name === "frame" || name === "person",
  processEntities: false,
});
export async function readChokePoint(directory: string) {
  const temporary = await mkdtemp(join(tmpdir(), "chokepoint-calibration-"));
  const close = () => rm(temporary, { recursive: true, force: true });
  try {
    await copyFile(
      join(directory, "P1E_S1.tar.xz"),
      join(temporary, "P1E_S1.tar.xz"),
    );
    await copyFile(
      join(directory, "groundtruth.tar.xz"),
      join(temporary, "groundtruth.tar.xz"),
    );
    if (
      (await hashFile(join(temporary, "P1E_S1.tar.xz"))) !==
        chokePointSource.archiveSha256 ||
      (await hashFile(join(temporary, "groundtruth.tar.xz"))) !==
        chokePointSource.groundtruthSha256
    )
      throw new Error("ChokePoint fixed release fingerprint mismatch");
    const execute = promisify(execFile);
    await execute("tar", [
      "-xJf",
      join(temporary, "P1E_S1.tar.xz"),
      "-C",
      temporary,
    ]);
    await execute("tar", [
      "-xJf",
      join(temporary, "groundtruth.tar.xz"),
      "-C",
      temporary,
    ]);
    const sources = [];
    for (const camera of [1, 2, 3]) {
      const name = `P1E_S1_C${camera}`;
      await execute("tar", [
        "-xJf",
        join(temporary, `${name}.tar.xz`),
        "-C",
        temporary,
      ]);
      const bytes = await readFile(
        join(temporary, "groundtruth", `${name}.xml`),
      );
      const truth = truthSchema.parse(parser.parse(bytes.toString())).dataset;
      if (truth["@_name"] !== name)
        throw new Error("Groundtruth source name mismatch");
      const labels = new Map(
        truth.frame.map((frame) => [
          frame["@_number"],
          frame.person.map((person) => ({
            identity: person["@_id"],
            leftEye: { x: person.leftEye["@_x"], y: person.leftEye["@_y"] },
            rightEye: { x: person.rightEye["@_x"], y: person.rightEye["@_y"] },
          })),
        ]),
      );
      const files = (await readdir(join(temporary, name)))
        .filter((file) => file.endsWith(".jpg"))
        .toSorted();
      if (files.length !== 2292)
        throw new Error(`Expected 2292 original images for ${name}`);
      const samples = files.map((file) => {
        if (!/^\d{8}\.jpg$/.test(file))
          throw new Error("Unexpected original frame filename");
        const frameNumber = Number(file.slice(0, 8));
        const people = labels.get(frameNumber);
        if (!people)
          throw new Error(`Original frame lacks groundtruth entry: ${file}`);
        return {
          source: name,
          camera,
          file: `${name}/${file}`,
          frameNumber,
          timeMs: (frameNumber / chokePointSource.fps) * 1000,
          people,
        };
      });
      sources.push({
        name,
        camera,
        xmlSha256: createHash("sha256").update(bytes).digest("hex"),
        availableImages: samples.length,
        missingImagesInSpan: 4410 - samples.length,
        samples: samples.filter((sample) => sample.frameNumber % 10 === 0),
      });
    }
    const identities = [
      ...new Set(
        sources.flatMap((source) =>
          source.samples.flatMap((sample) =>
            sample.people.map((person) => person.identity),
          ),
        ),
      ),
    ]
      .map((identity) => ({
        identity,
        hash: createHash("sha256")
          .update(`chokepoint-face-split:${identity}`)
          .digest("hex"),
      }))
      .toSorted((a, b) => a.hash.localeCompare(b.hash));
    if (identities.length !== 25)
      throw new Error("Expected 25 primary identities in this fixed subset");
    return {
      source: chokePointSource,
      licenseNotice: await readFile(
        join(directory, "official-page-with-license.html"),
      ),
      imageDirectory: temporary,
      close,
      sources,
      assignment: identities.map(({ identity }, index) => ({
        identity,
        split: index < 13 ? ("tune" as const) : ("holdout" as const),
        enrolled: index % 13 < 9,
      })),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
