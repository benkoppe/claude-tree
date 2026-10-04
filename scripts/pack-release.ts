import { createHash } from "node:crypto"
import { chmod, mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { releasePackageName, releasePlatforms, releaseVersion, type ReleasePlatform } from "./release-config"

const exec = promisify(execFile)
export interface ReleaseArtifact {
  readonly platform: ReleasePlatform | "npm"
  readonly name: string
  readonly version: string
  readonly revision: string
  readonly dirty: boolean
  readonly tarball: string
  readonly integrity: string
  readonly archive: string | null
}

export async function packRelease(platform: ReleasePlatform | "npm", root = resolve("dist")): Promise<void> {
  const directory = join(root, platform)
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  const version = releaseVersion()
  if (manifest.name !== releasePackageName(platform) || manifest.version !== version) throw new Error("Release package name/version mismatch")
  const identity = manifest.claudeTreeBuild
  if (!identity || !/^[0-9a-f]{40}$/.test(identity.revision) || typeof identity.dirty !== "boolean") throw new Error("Missing release build identity")
  const output = join(root, "artifacts")
  await mkdir(output, { recursive: true })
  for (const binary of platform === "npm" ? ["bin/claude-tree.cjs"] : ["claude-tree", "claude-tree-history"]) await chmod(join(directory, binary), 0o755)
  const packed = JSON.parse((await exec("npm", ["pack", directory, "--pack-destination", output, "--ignore-scripts", "--json"])).stdout)
  if (packed.length !== 1 || packed[0].name !== manifest.name || packed[0].version !== version) throw new Error("npm packed an unexpected package")
  const tarball = packed[0].filename as string
  if (!/^[a-zA-Z0-9.-]+\.tgz$/.test(tarball)) throw new Error("Unsafe npm archive filename")
  const integrity = `sha512-${createHash("sha512").update(await readFile(join(output, tarball))).digest("base64")}`
  if (integrity !== packed[0].integrity) throw new Error("npm archive integrity mismatch")
  const archive = platform === "npm" ? null : `claude-tree-${version}-${platform}.tar.gz`
  if (archive) await exec("tar", ["-czf", join(output, archive), "-C", directory, "."])
  const artifact: ReleaseArtifact = { platform, name: manifest.name, version, revision: identity.revision, dirty: identity.dirty, tarball, integrity, archive }
  await Bun.write(join(output, `${platform}.json`), JSON.stringify(artifact, null, 2) + "\n")
}

if (import.meta.main) {
  const platform = process.argv[2]
  if (platform !== "npm" && !releasePlatforms.includes(platform as ReleasePlatform)) throw new Error("Expected a supported platform or npm")
  await packRelease(platform as ReleasePlatform | "npm")
}
