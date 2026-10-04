import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve, join } from "node:path"

const libc = process.platform === "linux" ? (process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc") : undefined
const directory = resolve("dist", `${process.platform}-${process.arch}${libc ? `-${libc}` : ""}`)
await mkdir("/tmp/opencode", { recursive: true })
const temporary = await realpath(await mkdtemp("/tmp/opencode/release-test-"))
try {
  const project = join(temporary, "project"); const provider = join(temporary, "claude")
  await mkdir(project); await mkdir(provider)
  const env = { ...process.env, XDG_STATE_HOME: join(temporary, "state"), CLAUDE_CONFIG_DIR: provider, PATH: join(temporary, "no-bun") }
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`)
    return stdout
  }
  const cli = join(directory, "claude-tree")
  if (!(await run([cli, "--version"])).includes("claude-tree")) throw new Error("Compiled version failed")
  await run([cli, "--help"])
  let screen = ""
  let sentQuit = false
  const interactive = Bun.spawn([cli, project], { env: { ...env, TERM: "xterm-256color" }, terminal: {
    cols: 80, rows: 24, data(terminal, data) {
      screen += new TextDecoder().decode(data)
      const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      if (!sentQuit && plain.includes("quit")) { sentQuit = true; terminal.write("q") }
    },
  } })
  const interactiveTimeout = setTimeout(() => interactive.kill(), 10_000)
  try {
    if (await interactive.exited !== 0 || !sentQuit) throw new Error(`Compiled interactive terminal smoke failed: ${screen.slice(-1500)}`)
  } finally { clearTimeout(interactiveTimeout); interactive.terminal?.close() }
  const built = await Bun.build({ root: process.cwd(), entrypoints: ["test/next/helpers/release-smoke.ts", "src/infrastructure/metadata/worker.ts", "src/infrastructure/providers/read-worker.ts", "src/infrastructure/projection/worker.ts"],
    compile: { outfile: join(directory, "release-smoke"), autoloadDotenv: false, autoloadBunfig: false } })
  if (!built.success) throw new AggregateError(built.logs, "Smoke executable compilation failed")
  await run([join(directory, "release-smoke"), project])
  await run([cli, "state", "check"])
  const exported = JSON.parse(await run([cli, "state", "export", project]))
  if (!exported.navigations.length) throw new Error("Compiled export lost metadata")
  await run([cli, "state", "backup", join(temporary, "backup.sqlite")])
  const diagnostic = JSON.parse(await run([cli, "--diagnose-history", "00000000-0000-4000-8000-000000000000", project]))
  if (JSON.stringify(diagnostic).includes("worker-failed")) throw new Error("Compiled diagnostic subprocess failed")
  await run([process.execPath, "scripts/package-npm.ts"])
  const node = Bun.which("node"); const npm = Bun.which("npm")
  if (!node || !npm) throw new Error("Release installation tests require Node and npm")
  const npmCli = await realpath(npm)
  const pack = async (path: string) => {
    const packed = JSON.parse(await run([node, npmCli, "pack", path, "--pack-destination", temporary, "--json", "--ignore-scripts"]))
    return join(temporary, packed[0].filename)
  }
  const nativeArchive = await pack(directory)
  const launcherArchive = await pack(resolve("dist/npm"))
  const prefix = join(temporary, "global")
  await run([node, npmCli, "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", nativeArchive, launcherArchive])
  const launcher = join(prefix, "lib/node_modules/claude-tree/bin/claude-tree.cjs")
  await run([node, launcher, "--version"])
  await run([node, launcher, "state", "check"])
  console.log("Release executable, workers, SQLite, backup, export, and diagnostics passed without Bun on PATH")
} finally {
  await rm(temporary, { recursive: true, force: true })
  await rm(join(directory, "release-smoke"), { force: true })
}
