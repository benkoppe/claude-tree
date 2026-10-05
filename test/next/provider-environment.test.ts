import { expect, spyOn, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { providerEnvironment } from "../../src/infrastructure/provider-environment"
import { makeCodexAppServerClient } from "../../src/infrastructure/providers/codex/app-server"
import { makeCodexSidecar } from "../../src/infrastructure/providers/codex/sidecar"
import { BunPtyProcessFactory } from "../../src/infrastructure/terminal/bun-pty-process"
import { NullTerminalObserver } from "../../src/domain/model"

test("nested provider environment removes Herdr pane ownership without changing authentication or the parent", () => {
  const parent = { HERDR_ENV: "1", HERDR_BIN_PATH: "/herdr", HERDR_SOCKET_PATH: "/socket",
    HERDR_PANE_ID: "pane", HERDR_TAB_ID: "tab", HERDR_WORKSPACE_ID: "workspace",
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex", CLAUDE_TREE_CODEX_TOKEN: "capability", CUSTOM_HOOK_SETTING: "enabled" }
  const nested = providerEnvironment(parent)
  expect(nested).toEqual({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex",
    CLAUDE_TREE_CODEX_TOKEN: "capability", CUSTOM_HOOK_SETTING: "enabled" })
  expect(parent.HERDR_ENV).toBe("1")
  expect(parent.HERDR_PANE_ID).toBe("pane")
})

test.each(["metadata", "sidecar", "terminal-codex", "terminal-claude"] as const)("the default provider %s spawn explicitly supplies an isolated environment", async (mode) => {
  let spawned = false
  let environment: NodeJS.ProcessEnv | undefined
  let argv: string[] | undefined
  const spawn = spyOn(Bun, "spawn").mockImplementation((command: string[] | { env?: NodeJS.ProcessEnv }, options?: { env?: NodeJS.ProcessEnv }) => {
    spawned = true
    if (Array.isArray(command)) argv = command
    environment = (Array.isArray(command) ? options : command)?.env
    throw new Error("Controlled spawn failure")
  })
  try {
    if (mode === "terminal-codex" || mode === "terminal-claude") {
      const token = mode === "terminal-claude" ? "CLAUDE_TREE_HOOK_TOKEN" : "CLAUDE_TREE_CODEX_TOKEN"
      const command: [string, ...string[]] = mode === "terminal-claude"
        ? ["claude", "--resume", "test", "--settings", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "http", url: "http://127.0.0.1/lifecycle" }] }] } })]
        : ["codex"]
      expect(() => new BunPtyProcessFactory().spawn({ sessionId: "test", observer: new NullTerminalObserver(), command, cwd: "/project",
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "must-not-leak", [token]: "capability", CUSTOM_HOOK_SETTING: "enabled" },
      }, { columns: 80, rows: 24 }, { onOutput() {}, onPtyClosed() {} })).toThrow("Controlled spawn failure")
      expect(environment).toEqual(providerEnvironment({ ...process.env,
        [token]: "capability", CUSTOM_HOOK_SETTING: "enabled", TERM: "xterm-256color", COLORTERM: "truecolor" }))
      expect(argv).toEqual(command)
      return
    }
    const operation: Effect.Effect<void, unknown, Scope.Scope> = mode === "metadata" ? makeCodexAppServerClient("codex").pipe(Effect.asVoid) : makeCodexSidecar("codex", {
      makeTemporaryDirectory: async () => "/controlled/sidecar",
      writeToken: async () => {}, setTokenMode: async () => {}, syncToken: async () => {},
      allocatePort: async () => 12345, removeDirectory: async () => {},
    }).pipe(Effect.asVoid)
    const result = await Effect.runPromise(Effect.scoped(Effect.exit(operation)))
    expect(Exit.isFailure(result)).toBeTrue()
    expect(spawned).toBeTrue()
    expect(environment).toEqual(providerEnvironment())
  } finally {
    spawn.mockRestore()
  }
})
