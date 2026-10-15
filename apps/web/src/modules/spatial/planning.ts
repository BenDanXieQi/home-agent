import { spatialPlanningInputSchema } from "@home-agent/agent/workflows/spatial-planning";
import { agentWorkflowResultSchema } from "@home-agent/agent/workflows";
import { requestJson } from "../../api/client";
import { RequestError } from "../../api/errors";

export async function runSpatialPlanning(
  scope: string,
  input: ReturnType<typeof spatialPlanningInputSchema.parse>,
  signal: AbortSignal,
  requestOptions: { keepalive?: boolean } = {},
) {
  const response = await requestJson(
    (api, options) =>
      api.api.workflows.$post(
        {
          json: { scope_epoch: scope, workflow: "spatial-planning", input },
        },
        options,
      ),
    agentWorkflowResultSchema,
    { signal, timeoutMs: null, ...requestOptions },
  );
  if (response.workflow !== "spatial-planning")
    throw new RequestError({ code: "invalid_response" });
  return response.result;
}

export async function closeSpatialPlanning(scope: string, sessionId: string) {
  try {
    await runSpatialPlanning(
      scope,
      { action: "close", session_id: sessionId },
      new AbortController().signal,
      { keepalive: true },
    );
  } catch (cause) {
    if (
      cause instanceof RequestError &&
      ["not_found", "household_scope_changed"].includes(cause.details.code)
    )
      return;
    throw cause;
  }
}

export async function readPlanningImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("请选择 JPEG、PNG 或 WebP 图片。");
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("图片读取失败。"));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(new Error("图片读取失败。")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
  const image = spatialPlanningInputSchema.options[1].shape.images
    .unwrap()
    .element.parse({
      type: "image",
      mime_type: file.type,
      data: url.slice(url.indexOf(",") + 1),
    });
  return { name: file.name, preview: url, image };
}
