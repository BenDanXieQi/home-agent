import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export async function audioResources() {
  const { stdout } = await execute(
    "ps",
    ["-axo", "pid=,ppid=,time=,rss=,comm="],
    { timeout: 2000 },
  );
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, time, rss, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        parent: Number(parent),
        cpuMs:
          time!
            .split(":")
            .reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000,
        rssMiB: Number(rss) / 1024,
        command: command.join(" "),
      };
    });
  const owned = new Set([process.pid]);
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
  };
}
