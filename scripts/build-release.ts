import { cp, mkdir, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import packageJson from "../package.json" with { type: "json" }

const platform = process.platform
const arch = process.arch
if ((platform !== "linux" && platform !== "darwin") || (arch !== "x64" && arch !== "arm64")) throw new Error("Unsupported release platform")
const libc = platform === "linux" ? (process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc") : undefined
const suffix = `${platform}-${arch}${libc ? `-${libc}` : ""}`
const directory = resolve("dist", suffix)
await mkdir(directory, { recursive: true })
const nativePackage = `@opentui/core-${platform}-${arch}${libc === "musl" ? "-musl" : ""}`
const nativeResolution = import.meta.resolve(nativePackage)
const buildMetadata = (() => {
  if (process.env.BUILD_REVISION) {
    if (!/^[0-9a-f]{40}$/.test(process.env.BUILD_REVISION)) throw new Error("BUILD_REVISION must be a full Git revision")
    return { revision: process.env.BUILD_REVISION, dirty: process.env.BUILD_DIRTY !== "false" }
  }
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
  if (revision.exitCode !== 0) throw new Error("Release builds require a Git checkout or BUILD_REVISION")
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe" })
  if (status.exitCode !== 0) throw new Error("Could not determine release build status")
  return { revision: revision.stdout.toString().trim(), dirty: status.stdout.length > 0 }
})()
const target = (platform === "darwin" ? `bun-darwin-${arch}` : `bun-linux-${arch}${libc === "musl" ? "-musl" : ""}`) as Bun.Build.CompileTarget
const compile = async (entrypoints: string[], outfile: string) => {
  const result = await Bun.build({ entrypoints, root: process.cwd(), target: "bun", minify: true,
    compile: { outfile, target, autoloadDotenv: false, autoloadBunfig: false,
      ...(process.env.BUN_EXECUTABLE ? { executablePath: process.env.BUN_EXECUTABLE } : {}) },
    plugins: [{ name: "release-native-target", setup(build) {
      build.onLoad({ filter: /[/\\]build-metadata\.json$/ }, () => ({ contents: JSON.stringify(buildMetadata), loader: "json" }))
      build.onResolve({ filter: /^@opentui\/core-(linux|darwin|win32)-/ }, (args) => args.path === nativePackage
        ? { path: new URL(nativeResolution).pathname } : { path: args.path, namespace: "unsupported-native" })
      build.onLoad({ filter: /.*/, namespace: "unsupported-native" }, () => ({ contents: 'export default "";', loader: "js" }))
    } }],
  })
  if (!result.success) throw new AggregateError(result.logs, "Release compilation failed")
}
await compile(["src/cli.ts", "src/infrastructure/metadata/worker.ts", "src/infrastructure/providers/read-worker.ts", "src/infrastructure/projection/worker.ts"], join(directory, "claude-tree"))
await compile(["src/diagnostics/history-process.ts"], join(directory, "claude-tree-history"))
await cp("src/infrastructure/metadata/migrations", join(directory, "migrations"), { recursive: true })
await cp("LICENSE", join(directory, "LICENSE"))
await cp("THIRD_PARTY_LICENSES", join(directory, "THIRD_PARTY_LICENSES"))
await cp("docs/distribution.md", join(directory, "BUILDING.md"))
await Bun.write(join(directory, "build-metadata.json"), JSON.stringify(buildMetadata, null, 2) + "\n")
const licenseDirectory = join(directory, "licenses")
await mkdir(licenseDirectory, { recursive: true })
const packageDirectories: string[] = []
for (const entry of await readdir("node_modules")) {
  if (entry.startsWith(".")) continue
  if (entry.startsWith("@")) for (const child of await readdir(join("node_modules", entry))) packageDirectories.push(join("node_modules", entry, child))
  else packageDirectories.push(join("node_modules", entry))
}
for (const source of packageDirectories) {
  const manifest = await Bun.file(join(source, "package.json")).json()
  const destination = join(licenseDirectory, `${manifest.name.replaceAll("/", "--")}@${manifest.version}`)
  const notices = (await readdir(source)).filter((name) => /^(LICENSE|COPYING|NOTICE|AUTHORS|PATENTS)/i.test(name))
  if (notices.length) { await mkdir(destination, { recursive: true }); for (const notice of notices) await cp(join(source, notice), join(destination, notice), { recursive: true }) }
}
const archive = Bun.spawnSync(["tar", "-czf", join(directory, "source.tar.gz"), "src", "scripts", "bin", "docs", "test", "package.json", "bun.lock", "tsconfig.json", "drizzle.config.ts", "LICENSE", "THIRD_PARTY_LICENSES"], { stderr: "pipe" })
if (archive.exitCode !== 0) throw new Error(`Source archive failed: ${archive.stderr.toString()}`)
await Bun.write(join(directory, "package.json"), JSON.stringify({ name: `@claude-tree/${suffix}`, version: packageJson.version,
  description: packageJson.description, license: packageJson.license, os: [platform], cpu: [arch], ...(libc ? { libc: [libc] } : {}),
  files: ["claude-tree", "claude-tree-history", "migrations", "licenses", "source.tar.gz", "BUILDING.md", "build-metadata.json", "LICENSE", "THIRD_PARTY_LICENSES"],
}, null, 2) + "\n")
console.log(directory)
