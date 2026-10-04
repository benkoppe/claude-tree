# Compiled and npm distribution

The application remains Bun-based. npm distribution uses a small Node launcher and exact-version platform packages containing compiled Bun executables, migrations, native/parser assets, dependency notices, and a source archive. Users do not need a separately installed Bun. Provider CLIs remain external dependencies.

## Release workflow

Use **Actions → Release → Run workflow**, select the source ref, and enter a version such as `0.2.0` or `0.2.0-beta.1` (without `v` or build metadata). This is the only trigger: pushes, tags, and PRs do not launch a release. The workflow creates `v<VERSION>` itself, pointing to the exact dispatched commit. It does not modify `main` or bump source manifests in a commit; the requested version is embedded in the executables and generated npm manifests.

1. Validate the version and package the small npm launcher.
2. Run the normal TypeScript/regression suite and compile all six macOS/Linux platform packages, including musl builds inside Alpine Docker containers. There are no release smoke or installation tests.
3. Pack npm tarballs and standalone `.tar.gz` archives on the build runners. These preserve executable permissions through GitHub artifact transfer. Publishing downloads the packages; it never rebuilds them.
4. Require the complete platform set, exact version/source identity, archive integrity, and exact-version launcher dependencies. Reject incompatible existing tags, published bytes, or release assets, and refuse to downgrade the `latest`/`next` channel.
5. Create the tag and a draft GitHub Release; stage immutable archives, `release-manifest.json`, and `SHA256SUMS`.
6. Publish every platform package under the temporary npm `staging` tag, verifying registry visibility before publishing the launcher. Promote platform packages first and the launcher last to `latest` (stable versions) or `next` (prereleases). Finally make the GitHub Release public.

Publication is not a cross-registry atomic transaction. A failure can leave a draft release and staged packages. Use **Re-run failed jobs** to resume the publish job with the original successful build artifacts. Identical already-published packages and assets are skipped; different bytes at an existing version are never replaced. Do not rebuild a partly published version or move its tag. If different builds are needed, use a new version. Releases are serialized and never automatically cancelled mid-publication.

## One-time publishing setup

- Confirm ownership of `claude-tree` and the `@claude-tree` npm scope. The launcher and six platform package names must be available to the publisher.
- Create the GitHub **release** environment, ideally with approval and branch restrictions.
- Put a publishing-capable npm token in the environment secret **NPM_TOKEN**, with permission to publish all seven packages and update their dist-tags. No token is committed to the repository. Signing and provenance infrastructure are deliberately omitted.
- Review Bun/runtime/SDK distribution requirements below before dispatching the first public release.

After publication, install or update with `npm install -g claude-tree@latest`, or use `claude-tree@next` for prereleases. Standalone users download the matching platform archive from GitHub Releases, check `SHA256SUMS`, and extract the entire directory: the diagnostic executable and migrations must stay beside the main executable. Provider CLIs remain separately installed.

## Local build and packaging

```sh
bun install --frozen-lockfile
bun run check
bun run build:release
bun run package:npm
bun run release:pack linux-x64-glibc
bun run release:pack npm
```

Build on the target OS/architecture. On musl Linux set `OPENTUI_LIBC=musl` and install matching OpenTUI optional dependencies. Outputs are in `dist/<platform>-<architecture>[-<libc>]` and `dist/npm`. Worker entrypoints are included explicitly. The read-only history diagnostic has a separate executable with IPC and isolated stdio. SQLite migrations are colocated with the executables, not relative to the user's project directory.

x64 builds use Bun's `baseline` target rather than requiring AVX2. This avoids a separate modern/baseline package matrix and CPU selector. Native OpenTUI assets retain their upstream CPU/OS requirements; baseline selection alone is not validation on older hardware. ARM64 uses the native target.

Set `RELEASE_VERSION` to override the development version when building packages. No install scripts download executables or build native dependencies. Use the workflow for publication, not `npm publish` in the repository root (which remains a private Bun-source package).

## Rebuilding and runtime notices

`source.tar.gz` contains the application source and dependency lockfile used for the build. Extract it, install the pinned dependencies, and run the build commands above with `RELEASE_VERSION` set to the package's version. Outside a Git checkout, set `BUILD_REVISION` to the revision in the package's `build-metadata.json`; modified rebuilds are marked dirty unless `BUILD_DIRTY=false` is explicitly supplied. `BUN_EXECUTABLE=/path/to/custom/bun` selects a custom Bun runtime for compiled executables, allowing rebuilding with modified runtime libraries.

Bun 1.3.13 includes MIT-licensed Bun and statically linked JavaScriptCore/WebKit and other third-party libraries. Runtime licensing, source, and relinking instructions are documented at https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md and https://github.com/oven-sh/webkit. Review the Bun runtime's distribution requirements, dependency notices, and any provider SDK terms before publishing a binary release. The build copies dependency notice files, including the selected OpenTUI library's vendor notices, into `licenses/`.

Nix and Bun-source installs remain supported separately; they use the same SQLite schema and repository. Nix is not a release builder, publication dependency, or required user installation tool. npm plus versioned GitHub downloads is the public binary distribution path; the Nix checks only maintain the existing optional Nix package.
