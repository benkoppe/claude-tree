import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import packageJson from "../package.json" with { type: "json" }

export const releasePlatforms = ["linux-x64-glibc", "linux-arm64-glibc", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"] as const

export function releaseVersion(input = process.env.RELEASE_VERSION ?? packageJson.version): string {
  if (input.trim() !== input || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(input)) throw new Error("Expected SemVer without a v prefix or build metadata")
  if (input.split("-")[0]!.split(".").some((part) => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("Version numbers exceed SemVer's supported range")
  for (const part of input.split("-").slice(1).join("-").split(".")) {
    if (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) throw new Error("Numeric prerelease identifiers cannot have leading zeroes")
  }
  return input
}

export function releaseCompileTarget(platform: "linux" | "darwin", arch: "x64" | "arm64", libc?: "glibc" | "musl"): Bun.Build.CompileTarget {
  return `bun-${platform}-${arch}${arch === "x64" ? "-baseline" : ""}${platform === "linux" && libc === "musl" ? "-musl" : ""}` as Bun.Build.CompileTarget
}

export function launcherManifest(version: string) {
  return { name: packageJson.name, version: releaseVersion(version), description: packageJson.description,
    license: packageJson.license, repository: packageJson.repository, homepage: packageJson.homepage,
    bin: { "claude-tree": "bin/claude-tree.cjs" }, files: ["bin", "LICENSE", "README.md"], engines: { node: ">=20" },
    optionalDependencies: Object.fromEntries(releasePlatforms.map((platform) => [`@claude-tree/${platform}`, version])),
  }
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed (${result.exitCode})`)
  return result.stdout.toString().trim()
}

async function pack(directory: string): Promise<void> {
  const output = resolve("dist/packages")
  await mkdir(output, { recursive: true })
  console.log(run(["npm", "pack", directory, "--pack-destination", output, "--ignore-scripts", "--quiet"]))
}

async function buildLauncher(version: string): Promise<void> {
  const directory = resolve("dist/npm")
  await rm(directory, { recursive: true, force: true })
  await mkdir(join(directory, "bin"), { recursive: true })
  await cp("bin/claude-tree.cjs", join(directory, "bin/claude-tree.cjs"))
  await chmod(join(directory, "bin/claude-tree.cjs"), 0o755)
  for (const file of ["LICENSE", "README.md"]) await cp(file, join(directory, file))
  await Bun.write(join(directory, "package.json"), JSON.stringify(launcherManifest(version), null, 2) + "\n")
  await pack(directory)
}

async function buildPlatform(version: string): Promise<void> {
  const platform = process.platform
  const arch = process.arch
  if ((platform !== "linux" && platform !== "darwin") || (arch !== "x64" && arch !== "arm64")) throw new Error("Unsupported release platform")
  const libc = platform === "linux" ? (process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc") : undefined
  const suffix = `${platform}-${arch}${libc ? `-${libc}` : ""}`
  const directory = resolve("dist", suffix)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const nativePackage = `@opentui/core-${platform}-${arch}${libc === "musl" ? "-musl" : ""}`
  const nativeResolution = import.meta.resolve(nativePackage)
  const revision = process.env.BUILD_REVISION ?? run(["git", "rev-parse", "HEAD"])
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Expected a full Git revision")
  const buildMetadata = { revision, dirty: process.env.BUILD_REVISION ? process.env.BUILD_DIRTY !== "false" : run(["git", "status", "--porcelain"]).length > 0 }
  const compile = async (entrypoints: string[], outfile: string) => {
    const result = await Bun.build({ entrypoints, root: process.cwd(), target: "bun", minify: true,
      compile: { outfile, target: releaseCompileTarget(platform, arch, libc), autoloadDotenv: false, autoloadBunfig: false,
        ...(process.env.BUN_EXECUTABLE ? { executablePath: process.env.BUN_EXECUTABLE } : {}) },
      plugins: [{ name: "release-assets", setup(build) {
        build.onLoad({ filter: /[/\\]package\.json$/ }, (args) => args.path === resolve("package.json")
          ? { contents: JSON.stringify({ ...packageJson, version }), loader: "json" } : undefined)
        build.onLoad({ filter: /[/\\]build-metadata\.json$/ }, () => ({ contents: JSON.stringify(buildMetadata), loader: "json" }))
        build.onResolve({ filter: /^@opentui\/core-(linux|darwin|win32)-/ }, (args) => args.path === nativePackage
          ? { path: new URL(nativeResolution).pathname } : { path: args.path, namespace: "unsupported-native" })
        build.onLoad({ filter: /.*/, namespace: "unsupported-native" }, () => ({ contents: 'export default "";', loader: "js" }))
      } }],
    })
    if (!result.success) throw new AggregateError(result.logs, "Release compilation failed")
  }
  await compile(["src/cli.ts", "src/infrastructure/metadata/worker.ts", "src/infrastructure/providers/read-worker.ts", "src/infrastructure/projection/worker.ts", "src/infrastructure/search/worker.ts"], join(directory, "claude-tree"))
  await compile(["src/diagnostics/history-process.ts"], join(directory, "claude-tree-history"))
  await cp("src/infrastructure/metadata/migrations", join(directory, "migrations"), { recursive: true })
  for (const file of ["LICENSE", "THIRD_PARTY_LICENSES"]) await cp(file, join(directory, file))
  await cp("docs/distribution.md", join(directory, "BUILDING.md"))
  await Bun.write(join(directory, "build-metadata.json"), JSON.stringify(buildMetadata, null, 2) + "\n")
  const packageDirectories: string[] = []
  for (const entry of await readdir("node_modules")) {
    if (entry.startsWith(".")) continue
    if (entry.startsWith("@")) for (const child of await readdir(join("node_modules", entry))) packageDirectories.push(join("node_modules", entry, child))
    else packageDirectories.push(join("node_modules", entry))
  }
  for (const source of packageDirectories) {
    const manifest = await Bun.file(join(source, "package.json")).json()
    const destination = join(directory, "licenses", `${manifest.name.replaceAll("/", "--")}@${manifest.version}`)
    const notices = (await readdir(source)).filter((name) => /^(LICENSE|COPYING|NOTICE|AUTHORS|PATENTS)/i.test(name))
    if (notices.length) { await mkdir(destination, { recursive: true }); for (const notice of notices) await cp(join(source, notice), join(destination, notice), { recursive: true }) }
  }
  run(["tar", "-czf", join(directory, "source.tar.gz"), "src", "scripts", "bin", "docs", "test", ".github", "package.json", "bun.lock", "tsconfig.json", "drizzle.config.ts", "LICENSE", "THIRD_PARTY_LICENSES"])
  await Bun.write(join(directory, "package.json"), JSON.stringify({ name: `@claude-tree/${suffix}`, version,
    description: packageJson.description, license: packageJson.license, repository: packageJson.repository,
    os: [platform], cpu: [arch], ...(libc ? { libc: [libc] } : {}),
    files: ["claude-tree", "claude-tree-history", "migrations", "licenses", "source.tar.gz", "BUILDING.md", "build-metadata.json", "LICENSE", "THIRD_PARTY_LICENSES"],
  }, null, 2) + "\n")
  await pack(directory)
}

if (import.meta.main) {
  const version = releaseVersion()
  if (process.argv[2] === "--validate") console.log(version)
  else if (process.argv[2] === "--launcher") await buildLauncher(version)
  else if (process.argv.length > 2) throw new Error("Expected --validate, --launcher, or no arguments")
  else await buildPlatform(version)
}
