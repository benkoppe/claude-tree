import packageJson from "../package.json" with { type: "json" }

export const releasePlatforms = ["linux-x64-glibc", "linux-arm64-glibc", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"] as const
export type ReleasePlatform = typeof releasePlatforms[number]

export function releaseCompileTarget(platform: "linux" | "darwin", arch: "x64" | "arm64", libc?: "glibc" | "musl"): Bun.Build.CompileTarget {
  return `bun-${platform}-${arch}${arch === "x64" ? "-baseline" : ""}${platform === "linux" && libc === "musl" ? "-musl" : ""}` as Bun.Build.CompileTarget
}

export function releaseVersion(input = process.env.RELEASE_VERSION ?? packageJson.version): string {
  if (input.trim() !== input || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(input)) {
    throw new Error("Release version must be SemVer without a v prefix or build metadata")
  }
  if (input.split("-")[0]!.split(".").some((part) => BigInt(part) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("Release version numbers exceed SemVer's supported range")
  for (const identifier of input.split("-").slice(1).join("-").split(".")) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) throw new Error("Numeric prerelease identifiers cannot have leading zeroes")
  }
  return input
}

export function releaseChannel(version: string): "latest" | "next" {
  return releaseVersion(version).includes("-") ? "next" : "latest"
}

export function releaseIdentity(): { revision: string; dirty: boolean } {
  if (process.env.BUILD_REVISION) {
    if (!/^[0-9a-f]{40}$/.test(process.env.BUILD_REVISION)) throw new Error("BUILD_REVISION must be a full Git revision")
    return { revision: process.env.BUILD_REVISION, dirty: process.env.BUILD_DIRTY !== "false" }
  }
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
  if (revision.exitCode !== 0) throw new Error("Release builds require a Git checkout or BUILD_REVISION")
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe" })
  if (status.exitCode !== 0) throw new Error("Could not determine release build status")
  return { revision: revision.stdout.toString().trim(), dirty: status.stdout.length > 0 }
}

export function releasePackageName(platform: ReleasePlatform | "npm"): string {
  return platform === "npm" ? packageJson.name : `@claude-tree/${platform}`
}

export function releaseDependencies(version: string): Record<string, string> {
  return Object.fromEntries(releasePlatforms.map((platform) => [releasePackageName(platform), releaseVersion(version)]))
}
