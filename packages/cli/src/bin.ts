#!/usr/bin/env node
import { main } from "./main.js";

// Handler errors point at the project's sources, through the bundle's source map.
process.setSourceMapsEnabled(true);

const controller = new AbortController();
let stopping = false;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    if (stopping) process.exit(130); // a second signal: stop now
    stopping = true;
    process.stderr.write("stopping (again to force)\n");
    controller.abort();
  });
}

// JSON lines for log shippers (CloudWatch, Loki): TIDEMARK_LOG_FORMAT=json.
const json = process.env.TIDEMARK_LOG_FORMAT === "json";
const io = {
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) =>
    process.stderr.write(
      json
        ? `${JSON.stringify({ time: new Date().toISOString(), level: /^error\b|failed|stopped:/.test(line) ? "error" : "info", msg: line })}\n`
        : `${line}\n`,
    ),
};

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal, io });
