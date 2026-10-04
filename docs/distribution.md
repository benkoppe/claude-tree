# Compiled and npm distribution

The application remains Bun-based. npm distribution uses a small Node launcher and exact-version platform packages containing compiled Bun executables, migrations, native/parser assets, dependency notices, and a source archive. Users do not need a separately installed Bun. Provider CLIs remain external dependencies.

## Build and test

```sh
bun install --frozen-lockfile
bun run check
bun run build:release
bun run test:release
bun run package:npm
```

Build on the target OS/architecture. On musl Linux set `OPENTUI_LIBC=musl` and install matching OpenTUI optional dependencies. Outputs are in `dist/<platform>-<architecture>[-<libc>]` and `dist/npm`. Worker entrypoints are included explicitly. The read-only history diagnostic has a separate executable with IPC and isolated stdio. SQLite migrations are colocated with the executables, not relative to the user's project directory.

The release smoke test exercises bundled metadata/read/projection workers, database creation, checks, backup/export, and the diagnostic child with Bun absent from PATH. Native terminal behavior must also pass the existing PTY integration suite on each release platform.

Run `npm pack` on platform and launcher directories. Publish platform packages before the launcher, all with the same version. The `@claude-tree` scope and `claude-tree` package name must be available to the publisher; change the package-generation scripts and launcher together if another scope is needed. No install scripts download executables or build native dependencies. Publication is manual and separately authorized.

## Rebuilding and runtime notices

`source.tar.gz` contains the application source and dependency lockfile used for the build. Extract it, install the pinned dependencies, and run the build commands above. Outside a Git checkout, set `BUILD_REVISION` to the revision in the package's `build-metadata.json`; modified rebuilds are marked dirty unless `BUILD_DIRTY=false` is explicitly supplied. `BUN_EXECUTABLE=/path/to/custom/bun` selects a custom Bun runtime for compiled executables, allowing rebuilding with modified runtime libraries.

Bun 1.3.13 includes MIT-licensed Bun and statically linked JavaScriptCore/WebKit and other third-party libraries. Runtime licensing, source, and relinking instructions are documented at https://github.com/oven-sh/bun/blob/bun-v1.3.13/LICENSE.md and https://github.com/oven-sh/webkit. Review the Bun runtime's distribution requirements, dependency notices, and any provider SDK terms before publishing a binary release. The build copies dependency notice files, including the selected OpenTUI library's vendor notices, into `licenses/`.

Nix and Bun-source installs remain supported separately; they use the same SQLite schema and repository.
