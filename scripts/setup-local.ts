import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
await mkdir(resolve(root, "config/go2rtc"), {
  recursive: true,
  mode: 0o700,
});

for (const [source, destination] of [
  [".env.example", ".env"],
  ["docker/go2rtc.yaml", "config/go2rtc/go2rtc.yaml"],
] as const) {
  try {
    await copyFile(
      resolve(root, source),
      resolve(root, destination),
      constants.COPYFILE_EXCL,
    );
    console.info(`Created ${destination} from ${source}`);
    if (destination === ".env")
      console.info("请填写 .env 中的数据库密码和模型凭据，见 README.md。");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

// Never replace an existing key: encrypted database records depend on it.
try {
  await writeFile(
    resolve(root, "config/credentials.key"),
    randomBytes(32).toString("base64") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.info("Created local credential encryption key");
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "EEXIST"
  )
    throw error;
}
