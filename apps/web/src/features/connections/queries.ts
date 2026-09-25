import { queryOptions } from "@tanstack/react-query";
import {
  configResponseSchema,
  servicesStatusSchema,
  healthSchema,
} from "@home-agent/api/contracts";
import { requestJson } from "../../lib/api";

export const serviceConfigQueryOptions = queryOptions({
  queryKey: ["config"],
  queryFn: ({ signal }) =>
    requestJson(
      (client, options) => client.api.config.$get({}, options),
      configResponseSchema,
      { signal },
    ),
});
export const serviceStatusQueryOptions = queryOptions({
  queryKey: ["services"],
  queryFn: ({ signal }) =>
    requestJson(
      (client, options) => client.api.services.status.$get({}, options),
      servicesStatusSchema,
      { signal },
    ),
});
export const backendHealthQueryOptions = queryOptions({
  queryKey: ["health"],
  queryFn: ({ signal }) =>
    requestJson(
      (client, options) => client.api.health.$get({}, options),
      healthSchema,
      {
        signal,
      },
    ),
  refetchInterval: 30_000,
});
