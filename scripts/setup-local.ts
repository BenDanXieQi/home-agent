import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
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
