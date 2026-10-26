/* oxlint-disable turbo/no-undeclared-env-vars -- Docker supplies these variables; this script is not a Turbo task. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const day = 86_400_000;
const retentionDays = Number(process.env.LANGFUSE_RETENTION_DAYS);
if (!Number.isSafeInteger(retentionDays) || retentionDays < 3) {
  throw new Error("LANGFUSE_RETENTION_DAYS must be an integer of at least 3.");
}
const authorization = `Basic ${Buffer.from(
  `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
).toString("base64")}`;

async function observations(parameters) {
  const url = new URL(
    "/api/public/v2/observations",
    process.env.LANGFUSE_BASE_URL,
  );
  url.search = new URLSearchParams({
    fields: "core",
    limit: "100",
    ...parameters,
  });
  const response = await fetch(url, {
    headers: { authorization },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Observation query failed: ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result.data) || !result.meta) {
    throw new Error("Invalid observation response.");
  }
  return result;
}

async function clickhouse(query) {
  const url = new URL(process.env.CLICKHOUSE_URL);
  // Apply expiration during normal background merges instead of rewriting all existing parts.
  url.searchParams.set("materialize_ttl_after_modify", "0");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": "langfuse",
      "X-ClickHouse-Key": process.env.LANGFUSE_LOCAL_SECRET,
    },
    body: query,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `ClickHouse cleanup failed: ${response.status} ${await response.text()}`,
    );
  return response.text();
}

async function configureStorage() {
  execFileSync("mc", ["ilm", "import", "cleanup/langfuse"], {
    env: {
      ...process.env,
      MC_HOST_cleanup: `http://langfuse:${process.env.LANGFUSE_LOCAL_SECRET}@langfuse-minio:9000`,
    },
    input: JSON.stringify({
      Rules: [
        {
          ID: "home-agent-events-expiration",
          Status: "Enabled",
          Filter: { Prefix: "events/" },
          Expiration: { Days: retentionDays },
        },
      ],
    }),
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 120_000,
  });
  await clickhouse(
    `ALTER TABLE blob_storage_file_log MODIFY TTL toDateTime(created_at) + INTERVAL ${retentionDays} DAY DELETE`,
  );

  const logs = JSON.parse(
    await clickhouse(
      "SELECT DISTINCT table FROM system.columns WHERE database = 'system' AND endsWith(table, '_log') AND name = 'event_date' FORMAT JSON",
    ),
  );
  for (const { table } of logs.data) {
    if (!/^[a-z_]+$/.test(table))
      throw new Error("Unexpected system log table.");
    await clickhouse(
      `ALTER TABLE system.${table} MODIFY TTL event_date + INTERVAL 7 DAY DELETE`,
    );
  }
  console.info(
    `Storage configured: events ${retentionDays} days; system logs 7 days.`,
  );
}

async function cleanTraces() {
  const cutoff = new Date(Date.now() - retentionDays * day).toISOString();
  const checked = new Set();
  let cursor;
  let submitted = 0;
  do {
    const page = await observations({
      fromStartTime: "1970-01-01T00:00:00.000Z",
      toStartTime: cutoff,
      ...(cursor ? { cursor } : {}),
    });
    const candidates = new Set();
    for (const observation of page.data) {
      if (
        !observation.traceId ||
        !(Date.parse(observation.startTime) < Date.parse(cutoff))
      ) {
        throw new Error(
          "Observation is outside the requested expiration window.",
        );
      }
      if (!checked.has(observation.traceId))
        candidates.add(observation.traceId);
    }
    const traceIds = [...candidates];
    for (const id of traceIds) checked.add(id);

    // A trace can span the cutoff. Keep it if any observation started or ended recently.
    for (const column of ["startTime", "endTime"]) {
      if (!candidates.size) break;
      let recentCursor;
      do {
        const recent = await observations({
          filter: JSON.stringify([
            {
              type: "stringOptions",
              column: "traceId",
              operator: "any of",
              value: traceIds,
            },
            { type: "datetime", column, operator: ">=", value: cutoff },
          ]),
          ...(recentCursor ? { cursor: recentCursor } : {}),
        });
        for (const observation of recent.data)
          candidates.delete(observation.traceId);
        recentCursor = recent.meta.cursor;
      } while (recentCursor);
    }

    if (candidates.size) {
      const response = await fetch(
        new URL("/api/public/traces", process.env.LANGFUSE_BASE_URL),
        {
          method: "DELETE",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ traceIds: [...candidates] }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!response.ok)
        throw new Error(`Trace deletion failed: ${response.status}`);
      await response.arrayBuffer();
      submitted += candidates.size;
    }
    cursor = page.meta.cursor;
  } while (cursor);
  console.info(
    `Retention complete: cutoff ${cutoff}; ${submitted} traces submitted for deletion.`,
  );
}

await configureStorage();

while (true) {
  try {
    await cleanTraces();
    await writeFile("/tmp/last-success", new Date().toISOString());
    await setTimeout(day);
  } catch (error) {
    console.error("Langfuse cleanup failed:", error.message);
    await setTimeout(3_600_000);
  }
}
