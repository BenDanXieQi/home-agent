import { messageParamsSchema } from "./errors";
import { z } from "zod";

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("home-agent-backend"),
  runtime: z.literal("bun"),
  timestamp: z.iso.datetime(),
});

export type Health = z.infer<typeof healthSchema>;

const serviceRootUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .regex(/^https?:\/\/[^/?#@\\\s]+\/?$/i)
  .describe("HTTP(S) 服务根地址，不含凭据、路径前缀、query 或 fragment");

// One definition owns the fields and defaults. Only first-time creation applies
// defaults; both YAML and HTTP input must supply every field explicitly.
export const serviceConfigurationWithDefaults = z.strictObject({
  services: z.strictObject({
    agent: z.strictObject({
      url: serviceRootUrl.default("http://127.0.0.1:1811"),
    }),
    go2rtc: z.strictObject({
      url: serviceRootUrl.default("http://127.0.0.1:1984"),
    }),
  }),
});

const serviceDefinitions = serviceConfigurationWithDefaults.shape.services;
export const serviceConfigurationSchema =
  serviceConfigurationWithDefaults.extend({
    services: serviceDefinitions.extend({
      agent: serviceDefinitions.shape.agent.extend({
        url: serviceDefinitions.shape.agent.shape.url.unwrap(),
      }),
      go2rtc: serviceDefinitions.shape.go2rtc.extend({
        url: serviceDefinitions.shape.go2rtc.shape.url.unwrap(),
      }),
    }),
  });

export const configResponseSchema = z.object({
  config: serviceConfigurationSchema,
  writable: z.boolean(),
  path: z.string(),
});

export const connectionReasonCodeSchema = z.enum([
  "reachable",
  "unreachable",
  "http_error",
  "invalid_json",
  "empty_response",
  "response_too_large",
  "unexpected_response",
  "cancelled",
  "timeout",
]);
export type ConnectionReasonCode = z.infer<typeof connectionReasonCodeSchema>;

export const serviceStatusSchema = z.object({
  url: serviceRootUrl,
  status: z.enum(["connected", "unavailable"]),
  checkedAt: z.iso.datetime(),
  reasonCode: connectionReasonCodeSchema,
  params: messageParamsSchema.optional(),
});

export const servicesStatusSchema = z.object({
  services: z.object({
    agent: serviceStatusSchema,
    go2rtc: serviceStatusSchema,
  }),
});

export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
export type ConfigResponse = z.infer<typeof configResponseSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ServicesStatus = z.infer<typeof servicesStatusSchema>;
export * from "./errors";
