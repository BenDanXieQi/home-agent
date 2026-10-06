import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { automationReviewRunSchema } from "@home-agent/api/automation-reviews";
import { requestJson } from "../../api/client";
const reviewRunsSchema = z.object({
  items: z.array(automationReviewRunSchema),
});
export function reviewRunsOptions(scope: string, id: string) {
  return queryOptions({
    queryKey: ["automation-review-runs", scope, id],
    queryFn: ({ signal }) =>
      requestJson(
        (api, options) =>
          api.api.household.automations.reviews.runs.$post(
            { json: { scope_epoch: scope, automation_id: id, limit: 30 } },
            options,
          ),
        reviewRunsSchema,
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: 10_000,
  });
}
