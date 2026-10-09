import { expect, test } from "bun:test"

import { launcherManifest, releaseCompileTarget, releasePlatforms, releaseVersion } from "../../scripts/build-release"

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
  expect(manifest.version).toBe("0.2.0")
  expect(Object.keys(manifest.optionalDependencies)).toHaveLength(6)
  for (const platform of releasePlatforms) expect(manifest.optionalDependencies[`@claude-tree/${platform}`]).toBe("0.2.0")
  expect(manifest).not.toHaveProperty("scripts")
})

test("release workflow stays dispatch-only and publishes the launcher after platform packages", async () => {
  const workflow = await Bun.file(".github/workflows/release.yml").text()
  expect(workflow).toContain("workflow_dispatch:")
  expect(workflow).not.toMatch(/^  (push|pull_request|schedule|release):/m)
  expect(workflow).not.toMatch(/smoke|test:release|nix build|nix run|nix flake|staging|SHA256SUMS|gh release/)
  expect(workflow).toContain("needs: build")
  expect(workflow).toContain("cancel-in-progress: false")
  expect(workflow.indexOf('for package in "${packages[@]}"')).toBeLessThan(workflow.indexOf('npm publish "dist/packages/claude-tree-$RELEASE_VERSION.tgz"'))
  expect(workflow.indexOf('git tag "v$RELEASE_VERSION"')).toBeGreaterThan(workflow.indexOf('npm publish "dist/packages/claude-tree-$RELEASE_VERSION.tgz"'))
})
