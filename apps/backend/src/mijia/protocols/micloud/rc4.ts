import { createCipheriv } from "node:crypto";

export function cryptRc4(key: Buffer, data: Buffer) {
  const cipher = createCipheriv("rc4", key, null);
  cipher.update(Buffer.alloc(1024));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
