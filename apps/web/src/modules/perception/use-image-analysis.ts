import { useEffect, useRef, useState } from "react";
import { RequestError } from "../../api/errors";
import { analyzeImage, prepareAnalysisImage } from "./image-analysis";
import { errorMessage } from "../../messages/zh-CN";

function failureMessage(cause: unknown) {
  if (cause instanceof RequestError) {
    return errorMessage(cause.details);
  }
  if (cause instanceof DOMException)
    return "无法读取图片，请选择浏览器支持的图片格式。";
  return cause instanceof Error ? cause.message : "无法准备图片，请重新选择。";
}

export function useImageAnalysis() {
  const [image, setImage] =
    useState<Awaited<ReturnType<typeof prepareAnalysisImage>>>();
  const [result, setResult] =
    useState<Awaited<ReturnType<typeof analyzeImage>>>();
  const [pending, setPending] = useState<
    | { stage: "preparing"; action: "select" | "replace" }
    | {
        stage: "analyzing";
        action: "select" | "replace" | "retry" | "analyze";
      }
    | null
  >(null);
  const [error, setError] = useState<string>();
  const ownedImage = useRef(image);
  const controller = useRef<AbortController | null>(null);
  const preparing = useRef<ReturnType<typeof prepareAnalysisImage> | null>(
    null,
  );

  function releaseImage() {
    if (ownedImage.current) URL.revokeObjectURL(ownedImage.current.url);
    ownedImage.current = undefined;
    setImage(undefined);
    setResult(undefined);
  }

  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      if (ownedImage.current) URL.revokeObjectURL(ownedImage.current.url);
      ownedImage.current = undefined;
    },
    [],
  );

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setPending(null);
    setError(undefined);
  }

  function clear() {
    cancel();
    releaseImage();
  }

  async function analyze(file?: File) {
    if (!file && (controller.current || !ownedImage.current)) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const selectionAction = ownedImage.current ? "replace" : "select";
    const action = file ? selectionAction : error ? "retry" : "analyze";
    if (file) releaseImage();
    setResult(undefined);
    setError(undefined);
    setPending(
      file
        ? { stage: "preparing", action: selectionAction }
        : { stage: "analyzing", action },
    );
    let preparation: ReturnType<typeof prepareAnalysisImage> | undefined;
    try {
      let submitted = ownedImage.current;
      if (file) {
        // Native preparation drains before only the latest selection proceeds.
        if (preparing.current) await Promise.allSettled([preparing.current]);
        current.signal.throwIfAborted();
        preparation = prepareAnalysisImage(file, current.signal);
        preparing.current = preparation;
        const prepared = await preparation;
        if (current.signal.aborted) {
          URL.revokeObjectURL(prepared.url);
          return;
        }
        ownedImage.current = prepared;
        setImage(prepared);
        submitted = prepared;
        if (preparing.current === preparation) preparing.current = null;
      }
      if (!submitted) return;
      current.signal.throwIfAborted();
      setPending({ stage: "analyzing", action });
      const response = await analyzeImage(submitted.blob, current.signal);
      if (controller.current !== current || current.signal.aborted) return;
      if (
        response.width !== submitted.width ||
        response.height !== submitted.height
      )
        throw new RequestError({ code: "invalid_response" });
      setResult(response);
    } catch (cause) {
      if (controller.current !== current || current.signal.aborted) return;
      if (
        cause instanceof RequestError &&
        cause.details.code === "local_access_required"
      )
        releaseImage();
      setError(failureMessage(cause));
    } finally {
      if (preparing.current === preparation) preparing.current = null;
      if (controller.current === current) {
        controller.current = null;
        setPending(null);
      }
    }
  }

  return { image, result, pending, error, analyze, cancel, clear };
}
