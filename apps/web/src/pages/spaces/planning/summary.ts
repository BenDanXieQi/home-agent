import type { compareLayout } from "../../../modules/spatial/layout";

export function changeSummary(
  counts: ReturnType<typeof compareLayout>["counts"],
) {
  return [
    counts.created ? `新增 ${counts.created}` : "",
    counts.changed ? `修改 ${counts.changed}` : "",
    counts.removed ? `删除 ${counts.removed}` : "",
  ]
    .filter(Boolean)
    .join("、");
}
