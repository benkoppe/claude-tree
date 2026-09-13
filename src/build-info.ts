import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Effect } from "effect"

import embedded from "./build-metadata.json" with { type: "json" }
import { PROGRAM_VERSION } from "./program"

export interface BuildInfo {
  readonly version: string
  readonly revision: string | null
  readonly dirty: boolean | null
  readonly source: "embedded" | "checkout" | "unknown"
}

const revisionPattern = /^[0-9a-f]{40}$/
const exec = promisify(execFile)
const codeRoot = fileURLToPath(new URL("../", import.meta.url))
export const UNKNOWN_BUILD: BuildInfo = { version: PROGRAM_VERSION, revision: null, dirty: null, source: "unknown" }

/** Inspect the application's checkout only, never the user's project HEAD. */
export const readBuildInfo: Effect.Effect<BuildInfo> = Effect.tryPromise({
  try: async () => {
    if (typeof embedded.revision === "string" && revisionPattern.test(embedded.revision)) {
      return { version: PROGRAM_VERSION, revision: embedded.revision, dirty: embedded.dirty, source: "embedded" as const }
    }
    await stat(new URL("../.git", import.meta.url))
    const git = (args: string[]) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd: codeRoot, timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    })
    const revision = (await git(["rev-parse", "HEAD"])).stdout.trim()
    if (!revisionPattern.test(revision)) return UNKNOWN_BUILD
    const status = (await git(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all", "--", "src", "package.json", "bun.lock", "nix", "flake.nix"])).stdout
    return { version: PROGRAM_VERSION, revision, dirty: status.length > 0, source: "checkout" as const }
  },
  catch: () => undefined,
}).pipe(Effect.catch(() => Effect.succeed(UNKNOWN_BUILD)))
