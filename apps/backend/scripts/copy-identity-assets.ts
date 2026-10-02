import { copyFile, mkdir } from "node:fs/promises";
const destination = new URL("../dist/perception/identity/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["opencv-worker.py", "models.json", "profile.json"])
  await copyFile(
    new URL(`../src/perception/identity/${name}`, import.meta.url),
    new URL(name, destination),
  );
