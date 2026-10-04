import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

import { releaseChannel, releaseDependencies, releasePackageName, releasePlatforms, releaseVersion } from "./release-config"
import type { ReleaseArtifact } from "./pack-release"

const exec = promisify(execFile)
const artifactSchema = z.object({
  platform: z.enum([...releasePlatforms, "npm"]), name: z.string(), version: z.string(),
  revision: z.string().regex(/^[0-9a-f]{40}$/), dirty: z.boolean(),
  tarball: z.string().regex(/^[a-zA-Z0-9.-]+\.tgz$/), integrity: z.string().startsWith("sha512-"),
  archive: z.string().regex(/^[a-zA-Z0-9.-]+\.tar\.gz$/).nullable(),
}).strict()

const command = async (program: string, args: string[]) => (await exec(program, args, { maxBuffer: 4 * 1024 * 1024 })).stdout
const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")

export function assertArtifactSet(artifacts: readonly ReleaseArtifact[], version: string, revision: string): void {
  releaseVersion(version)
  const expected = [...releasePlatforms, "npm"]
  if (artifacts.length !== expected.length || new Set(artifacts.map((artifact) => artifact.platform)).size !== expected.length) throw new Error("Incomplete or duplicate platform artifact set")
  for (const artifact of artifacts) {
    artifactSchema.parse(artifact)
    if (artifact.version !== version || artifact.revision !== revision || artifact.dirty || artifact.name !== releasePackageName(artifact.platform)) throw new Error("Artifact version/source identity mismatch")
    const archive = artifact.platform === "npm" ? null : `claude-tree-${version}-${artifact.platform}.tar.gz`
    if (artifact.archive !== archive) throw new Error("Artifact archive name mismatch")
  }
  const names = artifacts.flatMap((artifact) => [artifact.tarball, ...(artifact.archive ? [artifact.archive] : [])])
  if (new Set(names).size !== names.length) throw new Error("Duplicate archive filenames")
}

export function publicationOrder(artifacts: readonly ReleaseArtifact[]): ReleaseArtifact[] {
  return [...artifacts.filter((artifact) => artifact.platform !== "npm"), ...artifacts.filter((artifact) => artifact.platform === "npm")]
}

export interface RegistryMetadata {
  readonly name?: string
  readonly version?: string
  readonly gitHead?: string
  readonly dist?: { readonly integrity?: string }
}

export function assertRegistryIdentity(metadata: RegistryMetadata, artifact: ReleaseArtifact): void {
  if (metadata.name !== artifact.name || metadata.version !== artifact.version || metadata.gitHead !== artifact.revision || metadata.dist?.integrity !== artifact.integrity) {
    throw new Error(`Refusing to replace different published bytes/source for ${artifact.name}@${artifact.version}; reuse the original workflow artifacts`)
  }
}

async function registryPackage(spec: string): Promise<RegistryMetadata | undefined> {
  try { return JSON.parse(await command("npm", ["view", spec, "--json", "--registry", "https://registry.npmjs.org"])) }
  catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (stdout) {
      try { if (JSON.parse(stdout).error?.code === "E404") return undefined } catch { /* Preserve the original command failure. */ }
    }
    throw error
  }
}

export interface PackagePublisher {
  readonly lookup: (spec: string) => Promise<RegistryMetadata | undefined>
  readonly publish: (artifact: ReleaseArtifact) => Promise<void>
  readonly promote: (artifact: ReleaseArtifact, channel: "latest" | "next") => Promise<void>
  readonly wait: () => Promise<void>
}

export async function publishPackages(artifacts: readonly ReleaseArtifact[], channel: "latest" | "next", publisher: PackagePublisher): Promise<void> {
  for (const artifact of publicationOrder(artifacts)) {
    const spec = `${artifact.name}@${artifact.version}`
    const existing = await publisher.lookup(spec)
    if (existing) assertRegistryIdentity(existing, artifact)
    else await publisher.publish(artifact)
    let published = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const metadata = await publisher.lookup(spec)
      if (metadata) { assertRegistryIdentity(metadata, artifact); published = true; break }
      await publisher.wait()
    }
    if (!published) throw new Error(`Registry has not made ${spec} visible; rerun the publish job with the same artifacts`)
  }
  for (const artifact of publicationOrder(artifacts)) await publisher.promote(artifact, channel)
}

async function validateArchives(artifacts: readonly ReleaseArtifact[], directory: string): Promise<void> {
  for (const artifact of artifacts) {
    const tarball = join(directory, artifact.tarball)
    const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`
    if (integrity !== artifact.integrity) throw new Error(`Corrupt npm archive: ${artifact.tarball}`)
    const manifest = JSON.parse(await command("tar", ["-xOf", tarball, "package/package.json"]))
    if (manifest.name !== artifact.name || manifest.version !== artifact.version || manifest.gitHead !== artifact.revision || manifest.claudeTreeBuild?.dirty !== false || manifest.claudeTreeBuild?.revision !== artifact.revision) throw new Error("Packed manifest does not match the build identity")
    if (artifact.platform === "npm") {
      const expected = releaseDependencies(artifact.version)
      if (JSON.stringify(Object.entries(manifest.optionalDependencies ?? {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error("Launcher dependency set is incomplete or not exact-version pinned")
    } else {
      const identity = JSON.parse(await command("tar", ["-xOf", join(directory, artifact.archive!), "./build-metadata.json"]))
      const direct = JSON.parse(await command("tar", ["-xOf", join(directory, artifact.archive!), "./package.json"]))
      if (identity.revision !== artifact.revision || identity.dirty !== false || direct.version !== artifact.version || direct.name !== artifact.name) throw new Error("Direct-download archive does not match its npm package identity")
    }
  }
}

async function ensureTag(tag: string, revision: string): Promise<void> {
  const ref = `refs/tags/${tag}`
  const remote = (await command("git", ["ls-remote", "--tags", "origin", ref, `${ref}^{}`])).trim().split("\n").filter(Boolean)
  if (remote.length) {
    const peeled = remote.find((line) => line.endsWith(`${ref}^{}`)) ?? remote[0]!
    if (peeled.split(/\s+/)[0] !== revision) throw new Error("Existing release tag points to a different source commit")
    return
  }
  await command("git", ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "tag", "-a", tag, revision, "-m", `Release ${tag}`])
  await command("git", ["push", "origin", ref])
}

interface GithubRelease {
  readonly draft: boolean
  readonly assets: readonly { readonly name: string; readonly digest?: string | null }[]
}

async function githubRelease(repo: string, tag: string): Promise<GithubRelease | undefined> {
  try { return JSON.parse(await command("gh", ["api", `repos/${repo}/releases/tags/${tag}`])) }
  catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("HTTP 404")) return undefined
    throw error
  }
}

async function stageGithubAssets(repo: string, tag: string, revision: string, directory: string, files: string[]): Promise<void> {
  let release = await githubRelease(repo, tag)
  if (!release) {
    await command("gh", ["release", "create", tag, "--repo", repo, "--verify-tag", "--target", revision, "--draft", "--title", tag, "--generate-notes"])
    release = await githubRelease(repo, tag)
  }
  if (!release) throw new Error("GitHub did not return the newly created draft release")
  for (const file of files) {
    const asset = release.assets.find((entry: { name: string }) => entry.name === basename(file))
    if (asset) {
      const digest = `sha256:${await sha256(file)}`
      if (asset.digest) {
        if (asset.digest !== digest) throw new Error(`Existing release asset differs: ${asset.name}; never overwrite release artifacts`)
      } else {
        const temporary = await mkdtemp(join(tmpdir(), "claude-tree-release-"))
        try {
          await command("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset.name, "--dir", temporary])
          if (await sha256(join(temporary, asset.name)) !== await sha256(file)) throw new Error(`Existing release asset differs: ${asset.name}`)
        } finally { await rm(temporary, { recursive: true, force: true }) }
      }
    } else {
      if (!release.draft) throw new Error("Cannot add missing artifacts to an already public release")
      await command("gh", ["release", "upload", tag, join(directory, basename(file)), "--repo", repo])
    }
  }
}

export async function publishRelease(directory = resolve("dist/artifacts")): Promise<void> {
  const version = releaseVersion(process.env.RELEASE_VERSION ?? "")
  const revision = process.env.BUILD_REVISION ?? ""
  const repo = process.env.GITHUB_REPOSITORY ?? ""
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("Missing release repository/source identity")
  if ((await command("git", ["rev-parse", "HEAD"])).trim() !== revision) throw new Error("Publisher checkout does not match the build source")
  const artifacts: ReleaseArtifact[] = []
  for (const platform of [...releasePlatforms, "npm"]) artifacts.push(artifactSchema.parse(JSON.parse(await readFile(join(directory, `${platform}.json`), "utf8"))))
  assertArtifactSet(artifacts, version, revision)
  await validateArchives(artifacts, directory)
  const channel = releaseChannel(version)
  // Preflight every package before any tag, release, or registry mutation.
  for (const artifact of artifacts) {
    const published = await registryPackage(`${artifact.name}@${version}`)
    if (published) assertRegistryIdentity(published, artifact)
    const current = await registryPackage(`${artifact.name}@${channel}`)
    if (current && (!current.version || Bun.semver.order(current.version, version) > 0)) throw new Error(`Refusing to downgrade ${artifact.name}'s ${channel} channel`)
  }
  const tag = `v${version}`
  await ensureTag(tag, revision)
  const manifest = join(directory, "release-manifest.json")
  await writeFile(manifest, JSON.stringify({ version, revision, artifacts }, null, 2) + "\n")
  const assets = artifacts.flatMap((artifact) => [join(directory, artifact.tarball), ...(artifact.archive ? [join(directory, artifact.archive)] : [])]).concat(manifest).sort()
  const checksums = join(directory, "SHA256SUMS")
  await writeFile(checksums, (await Promise.all(assets.map(async (file) => `${await sha256(file)}  ${basename(file)}\n`))).join(""))
  await stageGithubAssets(repo, tag, revision, directory, [...assets, checksums])
  await publishPackages(artifacts, channel, {
    lookup: registryPackage,
    publish: async (artifact) => { await command("npm", ["publish", join(directory, artifact.tarball), "--access", "public", "--tag", "staging", "--ignore-scripts", "--registry", "https://registry.npmjs.org"]) },
    promote: async (artifact, target) => { await command("npm", ["dist-tag", "add", `${artifact.name}@${version}`, target, "--registry", "https://registry.npmjs.org"]) },
    wait: () => Bun.sleep(2_000),
  })
  await command("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", `--prerelease=${channel === "next"}`, `--latest=${channel === "latest"}`])
  console.log(`Released ${tag}: https://github.com/${repo}/releases/tag/${tag}`)
}

if (import.meta.main) await publishRelease()
