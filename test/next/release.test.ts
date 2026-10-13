import { expect, test } from "bun:test"
import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { checkNpmVersion, launcherManifest, platformPackageName, releaseCompileTarget, releasePlatforms, releaseVersion } from "../../scripts/build-release"
import { PROGRAM_NAME, PROGRAM_VERSION } from "../../src/program"

test("release versions are validated before becoming tags or filenames", () => {
  for (const input of ["0.0.0", "1.2.3", "1.2.3-beta.1", "1.2.3-rc-build.2"]) expect(releaseVersion(input)).toBe(input)
  for (const input of ["", "v1.2.3", "1.2", "01.2.3", "1.2.3+build", "1.2.3-beta.01", "1.2.3-", "../1.2.3", "1.2.3\n", "1.2.3;exit", "1.2.3-foo_bar"]) {
    expect(() => releaseVersion(input)).toThrow()
  }
})

test("x64 releases use baseline CPU targets", () => {
  expect(releaseCompileTarget("darwin", "x64")).toBe("bun-darwin-x64-baseline")
  expect(releaseCompileTarget("linux", "x64", "glibc")).toBe("bun-linux-x64-baseline")
  expect(releaseCompileTarget("linux", "x64", "musl")).toBe("bun-linux-x64-baseline-musl")
  expect(releaseCompileTarget("linux", "arm64", "musl")).toBe("bun-linux-arm64-musl")
})

test("launcher dependencies cover all platforms with exact versions and no install scripts", () => {
  const manifest = launcherManifest("0.2.0")
  expect(manifest.name).toBe("@benkoppe/claude-tree")
  expect(manifest.version).toBe("0.2.0")
  expect(manifest.bin).toEqual({ "claude-tree": "bin/claude-tree.cjs" })
  expect(manifest.engines).toEqual({ node: ">=20" })
  expect(manifest).not.toHaveProperty("private")
  expect(Object.keys(manifest.optionalDependencies)).toHaveLength(5)
  expect(manifest.optionalDependencies).not.toHaveProperty("@benkoppe/claude-tree-darwin-x64")
  for (const platform of releasePlatforms) expect(manifest.optionalDependencies[`@benkoppe/claude-tree-${platform}`]).toBe("0.2.0")
  expect(manifest).not.toHaveProperty("scripts")
})

test("application identity stays independent of the scoped npm name", async () => {
  const manifest = await Bun.file("package.json").json()
  expect(manifest.name).toBe("@benkoppe/claude-tree")
  expect(manifest.private).toBeTrue()
  expect(PROGRAM_NAME).toBe("claude-tree")
  expect(PROGRAM_VERSION).toBe(manifest.version)
})

test("npm preflight rejects published versions and backwards stable releases", () => {
  expect(() => checkNpmVersion("@benkoppe/claude-tree-linux-x64-glibc", "0.1.0", { versions: ["0.1.0"] })).toThrow("already published")
  expect(() => checkNpmVersion("@benkoppe/claude-tree", "0.1.0", { versions: "0.1.0" })).toThrow("already published")
  expect(() => checkNpmVersion("@benkoppe/claude-tree", "0.1.0", { "dist-tags": { latest: "0.2.0" } })).toThrow("Refusing to move latest")
  checkNpmVersion("@benkoppe/claude-tree", "0.3.0", { versions: ["0.2.0"], "dist-tags": { latest: "0.2.0" } })
  checkNpmVersion("@benkoppe/claude-tree", "0.1.0-beta.1", { "dist-tags": { latest: "0.2.0" } })
  checkNpmVersion("@benkoppe/claude-tree", "0.1.0", {})
})

async function createLauncherFixture(directory: string, executableContents?: string) {
  await mkdir(join(directory, "bin"))
  await cp("bin/claude-tree.cjs", join(directory, "bin/claude-tree.cjs"))
  await writeFile(join(directory, "package.json"), JSON.stringify(launcherManifest("0.1.0")))
  const platform = Bun.spawnSync(["node", "-e", `
    const libc = process.platform === "linux"
      ? (process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl") : undefined;
    const suffix = [process.platform, process.arch, libc].filter(Boolean).join("-");
    console.log(JSON.stringify({ suffix, libc }));
  `], { stdout: "pipe", stderr: "pipe" })
  expect(platform.exitCode).toBe(0)
  const { suffix, libc } = JSON.parse(platform.stdout.toString()) as { suffix: typeof releasePlatforms[number]; libc?: string }
  const packageName = platformPackageName(suffix)
  if (executableContents !== undefined) {
    const dependency = join(directory, "node_modules", packageName)
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: packageName, version: "0.1.0" }))
    await writeFile(join(dependency, "claude-tree"), executableContents, { mode: 0o755 })
  }
  return { command: join(directory, "bin/claude-tree.cjs"), packageName, libc }
}

test.each([true, false])("Node launcher resolves scoped platform packages and explains missing dependencies (installed=%s)", async (installed) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-launcher-"))
  try {
    const { command, packageName, libc } = await createLauncherFixture(directory, installed ? '#!/bin/sh\nprintf "%s\\n" "$OPENTUI_LIBC" "$@"\nexit 7\n' : undefined)
    const child = Bun.spawn(["node", command, "--example", "argument with spaces"], {
      env: { ...process.env, OPENTUI_LIBC: "inherited", NODE_PATH: "" }, stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (installed) {
      expect(code).toBe(7)
      expect(stdout).toBe(`${libc ?? "inherited"}\n--example\nargument with spaces\n`)
      expect(stderr).toBe("")
    } else {
      expect(code).toBe(1)
      expect(stdout).toBe("")
      expect(stderr).toBe(`claude-tree: missing platform package ${packageName}. Reinstall with optional dependencies enabled.\n`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test.each(["parent", "group"])("launcher forwards each shutdown signal once and preserves a deliberate second signal (%s)", async (target) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-signals-"))
  try {
    const { command } = await createLauncherFixture(directory, `#!/usr/bin/env node
      let count = 0;
      process.on("SIGINT", () => {
        console.log("INT " + ++count);
        if (count === 2) process.exit(7);
      });
      console.log("READY " + process.pid);
      setInterval(() => {}, 1000);
    `)
    const driver = `
      const assert = require("node:assert/strict");
      const { spawn } = require("node:child_process");
      const { createInterface } = require("node:readline");
      const launcher = spawn("node", [process.argv[1]], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
      const lines = createInterface({ input: launcher.stdout })[Symbol.asyncIterator]();
      const exited = new Promise(resolve => launcher.on("exit", resolve));
      let childPid;
      const cleanup = () => {
        for (const pid of [childPid, launcher.pid]) {
          if (pid) try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      };
      const watchdog = setTimeout(() => { cleanup(); process.exit(1); }, 3000);
      (async () => {
        try {
          const ready = (await lines.next()).value;
          assert.match(ready, /^READY /);
          childPid = Number(ready.split(" ")[1]);
          // Its own process group prevents direct + forwarded duplicate delivery.
          process.kill(-childPid, 0);
          for (let count = 1; count <= 2; count++) {
            process.kill(process.argv[2] === "group" ? -launcher.pid : launcher.pid, "SIGINT");
            assert.equal((await lines.next()).value, "INT " + count);
          }
          assert.equal(await exited, 7);
        } finally { clearTimeout(watchdog); cleanup(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    const child = Bun.spawn(["node", "-e", driver, command, target], { stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("release workflow stays dispatch-only and publishes the launcher after platform packages", async () => {
  const workflow = await Bun.file(".github/workflows/release.yml").text()
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).not.toMatch(/^  (push|pull_request|schedule|release):/m)
  expect(workflow).not.toMatch(/smoke|test:release|nix build|nix run|nix flake|staging|SHA256SUMS|gh release/)
  expect(workflow).toContain("needs: build")
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow).toContain("      id-token: write")
  expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/)
  const publishLauncher = 'npm publish "dist/packages/benkoppe-claude-tree-$RELEASE_VERSION.tgz"'
  expect(workflow).toContain(publishLauncher)
  expect(workflow).toContain('packages=(dist/packages/benkoppe-claude-tree-{darwin,linux}-*-"$RELEASE_VERSION".tgz)')
  expect(workflow).toContain('test "${#packages[@]}" -eq 5')
  expect(workflow).not.toContain("macos-15-intel")
  expect(workflow.indexOf("bun run build:release --preflight")).toBeGreaterThan(-1)
  expect(workflow.indexOf("bun run build:release --preflight")).toBeLessThan(workflow.indexOf('for package in "${packages[@]}"'))
  expect(workflow.indexOf('for package in "${packages[@]}"')).toBeLessThan(workflow.indexOf(publishLauncher))
  expect(workflow.indexOf('git tag "v$RELEASE_VERSION"')).toBeGreaterThan(workflow.indexOf(publishLauncher))
})
