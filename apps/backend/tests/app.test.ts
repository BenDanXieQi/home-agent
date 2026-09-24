import { expect, test } from "bun:test";
import { healthSchema } from "@home-agent/contracts";
import { createApp } from "../src/app";

test("health endpoint matches the shared browser contract", async () => {
  const response = await createApp().request("/api/health");
  expect(response.status).toBe(200);
  expect(healthSchema.parse(await response.json()).runtime).toBe("bun");
});

test("unknown API routes return JSON 404 with static hosting enabled", async () => {
  const response = await createApp("./dist/public").request("/api/missing");
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toContain("application/json");
});
