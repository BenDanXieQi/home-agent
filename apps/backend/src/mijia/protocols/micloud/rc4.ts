// Adapted from homebridge-miot/lib/utils/CustomCryptRC4.js.
// Copyright (c) 2025 Marcin. MIT license; see ../LICENSE and ../README.md.
// Upstream credits https://github.com/sipiyou/edomi-roboroc/blob/main/php/cryptRC4.php.

/** Xiaomi's protocol requires RC4 with the first 1024 stream bytes discarded. */
export function cryptRc4(key: Buffer, data: Buffer) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  let i = 0;
  j = 0;
  const output = Buffer.alloc(data.length);
  for (let position = -1024; position < data.length; position++) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    if (position >= 0) {
      output[position] =
        data[position]! ^ state[(state[i]! + state[j]!) & 255]!;
    }
  }
  return output;
}
