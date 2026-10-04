import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Fiber } from "effect"

import { makeAppRuntime, type AppRuntime } from "../src/application/runtime"
import { makeNavigationPersistenceWorker } from "../src/infrastructure/metadata/navigation-persistence"
import { nativePersistencePlatform, PersistencePlatform } from "../src/infrastructure/metadata/platform"
import { makeProviderReads, withProviderReads } from "../src/infrastructure/providers/read-service"
import { makeProjectionService } from "../src/infrastructure/projection/service"
import { makeOpenTuiPresentation } from "../src/presentation/open-tui-presentation"
import { makeProviderStateRepository } from "../src/services/provider-state-repository"
import type { TerminalSupervisorApi } from "../src/services/terminal-supervisor"

const inline = process.argv.includes("--inline")
const count = Number(process.env.BENCHMARK_SESSIONS ?? 200)
const records = Number(process.env.BENCHMARK_RECORDS ?? 200)
if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(records) || records < 2) throw new Error("Invalid fixture size")
const directory = await mkdtemp(join(tmpdir(), "claude-tree-responsiveness-"))
const projectPath = join(directory, "project")
const config = join(directory, "claude")
const projectKey = projectPath.replaceAll("/", "-")
const transcriptDirectory = join(config, "projects", projectKey)
await mkdir(projectPath)
await mkdir(transcriptDirectory, { recursive: true })
const lastIds = new Map<string, string>()
for (let index = 0; index < count; index++) {
  const sessionId = crypto.randomUUID()
  let parentUuid: string | null = null
  const history = Array.from({ length: records }, (_, ordinal) => {
    const uuid = crypto.randomUUID()
    const user = ordinal % 2 === 0
    const entry = { type: user ? "user" : "assistant", uuid, parentUuid, sessionId, isSidechain: false, cwd: projectPath,
      timestamp: new Date(Date.UTC(2026, 8, 11) + index * 1000 + ordinal).toISOString(),
      message: user ? { role: "user", content: `Session ${index} turn ${ordinal}` }
        : { role: "assistant", id: `answer-${ordinal}`, content: [{ type: "text", text: "Answer content ".repeat(100) }], stop_reason: "end_turn" },
    }
    parentUuid = uuid
    return JSON.stringify(entry)
  })
  await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), history.join("\n") + "\n")
  lastIds.set(sessionId, parentUuid!)
}

const terminals: TerminalSupervisorApi = {
  show: () => Effect.die("Benchmark must not launch terminals"), hideActive: Effect.succeed(null), stopSession: () => Effect.succeed(false),
  shutdown: () => Effect.void, activeSessionId: Effect.succeed(null), ownsInput: Effect.succeed(false),
  runningSessionIds: Effect.succeed(new Set()), ownedSessionIds: Effect.succeed(new Set()), nonIdleSessionIds: Effect.succeed(new Set()),
  activitySessionIds: () => Effect.succeed(new Set()), draftPreviews: Effect.succeed(new Map()), ownershipSnapshot: Effect.succeed([]),
  reconcileActivity: Effect.succeed([]),
}

function summary(samples: number[]) {
  const sorted = samples.toSorted((left, right) => left - right)
  const at = (fraction: number) => Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(2))
  return { samples: sorted.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) }
}

async function measure(runtime: AppRuntime, setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  const latencies: number[] = []
  const frameIntervals: number[] = []
  let previousFrameStarted: number | undefined
  let frameChanges = 0
  let previous = ""
  const started = performance.now()
  while (true) {
    const state = await Effect.runPromise(runtime.getState)
    const done = !state.refresh.initialPending && state.refresh.active.size === 0
    if (done && latencies.length >= 10) break
    const view = await Effect.runPromise(runtime.getViewModel)
    if ((view.surface._tag === "Roots" && view.surface.roots.length > 1) || (view.surface._tag === "Graph" && view.surface.nodes.length > 1)) {
      const start = performance.now()
      if (previousFrameStarted !== undefined) frameIntervals.push(start - previousFrameStarted)
      previousFrameStarted = start
      setup.mockInput.pressArrow(latencies.length % 2 ? "up" : "down")
      await new Promise<void>((resolve) => setImmediate(resolve))
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      if (frame !== previous) frameChanges++
      previous = frame
      latencies.push(performance.now() - start)
    }
    // Pacing belongs to this benchmark, not deterministic regression tests.
    await new Promise<void>((resolve) => setTimeout(resolve, 16))
  }
  return { durationMs: Math.round(performance.now() - started), frameChanges, inputToFrame: summary(latencies), frameIntervals: summary(frameIntervals) }
}

try {
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CLAUDE_CODE_PROJECT_DIR_NAME = projectKey
  const { ClaudeProvider } = await import("../src/infrastructure/providers/claude/provider")
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const localProvider = new ClaudeProvider(projectPath)
    const options = { providerId: "claude" as const, projectPath }
    const reads = inline ? undefined : yield* makeProviderReads(options, () => new Worker(new URL("../src/infrastructure/providers/read-worker.ts", import.meta.url), {
      workerData: options, env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey },
    }))
    const projection = inline ? undefined : yield* makeProjectionService()
    const provider = reads ? withProviderReads(localProvider, reads) : localProvider
    const repositoryOptions = { providerId: "claude", projectDirectory: projectPath, stateHome: join(directory, "state") }
    const repository = yield* makeProviderStateRepository(repositoryOptions)
    const navigation = yield* makeNavigationPersistenceWorker({ ...repositoryOptions, instanceId: repository.instanceId })
    const setup = yield* Effect.promise(() => createTestRenderer({ width: 100, height: 30 }))
    const runtime = yield* makeAppRuntime({ provider, terminals, metadata: { ...repository, saveNavigation: navigation.saveNavigation },
      closeNavigationPersistence: navigation.close, ...(reads ? { closeProviderReads: reads.close } : {}),
      ...(projection ? { prepareProjection: projection.prepare, closeProjection: projection.close } : {}),
    })
    const presentation = yield* makeOpenTuiPresentation(setup.renderer, runtime, provider)
    yield* presentation.run
    const startup = yield* Effect.promise(() => measure(runtime, setup))
    const refresh = yield* Effect.forkChild(runtime.refresh())
    yield* Effect.yieldNow
    const manualRefresh = yield* Effect.promise(() => measure(runtime, setup))
    yield* Fiber.join(refresh)
    const roots = yield* runtime.getViewModel
    if (roots.surface._tag !== "Roots" || !roots.surface.roots[0]) return yield* Effect.die("Expected fixture roots")
    const sessionId = roots.surface.roots[0].sessionId
    yield* runtime.enterRoot(sessionId)
    const uuid = crypto.randomUUID()
    yield* Effect.promise(() => appendFile(join(transcriptDirectory, `${sessionId}.jsonl`), JSON.stringify({
      type: "user", uuid, parentUuid: lastIds.get(sessionId), sessionId, cwd: projectPath, isSidechain: false,
      timestamp: new Date(Date.UTC(2026, 8, 12)).toISOString(), message: { role: "user", content: "New graph node during refresh" },
    }) + "\n"))
    const graphRead = yield* Effect.forkChild(runtime.refresh())
    yield* Effect.yieldNow
    const graphRefresh = yield* Effect.promise(() => measure(runtime, setup))
    yield* Fiber.join(graphRead)
    yield* presentation.stop
    return { mode: inline ? "inline" : "isolated", sessions: count, recordsPerSession: records, startup, manualRefresh, graphRefresh }
  }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
