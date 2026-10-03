import { createCipheriv } from "node:crypto";

/** Xiaomi's protocol requires RC4 with the first 1024 stream bytes discarded. */
export function cryptRc4(key: Buffer, data: Buffer) {
  const cipher = createCipheriv("rc4", key, null);
  cipher.update(Buffer.alloc(1024));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
