import { randomUUID } from "node:crypto"
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { Context, Layer } from "effect"

export type ProcessLiveness = "alive" | "absent" | "unknown"

export interface PersistenceFileHandle {
  readonly writeFile: (contents: string) => Promise<void>
  readonly sync: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface PersistencePlatformApi {
  readonly pid: number
  readonly stateHome: () => string
  readonly now: () => string
  readonly randomToken: () => string
  readonly mkdir: (path: string, options: { readonly recursive: boolean; readonly mode: number }) => Promise<void>
  readonly realpath: (path: string) => Promise<string>
  readonly readFile: (path: string) => Promise<string>
  readonly open: (path: string, flags: string, mode?: number) => Promise<PersistenceFileHandle>
  readonly link: (existingPath: string, newPath: string) => Promise<void>
  readonly rename: (oldPath: string, newPath: string) => Promise<void>
  readonly remove: (path: string, options?: { readonly force?: boolean }) => Promise<void>
  readonly processLiveness: (pid: number) => Promise<ProcessLiveness>
  readonly processGroupLiveness: (processGroupId: number) => Promise<ProcessLiveness>
  readonly sleep: (milliseconds: number) => Promise<void>
}

export class PersistencePlatform extends Context.Service<
  PersistencePlatform,
  PersistencePlatformApi
>()("claude-tree/PersistencePlatform") {}

function livenessFromSignal(target: number): ProcessLiveness {
  try {
    process.kill(target, 0)
    return "alive"
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return "absent"
    if (isErrorCode(error, "EPERM")) return "alive"
    return "unknown"
  }
}

export const nativePersistencePlatform: PersistencePlatformApi = {
  pid: process.pid,
  stateHome: () => {
    const configured = process.env.XDG_STATE_HOME
    if (configured !== undefined) return configured
    return join(homedir(), ".local", "state")
  },
  now: () => new Date().toISOString(),
  randomToken: randomUUID,
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
  realpath,
  readFile: (path) => readFile(path, "utf8"),
  open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    return {
      writeFile: async (contents) => {
        await handle.writeFile(contents, "utf8")
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  link,
  rename,
  remove: async (path, options) => {
    await rm(path, { force: options?.force ?? false })
  },
  processLiveness: async (pid) => livenessFromSignal(pid),
  processGroupLiveness: async (processGroupId) => livenessFromSignal(-processGroupId),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

export const PersistencePlatformLive = Layer.succeed(
  PersistencePlatform,
  nativePersistencePlatform,
)

export function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  )
}
