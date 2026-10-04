#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");

const platform = process.platform;
const arch = process.arch;
if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
  console.error(`claude-tree: unsupported platform ${platform}/${arch}`);
  process.exit(1);
}
let libc;
if (platform === "linux") {
  const report = process.report?.getReport();
  libc = report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}
const suffix = `${platform}-${arch}${libc ? `-${libc}` : ""}`;
let executable;
try {
  executable = join(dirname(require.resolve(`@claude-tree/${suffix}/package.json`)), "claude-tree");
} catch {
  console.error(`claude-tree: missing platform package @claude-tree/${suffix}. Reinstall with optional dependencies enabled.`);
  process.exit(1);
}
const child = spawn(executable, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, ...(libc ? { OPENTUI_LIBC: libc } : {}) } });
const handlers = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  handlers.set(signal, handler);
  process.on(signal, handler);
}
child.on("error", (error) => { console.error(`claude-tree: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
