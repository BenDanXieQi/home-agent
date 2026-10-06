import {
  layoutWithLines,
  prepareWithSegments,
  setLocale,
} from "@chenglou/pretext";
import {
  jsonFont,
  jsonLineHeight,
  type JsonLayoutRequest,
} from "./json-layout";

let json = "";
let prepared: ReturnType<typeof prepareWithSegments>[] | null = null;

/** The worker owns the reading snapshot and reuses measurements across width changes. */
export function layoutJson(request: JsonLayoutRequest) {
  try {
    if (request.kind === "prepare") {
      setLocale(request.locale);
      json = JSON.stringify(request.value, null, 2) ?? "null";
      // Bound each prepare call by JSON paragraphs instead of segmenting a megabyte-long string.
      const paragraphs = json.split(/(?<=\n)/);
      prepared = null;
      const blocks: ReturnType<typeof prepareWithSegments>[] = [];
      for (let i = 0; i < paragraphs.length; i += 32) {
        blocks.push(
          prepareWithSegments(paragraphs.slice(i, i + 32).join(""), jsonFont, {
            whiteSpace: "pre-wrap",
          }),
        );
      }
      prepared = blocks;
    }
    if (!prepared) throw new Error("Reading snapshot is not prepared");
    const lines = prepared.flatMap((block) =>
      layoutWithLines(block, request.width, jsonLineHeight).lines.map(
        (line) => line.text,
      ),
    );
    return {
      kind: "ready" as const,
      requestId: request.requestId,
      width: request.width,
      ...(request.kind === "prepare" ? { json } : {}),
      lines,
    };
  } catch {
    return {
      kind: "failed" as const,
      requestId: request.requestId,
      error: "JSON 排版失败，请重新读取。",
    };
  }
}

self.addEventListener("message", (event: MessageEvent<JsonLayoutRequest>) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker messaging has no targetOrigin.
  self.postMessage(layoutJson(event.data));
});
