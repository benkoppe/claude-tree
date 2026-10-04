import { expect, test } from "bun:test"

import { releaseChannel, releaseCompileTarget, releaseDependencies, releasePackageName, releasePlatforms, releaseVersion } from "../../scripts/release-config"
import { assertArtifactSet, assertRegistryIdentity, publicationOrder, publishPackages, type RegistryMetadata } from "../../scripts/publish-release"
import type { ReleaseArtifact } from "../../scripts/pack-release"

const version = "0.2.0"
const revision = "a".repeat(40)
test("x64 releases use baseline CPU targets for macOS and both Linux libcs", () => {
  expect(releaseCompileTarget("darwin", "x64")).toBe("bun-darwin-x64-baseline")
  expect(releaseCompileTarget("linux", "x64", "glibc")).toBe("bun-linux-x64-baseline")
  expect(releaseCompileTarget("linux", "x64", "musl")).toBe("bun-linux-x64-baseline-musl")
  expect(releaseCompileTarget("linux", "arm64", "musl")).toBe("bun-linux-arm64-musl")
  expect(releaseCompileTarget("darwin", "arm64")).toBe("bun-darwin-arm64")
})
function artifacts(): ReleaseArtifact[] {
  return [...releasePlatforms, "npm" as const].map((platform) => ({
    platform, name: releasePackageName(platform), version, revision, dirty: false,
    tarball: `${platform}-${version}.tgz`, integrity: "sha512-example",
    archive: platform === "npm" ? null : `claude-tree-${version}-${platform}.tar.gz`,
  }))
}

test("release versions are validated before becoming tags, commands, or filenames", () => {
  for (const input of ["0.0.0", "1.2.3", "1.2.3-beta.1", "1.2.3-rc-build.2"]) expect(releaseVersion(input)).toBe(input)
  for (const input of ["", "v1.2.3", "1.2", "01.2.3", "1.2.3+build", "1.2.3-beta.01", "1.2.3-", "../1.2.3", "1.2.3\n", "1.2.3;exit", "1.2.3-foo_bar"]) {
    expect(() => releaseVersion(input)).toThrow()
  }
  expect(releaseChannel("1.2.3")).toBe("latest")
  expect(releaseChannel("1.2.3-beta.1")).toBe("next")
})

test("launcher dependencies cover every platform with exact versions", () => {
  const dependencies = releaseDependencies(version)
  expect(Object.keys(dependencies)).toHaveLength(6)
  for (const platform of releasePlatforms) expect(dependencies[releasePackageName(platform)]).toBe(version)
})

test("publication requires a complete clean artifact set from one version and source commit", () => {
  expect(() => assertArtifactSet(artifacts(), version, revision)).not.toThrow()
  expect(() => assertArtifactSet(artifacts().slice(1), version, revision)).toThrow("Incomplete")
  const duplicate = artifacts(); duplicate[1] = duplicate[0]!
  expect(() => assertArtifactSet(duplicate, version, revision)).toThrow("duplicate")
  for (const change of [{ dirty: true }, { version: "0.3.0" }, { revision: "b".repeat(40) }, { name: "wrong" }, { tarball: "../escape.tgz" }, { archive: "wrong.tar.gz" }]) {
    const changed = artifacts(); changed[0] = { ...changed[0]!, ...change }
    expect(() => assertArtifactSet(changed, version, revision)).toThrow()
  }
})

test("platform packages are always published and promoted before the launcher", () => {
  const shuffled = artifacts().reverse()
  const ordered = publicationOrder(shuffled)
  expect(ordered.at(-1)?.platform).toBe("npm")
  expect(ordered.slice(0, -1).every((artifact) => artifact.platform !== "npm")).toBe(true)
})

test("retry skips only an exact already-published package, never different bytes or source", () => {
  const artifact = artifacts()[0]!
  const metadata = { name: artifact.name, version, gitHead: revision, dist: { integrity: artifact.integrity } }
  expect(() => assertRegistryIdentity(metadata, artifact)).not.toThrow()
  for (const change of [{ name: "wrong" }, { version: "0.3.0" }, { gitHead: "b".repeat(40) }, { dist: { integrity: "sha512-different" } }]) {
    expect(() => assertRegistryIdentity({ ...metadata, ...change }, artifact)).toThrow("Refusing")
  }
})

test("release workflow is dispatch-only and does not use smoke tests or Nix", async () => {
  const workflow = await Bun.file(".github/workflows/release.yml").text()
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).toContain("version:")
  expect(workflow).not.toMatch(/^  (push|pull_request|schedule|release):/m)
  expect(workflow).not.toMatch(/smoke|test:release|nix build|nix run|nix flake/)
  expect(workflow).toContain("needs: [prepare, build]")
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow).toContain("scripts/publish-release.ts")
})

function metadata(artifact: ReleaseArtifact): RegistryMetadata {
  return { name: artifact.name, version: artifact.version, gitHead: artifact.revision, dist: { integrity: artifact.integrity } }
}

test("publisher verifies all platform versions before publishing and promoting the launcher", async () => {
  const registry = new Map<string, RegistryMetadata>()
  const published: string[] = []
  const promoted: string[] = []
  await publishPackages(artifacts().reverse(), "latest", {
    lookup: async (spec) => registry.get(spec),
    publish: async (artifact) => {
      if (artifact.platform === "npm") expect(registry.size).toBe(6)
      published.push(artifact.platform)
      registry.set(`${artifact.name}@${artifact.version}`, metadata(artifact))
    },
    promote: async (artifact, channel) => { expect(registry.size).toBe(7); expect(channel).toBe("latest"); promoted.push(artifact.platform) },
    wait: async () => { throw new Error("Already visible packages must not wait") },
  })
  expect(published.at(-1)).toBe("npm")
  expect(promoted.at(-1)).toBe("npm")
})

test("platform publish failure cannot publish or promote the launcher", async () => {
  const published: string[] = []
  const promoted: string[] = []
  await expect(publishPackages(artifacts(), "latest", {
    lookup: async () => undefined,
    publish: async (artifact) => { published.push(artifact.platform); throw new Error("Registry rejected publication") },
    promote: async (artifact) => { promoted.push(artifact.platform) },
    wait: async () => {},
  })).rejects.toThrow("Registry rejected")
  expect(published).not.toContain("npm")
  expect(promoted).toEqual([])
})

test("a successful publish without registry visibility still blocks the launcher", async () => {
  const published: string[] = []
  let waits = 0
  await expect(publishPackages(artifacts(), "latest", {
    lookup: async () => undefined,
    publish: async (artifact) => { published.push(artifact.platform) },
    promote: async () => { throw new Error("Must not promote an incomplete release") },
    wait: async () => { waits++ },
  })).rejects.toThrow("has not made")
  expect(published).toHaveLength(1)
  expect(published).not.toContain("npm")
  expect(waits).toBe(10)
})

test("publisher retry reuses identical existing packages without publishing again", async () => {
  const registry = new Map(artifacts().map((artifact) => [`${artifact.name}@${artifact.version}`, metadata(artifact)]))
  const promoted: string[] = []
  await publishPackages(artifacts(), "next", {
    lookup: async (spec) => registry.get(spec),
    publish: async () => { throw new Error("Must not publish an existing package twice") },
    promote: async (artifact) => { promoted.push(artifact.platform) },
    wait: async () => {},
  })
  expect(promoted.at(-1)).toBe("npm")
})
