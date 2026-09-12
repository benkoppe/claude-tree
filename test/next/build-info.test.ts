import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test.each([true, false])("installed build identity uses its stamp and never a surrounding project's git repository (stamped: %s)", async (stamped) => {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-build-info-"))
  const revision = "1234567890abcdef1234567890abcdef12345678"
  try {
    await mkdir(join(root, "src"))
    await copyFile(join(import.meta.dir, "../../src/build-info.ts"), join(root, "src/build-info.ts"))
    await writeFile(join(root, "src/program.ts"), 'export const PROGRAM_VERSION = "0.1.0"\n')
    await writeFile(join(root, "src/build-metadata.json"), JSON.stringify({ revision: stamped ? revision : null, dirty: stamped ? false : null }))
    const script = `import { Effect } from "effect"; import { readBuildInfo } from ${JSON.stringify(join(root, "src/build-info.ts"))}; console.log(JSON.stringify(await Effect.runPromise(readBuildInfo)));`
    // Resolve Effect from this repo while leaving the installed package outside
    // it. A cwd-based git lookup would incorrectly report this repo's HEAD.
    const nodeModules = join(import.meta.dir, "../../node_modules")
    await symlink(nodeModules, join(root, "node_modules"))
    const process = Bun.spawn([globalThis.process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../.."), env: { ...globalThis.process.env, NODE_PATH: nodeModules }, stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ version: "0.1.0", revision: stamped ? revision : null, dirty: stamped ? false : null, source: stamped ? "embedded" : "unknown" })
  } finally { await rm(root, { recursive: true, force: true }) }
})
