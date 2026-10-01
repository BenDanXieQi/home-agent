import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

function parseProcess(line: string) {
  const [pid, parent, group, weekday, month, day, clock, year, time, rss, ...command] =
    line.trim().split(/\s+/);
  return {
    pid: Number(pid),
    parent: Number(parent),
    group: Number(group),
    startedAt: [weekday, month, day, clock, year].join(" "),
    cpuMs:
      time!
        .split(":")
        .reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000,
    rssMiB: Number(rss) / 1024,
    command: command.join(" "),
  };
}

export async function audioResources(
  observed: ReadonlyMap<number, ReturnType<typeof parseProcess>> = new Map(),
) {
  const { stdout } = await execute(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,lstart=,time=,rss=,comm="],
    { timeout: 2000, env: { ...process.env, LC_ALL: "C" } },
  );
  const rows = stdout.trim().split("\n").map(parseProcess);
  const owned = new Set([process.pid]);
  for (const row of rows) {
    const previous = observed.get(row.pid);
    // Reparenting preserves identity; a reused PID or process group is not enough.
    if (
      previous?.startedAt === row.startedAt &&
      previous.group === row.group
    )
      owned.add(row.pid);
  }
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    for (const row of rows)
      if (
        owned.has(row.parent) &&
        !row.command.endsWith("/ps") &&
        row.command !== "ps"
      )
        owned.add(row.pid);
  }
  const processes = rows.filter((row) => owned.has(row.pid));
  return {
    rssMiB: processes.reduce((sum, row) => sum + row.rssMiB, 0),
    cpuMs: processes.reduce((sum, row) => sum + row.cpuMs, 0),
    processes: processes.length,
    members: processes,
  };
}
