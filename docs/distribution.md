# Compiled npm distribution

Users install or update with `npm install -g @benkoppe/claude-tree@latest` (or `@benkoppe/claude-tree@next` for prereleases) and run `claude-tree`. A small Node 20+ launcher selects an exact-version platform package containing the compiled Bun executables, migrations, native/parser assets, and dependency notices. No separately installed Bun or install scripts are required. Provider CLIs remain external dependencies.

The launcher is `@benkoppe/claude-tree`; platform packages are `@benkoppe/claude-tree-<os>-<arch>[-<libc>]`, covering Linux x64/arm64 with glibc/musl and macOS arm64. The executable and application identity remain `claude-tree`.

## Release

Use **Actions → Release → Run workflow**, select the validated source ref, and enter a version such as `0.1.0` or `0.1.0-beta.1` without a `v` prefix. Releases run only by workflow dispatch.

The workflow runs the normal tests, builds five platform packages (musl in Alpine), and checks Git/npm version conflicts before publishing. Platform packages publish before the launcher, then `v<VERSION>` is tagged at the dispatched commit and a GitHub Release is created with generated notes. Prereleases are marked accordingly; no binary attachments are added. Stable releases use `latest` and must be newer than its current version; prereleases use `next`. The version is embedded during packaging, without a source version-bump commit.

Before dispatching:

1. Confirm your npm account owns the `@benkoppe` scope and can publish all six packages publicly.
2. Create the GitHub **release** environment. In each npm package's settings, add a GitHub Actions trusted publisher with owner `benkoppe`, repository `claude-tree`, workflow `release.yml`, and environment `release`. Allow direct `npm publish`. The publish job uses OIDC with Node 24 and npm 11.5.1+; no npm token is needed.
3. Require green CI and complete the [real-provider lifecycle gate](lifecycle-review.md#implementation-and-test-gates) and runtime licensing review below.

Configure trusted publishers near the next release: new configurations must successfully publish within two days or be recreated. After a successful OIDC release, revoke the old npm token and delete the GitHub `NPM_TOKEN` secret. You can then enable **Require two-factor authentication and disallow tokens** in each npm package's settings; trusted publishing still works.

Existing Git tags and npm versions cannot be overwritten. Publication is not atomic: after a partial publication, inspect what succeeded and use a new version for a fresh release rather than blindly rerunning. There is no custom retry or recovery system.

Nix remains a separate optional source installation, not part of publishing.

## Local build

```sh
bun install --frozen-lockfile
bun run check
RELEASE_VERSION=0.1.0 bun run build:release
RELEASE_VERSION=0.1.0 bun run build:release --launcher
```

The script packages the current platform, or the launcher with `--launcher`. Tarballs land in `dist/packages`; unpacked packages are in `dist/<os>-<arch>[-<libc>]` and `dist/npm`. Build on the target OS/architecture using upstream Bun 1.3.13 and Node/npm. On musl Linux, set `OPENTUI_LIBC=musl` and install matching OpenTUI dependencies. The repository-root package is private, not the published launcher.

Nix-patched Bun can produce executables requiring Nix on the destination machine; use upstream Bun for portable packages.

x64 builds use Bun's `baseline` target rather than requiring AVX2. Native OpenTUI assets retain their upstream CPU/OS requirements; baseline selection alone is not validation on older hardware. ARM64 uses the native target. Workers and native assets are bundled; the diagnostic executable and migrations stay alongside the main executable.

## Runtime notices and rebuilding

Platform packages copy notices supplied by installed npm dependencies into `licenses/` and include `source.tar.gz`. Extract the source, install pinned dependencies, and run the commands above with the package's version. Outside a Git checkout, set `BUILD_REVISION` to the packaged `build-metadata.json` revision; modified rebuilds are marked dirty. `BUN_EXECUTABLE=/path/to/custom/bun` selects a replacement runtime.

Before public distribution, review [Bun's runtime licensing](https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md), including JavaScriptCore/WebKit LGPL source and relinking requirements, missing dependency notices, and [provider SDK terms](https://code.claude.com/docs/en/legal-and-compliance). Copying npm notices alone does not complete that review.
