import type { z } from "zod";
import type { InferRequestType } from "hono/client";
import {
  agentWorkflowStreamContracts,
  type BackendClient,
} from "@home-agent/backend-client";
import { requestOperationStream } from "../../api/client";
import { RequestError } from "../../api/errors";

export async function runSpatialPlanning(
  scope: string,
  input: Exclude<
    Extract<
      InferRequestType<BackendClient["api"]["workflows"]["$post"]>["json"],
      { workflow: "spatial-planning" }
    >["input"],
    { action: "close" }
  >,
  signal: AbortSignal,
  receive?: (
    progress: z.infer<
      (typeof agentWorkflowStreamContracts)["spatial-planning"]["progress"]
    >["progress"],
  ) => void | Promise<void>,
) {
  const response = await requestOperationStream(
    (api, options) =>
      api.api.workflows.$post(
        {
          json: { scope_epoch: scope, workflow: "spatial-planning", input },
        },
        options,
      ),
    agentWorkflowStreamContracts["spatial-planning"],
    {
      signal,
      receive: receive ? ({ progress }) => receive(progress) : undefined,
    },
  );
  if (response.result.status === "closed")
    throw new RequestError({ code: "invalid_response" });
  return response.result;
}

export async function closeSpatialPlanning(scope: string, sessionId: string) {
  try {
    await requestOperationStream(
      (api, options) =>
        api.api.workflows.$post(
          {
            json: {
              scope_epoch: scope,
              workflow: "spatial-planning",
              input: { action: "close", session_id: sessionId },
            },
          },
          options,
        ),
      agentWorkflowStreamContracts["spatial-planning"],
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

export const planningImageTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const planningImageLimit = 4;

export async function readPlanningImage(file: File) {
  const mimeType = planningImageTypes.find((type) => type === file.type);
  if (!mimeType) throw new Error("请选择 JPEG、PNG 或 WebP 图片。");
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
  const data = url.slice(url.indexOf(",") + 1);
  if (!data) throw new Error("图片读取失败。");
  const image = { type: "image" as const, mime_type: mimeType, data };
  return { name: file.name, preview: url, image };
}
