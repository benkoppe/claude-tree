# Compiled npm distribution

Users install or update with `npm install -g claude-tree@latest` (or `@next` for prereleases). A small Node launcher selects an exact-version platform package containing the compiled Bun executables, migrations, native/parser assets, and dependency notices. No separately installed Bun or install scripts are required. Provider CLIs remain external dependencies.

## Release

Use **Actions → Release → Run workflow**, select the source ref, and enter a version such as `0.2.0` or `0.2.0-beta.1` without a `v` prefix. Releases run only by workflow dispatch.

The workflow runs the normal tests and builds six Linux/macOS packages, including musl builds in Alpine. It transfers npm tarballs, publishes the platform packages before the launcher, then creates `v<VERSION>` at the dispatched commit. Stable versions use npm's `latest` tag; prereleases use `next`. The version is embedded during packaging, without a source version-bump commit.

Confirm ownership of `claude-tree` and the `@claude-tree` npm scope, and configure a publishing-capable **NPM_TOKEN** in the GitHub **release** environment before dispatching. Existing Git tags and npm versions cannot be overwritten. Publication is not atomic: after a partial publication, inspect what succeeded and use a new version for a fresh release rather than blindly rerunning. There is no custom retry or recovery system.

There are no release smoke tests, standalone download archives, GitHub Release staging, checksums, signing, or provenance setup. Nix remains a separate optional source installation, not part of publishing.

## Local build

```sh
bun install --frozen-lockfile
bun run check
RELEASE_VERSION=0.2.0 bun run build:release
RELEASE_VERSION=0.2.0 bun run build:release --launcher
```

One script compiles/packages the current platform, or packages the launcher with `--launcher`. npm tarballs land in `dist/packages`; unpacked packages are in `dist/<platform>-<architecture>[-<libc>]` and `dist/npm`. Build on the target OS/architecture; on musl Linux set `OPENTUI_LIBC=musl` and install matching OpenTUI dependencies. Node/npm must be available for `npm pack`. The repository-root package remains a private Bun-source package, not the published launcher.

x64 builds use Bun's `baseline` target rather than requiring AVX2. Native OpenTUI assets retain their upstream CPU/OS requirements; baseline selection alone is not validation on older hardware. ARM64 uses the native target. Workers and native assets are bundled; the diagnostic executable and migrations stay alongside the main executable.

## Runtime notices and rebuilding

Platform packages retain dependency notices and `source.tar.gz` for rebuilding. Extract the source, install pinned dependencies, and run the commands above with the package's version. Outside a Git checkout, set `BUILD_REVISION` to the packaged `build-metadata.json` revision; modified rebuilds are marked dirty. `BUN_EXECUTABLE=/path/to/custom/bun` selects a custom runtime for rebuilding with modified runtime libraries.

Bun 1.3.13 includes MIT-licensed Bun and statically linked JavaScriptCore/WebKit and other libraries. Review runtime distribution requirements at https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md and https://github.com/oven-sh/webkit, dependency notices, and provider SDK terms before public distribution. The build copies dependency notice files, including OpenTUI vendor notices, into `licenses/`.
