#!/usr/bin/env node
// Run the backend checks (tools/check_backend.py) with the project's Python.
//
//   node tools/check-backend.mjs [name filter]
//
// `npm run check` is the one command before every push, and it runs from node,
// so this finds the interpreter the backend really runs under: the venv that
// start.bat creates, then whatever Python is on PATH. The venv comes first
// because that is where fastapi and uvicorn are installed; a system Python
// usually lacks them, and the harness says so plainly if it does.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// A server that never starts or a request that never returns must end the
// check, not hang the push.
const TIMEOUT_S = 180;

const inVenv = [
  path.join(ROOT, ".venv", "Scripts", "python.exe"),  // Windows
  path.join(ROOT, ".venv", "bin", "python"),          // everything else
].find(p => fs.existsSync(p));

// On PATH, a name only counts if it runs: on Windows "python" can be the
// Microsoft Store alias, which exists but prints an install hint and fails.
const onPath = () => ["python", "python3"].find(cmd =>
  spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0);

const python = inVenv ?? onPath();
if (!python) {
  console.error("  FAIL  backend checks: no Python found. Looked for .venv/Scripts/python.exe, .venv/bin/python,");
  console.error("        and python or python3 on PATH. Run start.bat once to create .venv, or install Python 3.10+.");
  process.exit(1);
}

console.log(`backend checks with ${python}`);
const run = spawnSync(python, ["-u", path.join(HERE, "check_backend.py"), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  timeout: TIMEOUT_S * 1000,
});
if (run.error?.code === "ETIMEDOUT") {
  // Python did start: it ran, then hung, and spawnSync killed it.
  console.error(`  FAIL  backend checks did not finish within ${TIMEOUT_S} s (the server or a route hung).`);
  console.error("        The last ok line above is the last test that finished; run one test alone with");
  console.error("        npm run check:backend -- <part of its name>");
  process.exit(1);
}
if (run.error) {
  console.error(`  FAIL  backend checks: could not run ${python}: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
