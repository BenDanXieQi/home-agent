import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { agentCurrentContextSchema } from "@home-agent/api/agent-receipts";
import { attentionSchema } from "./source";
import { createHouseholdModelView } from "./view";
import { decodeHouseholdContext, encodeHouseholdContext } from "./encoding";

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      attention: { type: "string" },
      remember: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "context:format --input <current-context.json> overview --output <directory>\ncontext:format --input <current-context.json> devices|spec|state [device-id] [keys...]\ncontext:format --input <encoded.json> decode\nExplicit spec/state queries support --attention <file> --remember.",
    );
    return;
  }
  if (!values.input) throw new Error("--input is required");
  const input: unknown = await Bun.file(values.input).json();
  const [command = "overview", deviceId, ...keys] = positionals;
  if (values.remember && command !== "spec" && command !== "state")
    throw new Error("--remember requires a spec/state query");
  if (!["overview", "devices", "spec", "state", "decode"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  if (command !== "spec" && command !== "state" && deviceId !== undefined)
    throw new Error(`${command} takes no positional arguments`);
  if (values.output && command !== "overview")
    throw new Error("--output requires overview");
  if (values.attention && command === "decode")
    throw new Error("decode does not use --attention");
  const inputStat = await stat(values.input);
  async function checkOutputs(paths: string[], protectAttention = false) {
    const seenPaths = new Set([resolve(values.input!)]);
    const seenFiles = new Set([`${inputStat.dev}:${inputStat.ino}`]);
    if (protectAttention && values.attention) {
      seenPaths.add(resolve(values.attention));
      if (await Bun.file(values.attention).exists()) {
        const info = await stat(values.attention);
        seenFiles.add(`${info.dev}:${info.ino}`);
      }
    }
    for (const path of paths) {
      const resolved = resolve(path);
      if (seenPaths.has(resolved))
        throw new Error(`Output path collision: ${path}`);
      seenPaths.add(resolved);
      const target = await stat(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      });
      if (!target) continue;
      if (!target.isFile())
        throw new Error(`Output is not a regular file: ${path}`);
      const identity = `${target.dev}:${target.ino}`;
      if (seenFiles.has(identity))
        throw new Error(`Output file collision: ${path}`);
      seenFiles.add(identity);
    }
  }
  if (command === "decode") {
    console.log(JSON.stringify(decodeHouseholdContext(input), null, 2));
    return;
  }
  const { context } = agentCurrentContextSchema.parse(input);
  const attention =
    values.attention && (await Bun.file(values.attention).exists())
      ? attentionSchema.parse(await Bun.file(values.attention).json())
      : {};
  const view = createHouseholdModelView(context, attention);
  if (command === "overview") {
    if (!values.output) throw new Error("overview requires --output");
    const directory = resolve(values.output);
    await mkdir(directory, { recursive: true });
    const encoded = encodeHouseholdContext(view.semantic);
    const decoded = decodeHouseholdContext(encoded);
    if (!isDeepStrictEqual(decoded, view.semantic))
      throw new Error("Model context failed lossless encoding validation");
    const text = JSON.stringify(encoded);
    const formatted = `${JSON.stringify(encoded, null, 2)}\n`;
    const manifest = {
      devices: encoded.D.length,
      capabilities: encoded.D.reduce(
        (sum, d) => sum + (encoded.S[d[5]]?.length ?? 0),
        0,
      ),
      reports: encoded.R.reduce((sum, r) => sum + r[5].length, 0),
      characters: Array.from(text).length,
      bytes: Buffer.byteLength(text),
      capability_limit: null,
      token_limit: null,
    };
    const outputs = {
      "context.json": text,
      "context.pretty.json": formatted,
      "context.formatted.json": formatted,
      "context.decoded.json": `${JSON.stringify(decoded, null, 2)}\n`,
      "capability-audit.json": `${JSON.stringify(view.audit, null, 2)}\n`,
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    };
    await checkOutputs(
      Object.keys(outputs).map((name) => resolve(directory, name)),
      true,
    );
    await Promise.all(
      Object.entries(outputs).map(([name, contents]) =>
        Bun.write(resolve(directory, name), contents),
      ),
    );
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "devices") {
    console.log(
      JSON.stringify(
        view.semantic.设备组.flatMap((g) => g.设备),
        null,
        2,
      ),
    );
    return;
  }
  if (command !== "spec" && command !== "state")
    throw new Error(`Unknown command: ${command}`);
  if (!deviceId) throw new Error(`${command} requires a device ID`);
  const result = view.query(deviceId, keys, command);
  if (values.remember) {
    if (!values.attention || !keys.length)
      throw new Error("--remember requires --attention and explicit keys");
    await checkOutputs([values.attention]);
    attention[deviceId] = [
      ...new Set([...keys, ...(attention[deviceId] ?? [])]),
    ];
    await Bun.write(values.attention, JSON.stringify(attention));
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) await main();
