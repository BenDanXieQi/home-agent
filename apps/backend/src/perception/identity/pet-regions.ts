import type { z } from "zod";
import type { enrollmentCommandSchema } from "./enrollment-protocol";
import { iou } from "../tracking/assignment";

// Validate the entire photo before selecting its one inference target.
export function selectPetPhotoRegions(
  regions: Extract<
    z.infer<typeof enrollmentCommandSchema>,
    { kind: "identity_extract" }
  >["regions"],
  className: "cat" | "dog",
) {
  const selected = regions.filter((region) => region.className === className);
  if (selected.length !== 1)
    return {
      regions: [],
      reason: selected.length
        ? "照片中有多只同类宠物，请上传仅包含一只的照片"
        : "未检测到该物种的宠物",
    };
  const target = selected[0]!;
  const box = target.measuredBox;
  if (
    !box ||
    regions.some(
      (other) =>
        other.trackId !== target.trackId &&
        other.className !== "human" &&
        other.measuredBox &&
        iou(box, other.measuredBox) > 0,
    )
  )
    return {
      regions: [],
      reason: "宠物被其他动物遮挡，请上传清晰且无遮挡的照片",
    };
  return { regions: selected, reason: null };
}
