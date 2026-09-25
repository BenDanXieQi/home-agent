import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CredentialStoreError } from "./store";

export async function readCredentialKey(path: string) {
  try {
    // Validate and read the same opened file; paths and symlinks cannot replace
    // the checked key between the permission check and the bounded read.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 128 || (info.mode & 0o077) !== 0)
        throw new CredentialStoreError();
      const buffer = Buffer.alloc(129);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 128) throw new CredentialStoreError();
      const key = buffer.subarray(0, length).toString("utf8").trim();
      if (
        !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
        Buffer.from(key, "base64").length !== 32
      )
        throw new CredentialStoreError();
      return key;
    } finally {
      await file.close();
    }
  } catch {
    throw new CredentialStoreError();
  }
}
