import { expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"

import type {
  AppRuntime,
  ApplicationModal,
  ApplicationViewModel,
  ApplicationState,
  GraphNodeViewModel,
  SurfaceViewModel,
} from "../../src/application"
import {
  ApplicationOperationError,
  available,
  makeInitialApplicationState,
  projectApplicationViewModel,
} from "../../src/application"
import type { AgentMessage, AgentSession, NavigationTarget } from "../../src/domain/model"
import {
  makeOpenTuiPresentation,
  presentationTheme,
  type OpenTuiPresentation,
} from "../../src/presentation"

const provider = {
  id: "test",
  displayName: "Test Agent",
  capabilities: { historicalBranching: true },
}

test("renders roots and preserves directional graph navigation intent", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const roots = rootsView()
  const firstGraph = branchingGraph("root-1", "First conversation")
  const secondGraph = linearGraph("root-2", "Second conversation", "second question")
  const running = await startPresentation(setup.renderer, roots, new Map([
    ["root-1", firstGraph],
    ["root-2", secondGraph],
  ]))

  try {
    await frame(setup, (value) => value.includes("First conversation"))
    expect(isSelected(setup, "First conversation")).toBeTrue()

    setup.mockInput.pressArrow("down")
    await frame(setup, () => isSelected(setup, "Second conversation"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Message graph") && value.includes("second question"))
    expect(isSelected(setup, "second question")).toBeTrue()

    await Effect.runPromise(running.harness.update(firstGraph))
    await frame(setup, (value) => value.includes("left branch"))
    setup.mockInput.pressArrow("down")
    await frame(setup, () => isSelected(setup, "left branch"))
    setup.mockInput.pressArrow("up")
    await frame(setup, () => isSelected(setup, "branch source"))
    setup.mockInput.pressArrow("down")
    await frame(setup, () => isSelected(setup, "left branch"))
    setup.mockInput.pressArrow("right")
    await frame(setup, () => isSelected(setup, "right branch"))
  } finally {
    await running.stop()
  }
})

test("opens the newly selected graph node without waiting for publication", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(setup.renderer, branchingGraph("root-1", "Rapid open"))

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:left"))
    expect(setup.captureCharFrame()).not.toContain("Open leaf")
  } finally {
    await running.stop()
  }
})

test("forks the newly selected graph node without waiting for publication", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(setup.renderer, branchingGraph("root-1", "Rapid fork"))

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("f")
    await waitFor(() => running.harness.calls.includes("branch:root-1:left-message"))
  } finally {
    await running.stop()
  }
})

test("a stalled manual refresh does not block navigation or forking", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const initial = branchingGraph("root-1", "Refresh concurrency")
  const running = await startPresentation(setup.renderer, initial, new Map(), undefined, Effect.succeed(true), {
    refresh: () => Effect.never,
  })
  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressKey("r")
    await waitFor(() => running.harness.calls.includes("refresh"))
    await Effect.runPromise(running.harness.update({ ...initial, refreshing: true }))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("f")
    await waitFor(() => running.harness.calls.includes("branch:root-1:left-message"))
  } finally {
    await running.stop()
  }
})

test("an interrupted terminal action does not kill the presentation action queue", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let attempts = 0
  const running = await startPresentation(setup.renderer, rootsView(), new Map(), undefined, Effect.succeed(true), {
    newSession: Effect.suspend(() => ++attempts === 1 ? Effect.interrupt : Effect.succeed(true)),
  })
  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("n")
    await waitFor(() => attempts === 1)
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("n")
    await waitFor(() => attempts === 2)
  } finally {
    await running.stop()
  }
})

test("quit bypasses a stalled foreground terminal action", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const started = Deferred.makeUnsafe<void>()
  let stopped = false
  const running = await startPresentation(setup.renderer, rootsView(), new Map(), undefined,
    Effect.sync(() => { stopped = true; return true }), {
      newSession: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    })
  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("n")
    await Effect.runPromise(Deferred.await(started))
    setup.mockInput.pressKey("q")
    await waitFor(() => stopped)
  } finally {
    await running.stop()
  }
})

test("deletes the newly selected graph node without waiting for publication", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(setup.renderer, branchingGraph("root-1", "Rapid delete"))

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("d")
    await waitFor(() => running.harness.modalUpdates.some((modal) => modal._tag === "ConfirmRemoval"))
    const modal = running.harness.modalUpdates.find((candidate) => candidate._tag === "ConfirmRemoval")
    expect(modal?._tag === "ConfirmRemoval" && modal.removal.kind === "subtree" &&
      modal.removal.target.kind === "message" && modal.removal.target.aliases[0]?.messageId).toBe("left-message")
  } finally {
    await running.stop()
  }
})

test("stops the newly selected graph endpoint without waiting for publication", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const graph = withLiveSessions(branchingGraph("root-1", "Rapid stop"), ["left"])
  const running = await startPresentation(setup.renderer, graph)

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("x")
    await waitFor(() => running.harness.modalUpdates.some((modal) =>
      modal._tag === "ConfirmStop" && modal.sessionId === "left"
    ))
    expect(running.harness.modalUpdates.at(-1)).toMatchObject({ _tag: "ConfirmStop", sessionId: "left" })
  } finally {
    await running.stop()
  }
})

test("uses the authoritative selection after a rejected graph move when opening", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(
    setup.renderer,
    branchingGraph("root-1", "Rejected open"),
    new Map(),
    undefined,
    Effect.succeed(true),
    { selectGraph: () => Effect.fail(new Error("selection rejected")) },
  )

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    await frame(setup, (value) => value.includes("selection rejected"))
    setup.mockInput.pressEscape()
    await frame(setup, () => isSelected(setup, "branch source"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Open leaf"))
    expect(running.harness.calls).not.toContain("open:left")
  } finally {
    await running.stop()
  }
})

test("uses the authoritative selection after a rejected graph move when forking", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(
    setup.renderer,
    branchingGraph("root-1", "Rejected fork"),
    new Map(),
    undefined,
    Effect.succeed(true),
    { selectGraph: () => Effect.fail(new Error("selection rejected")) },
  )

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    await frame(setup, (value) => value.includes("selection rejected"))
    setup.mockInput.pressEscape()
    await frame(setup, () => isSelected(setup, "branch source"))
    setup.mockInput.pressKey("f")
    await waitFor(() => running.harness.calls.includes("branch:root-1:source"))
    expect(running.harness.calls).not.toContain("branch:root-1:left-message")
  } finally {
    await running.stop()
  }
})

test("uses the authoritative selection after a rejected graph move when deleting", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(
    setup.renderer,
    branchingGraph("root-1", "Rejected delete"),
    new Map(),
    undefined,
    Effect.succeed(true),
    { selectGraph: () => Effect.fail(new Error("selection rejected")) },
  )

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    await frame(setup, (value) => value.includes("selection rejected"))
    setup.mockInput.pressEscape()
    await frame(setup, () => isSelected(setup, "branch source"))
    setup.mockInput.pressKey("d")
    await waitFor(() => running.harness.modalUpdates.some((modal) => modal._tag === "ConfirmRemoval"))
    const modal = running.harness.modalUpdates.find((candidate) => candidate._tag === "ConfirmRemoval")
    expect(modal?._tag === "ConfirmRemoval" && modal.removal.kind === "subtree" &&
      modal.removal.target.kind === "message" && modal.removal.target.aliases[0]?.messageId).toBe("source")
  } finally {
    await running.stop()
  }
})

test("executes a captured rapid selection after its predecessor rejects", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const rejectFirst = await Effect.runPromise(Deferred.make<void, Error>())
  let attempt = 0
  const running = await startPresentation(
    setup.renderer,
    branchingGraph("root-1", "Queued selection"),
    new Map(),
    undefined,
    Effect.succeed(true),
    {
      selectGraph: (_familySessionId, _target, publishSelection) => {
        attempt += 1
        return attempt === 1 ? Deferred.await(rejectFirst) : publishSelection()
      },
    },
  )

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("right")
    await waitFor(() => running.harness.calls.includes("select-graph:message:root-1:left-message"))
    expect(running.harness.calls).not.toContain("select-graph:message:root-1:right-message")

    await Effect.runPromise(Deferred.fail(rejectFirst, new Error("first selection rejected")))
    await waitFor(() => running.harness.calls.includes("select-graph:message:root-1:right-message"))
    await frame(setup, (value) => value.includes("first selection rejected"))
    expect(running.harness.calls.filter((call) => call.startsWith("select-graph:"))).toEqual([
      "select-graph:message:root-1:left-message",
      "select-graph:message:root-1:right-message",
    ])

    setup.mockInput.pressEscape()
    await frame(setup, () => isSelected(setup, "right branch"))

    setup.mockInput.pressKey("f")
    await waitFor(() => running.harness.calls.includes("branch:root-1:right-message"))

    setup.mockInput.pressKey("d")
    await waitFor(() => running.harness.modalUpdates.some((modal) => modal._tag === "ConfirmRemoval"))
    const removal = running.harness.modalUpdates.find((modal) => modal._tag === "ConfirmRemoval")
    expect(removal?._tag === "ConfirmRemoval" && removal.removal.kind === "subtree" &&
      removal.removal.target.kind === "message" && removal.removal.target.aliases[0]?.messageId).toBe("right-message")
    setup.mockInput.pressEscape()
    await frame(setup, () => isSelected(setup, "right branch"))

    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:right"))
    expect(running.harness.calls).not.toContain("open:left")
  } finally {
    await running.stop()
  }
})

test("renders asynchronous runtime updates without polling", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(setup.renderer, rootsView(), new Map())

  try {
    await frame(setup, (value) => value.includes("First conversation"))
    const updated = rootsView("Updated asynchronously")
    await Effect.runPromise(running.harness.update(updated))
    const rendered = await frame(setup, (value) => value.includes("Updated asynchronously"))
    expect(rendered).not.toContain("First conversation")
  } finally {
    await running.stop()
  }
})

test("contains a throwing terminal title update and renders later updates", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let threw = false
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Effect.succeed(true),
    {},
    {
      setTerminalTitle: (title) => {
        if (!threw && title.includes("Broken render")) {
          threw = true
          throw new Error("terminal title defect")
        }
      },
    },
  )

  try {
    await frame(setup, (value) => value.includes("First conversation"))
    await Effect.runPromise(running.harness.update(linearGraph("root-1", "Broken render", "broken update")))
    const failure = await frame(setup, (value) => value.includes("Render update") && value.includes("terminal title defect"))
    expect(failure).toContain("Error")
    setup.mockInput.pressEscape()
    await frame(setup, (value) => value.includes("Message graph") && !value.includes("terminal title defect"))
    await Effect.runPromise(running.harness.update(linearGraph("root-1", "Recovered render", "later update")))
    await frame(setup, (value) => value.includes("later update"))
  } finally {
    await running.stop()
  }
})

test("reports a rejected runtime action and processes a later action", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let attempts = 0
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Effect.succeed(true),
    {
      refresh: () => {
        attempts += 1
        return attempts === 1 ? Effect.fail(new Error("refresh rejected")) : Effect.void
      },
    },
  )

  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("r")
    await frame(setup, (value) => value.includes("Action failed") && value.includes("refresh rejected"))
    setup.mockInput.pressEscape()
    await frame(setup, (value) => value.includes("Conversation roots") && !value.includes("refresh rejected"))
    setup.mockInput.pressKey("r")
    await waitFor(() => attempts === 2)
    expect(running.harness.calls.filter((call) => call === "refresh")).toHaveLength(2)
  } finally {
    await running.stop()
  }
})

test("preserves one operation-specific modal for an application-reported action failure", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Effect.succeed(true),
    {
      reportedRefreshFailure: new ApplicationOperationError({
        intent: "Refresh",
        operation: "Refresh conversations",
        message: "snapshot failed",
      }),
    },
  )

  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("r")
    const rendered = await frame(setup, (value) => value.includes("Refresh conversations: snapshot failed"))
    expect(rendered).not.toContain("Action failed")

    setup.mockInput.pressEscape()
    await frame(setup, (value) => value.includes("Conversation roots") && !value.includes("snapshot failed"))
    expect(running.harness.modalUpdates).toEqual([{
      _tag: "Error",
      message: "Refresh conversations: snapshot failed",
    }])
  } finally {
    await running.stop()
  }
})

test("runs an action and accepts later input when its pending render defects", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  let content: ReturnType<typeof setup.renderer.root.findDescendantById>
  let defectPending = true
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Effect.succeed(true),
    {
      beforeRefresh: () => {
        if (!defectPending) return
        defectPending = false
        content = setup.renderer.root.findDescendantById("next-content")
        if (!content) throw new Error("Presentation content was not mounted")
        Object.defineProperty(content, "content", {
          configurable: true,
          set: () => {
            Reflect.deleteProperty(content!, "content")
            throw new Error("pending render defect")
          },
        })
      },
    },
  )

  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("r")
    await waitFor(() => running.harness.calls.filter((call) => call === "refresh").length === 1)
    setup.mockInput.pressEscape()
    await frame(setup, (value) => value.includes("Conversation roots") && !value.includes("pending render defect"))
    setup.mockInput.pressKey("r")
    await waitFor(() => running.harness.calls.filter((call) => call === "refresh").length === 2)
  } finally {
    if (content) Reflect.deleteProperty(content, "content")
    await running.stop()
  }
})

test("hides roots immediately while a new terminal is opening", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const release = await Effect.runPromise(Deferred.make<void>())
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Effect.succeed(true),
    { newSession: Deferred.await(release).pipe(Effect.as(true)) },
  )

  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("n")
    await waitFor(() => running.harness.calls.includes("new"))
    const opening = await frame(setup, (value) => !value.includes("Conversation roots"))
    expect(opening).not.toContain("First conversation")
    await Effect.runPromise(Deferred.succeed(release, undefined))
  } finally {
    await running.stop()
  }
})

test("keeps graph updates hidden while an endpoint terminal is opening", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const release = await Effect.runPromise(Deferred.make<void>())
  const graph = linearGraph("root-1", "Opening conversation", "question")
  const running = await startPresentation(
    setup.renderer,
    graph,
    new Map(),
    undefined,
    Effect.succeed(true),
    { openEndpoint: () => Deferred.await(release).pipe(Effect.as(true)) },
  )

  try {
    await frame(setup, (value) => value.includes("question"))
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:root-1"))
    const updated = linearGraph("root-1", "Opening conversation", "draft created during open")
    await Effect.runPromise(running.harness.update(updated))
    const opening = await frame(setup, (value) => !value.includes("Message graph"))
    expect(opening).not.toContain("draft created during open")
    await Effect.runPromise(Deferred.succeed(release, undefined))
  } finally {
    await running.stop()
  }
})

test("finishes an interrupted stop exactly once without deadlocking later callers", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const releaseShutdown = await Effect.runPromise(Deferred.make<void>())
  const running = await startPresentation(
    setup.renderer,
    rootsView(),
    new Map(),
    undefined,
    Deferred.await(releaseShutdown).pipe(Effect.as(true)),
  )

  const firstStop = Effect.runFork(running.presentation.stop)
  await waitFor(() => running.harness.calls.includes("shutdown"))
  const interruption = Effect.runFork(Fiber.interrupt(firstStop))
  const secondStop = Effect.runFork(running.presentation.stop)

  await Effect.runPromise(Deferred.succeed(releaseShutdown, undefined))
  await Effect.runPromise(Fiber.join(secondStop))
  await Effect.runPromise(Fiber.join(interruption))
  expect(running.harness.calls.filter((call) => call === "shutdown")).toHaveLength(1)
})

test("terminal mode intercepts only Ctrl+Space and its Kitty release", async () => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const graph = linearGraph("root-1", "Terminal conversation", "question")
  const terminal: ApplicationViewModel = {
    ...baseView(),
    surface: {
      _tag: "Terminal",
      sessionId: "root-1",
      title: "Terminal conversation",
      status: "idle",
      draft: undefined,
    },
  }
  const running = await startPresentation(setup.renderer, terminal, new Map(), graph)
  const observed: Array<{ type: "press" | "release"; name: string; stopped: boolean }> = []
  setup.renderer.keyInput.on("keypress", (key) => {
    observed.push({ type: "press", name: key.name, stopped: key.propagationStopped })
  })
  setup.renderer.keyInput.on("keyrelease", (key) => {
    observed.push({ type: "release", name: key.name, stopped: key.propagationStopped })
  })

  try {
    setup.mockInput.pressKey("q")
    releaseKittyKey(setup, 113)
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await Bun.sleep(10)
    expect(running.harness.calls).not.toContain("return-terminal")
    expect(observed.filter((event) => ["q", "escape", "return"].includes(event.name)).every((event) => !event.stopped)).toBeTrue()

    setup.mockInput.pressKey(" ", { ctrl: true })
    await frame(setup, (value) => value.includes("Message graph"))
    releaseKittyKey(setup, 32, 5)
    await Bun.sleep(10)
    expect(running.harness.calls).toContain("return-terminal")
    expect(observed.some((event) => event.name === "space")).toBeFalse()
    expect(observed).toContainEqual({ type: "release", name: "q", stopped: false })
  } finally {
    await running.stop()
  }
})

test("suppresses every consumed Kitty key release", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true })
  const running = await startPresentation(setup.renderer, rootsView())
  const observed: string[] = []
  setup.renderer.keyInput.on("keypress", (key) => observed.push(`press:${key.name}`))
  setup.renderer.keyInput.on("keyrelease", (key) => observed.push(`release:${key.name}`))

  try {
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressArrow("down")
    releaseKittyKey(setup, 57353)
    setup.mockInput.pressKey("z")
    releaseKittyKey(setup, 122)
    await Bun.sleep(10)
    expect(observed).toEqual(["press:z", "release:z"])
  } finally {
    await running.stop()
  }
})

test("uses safe removal and affirmative stop confirmation defaults", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const graph = endpointGraph()
  const running = await startPresentation(setup.renderer, graph, new Map())

  try {
    await frame(setup, (value) => value.includes("pending text"))
    setup.mockInput.pressKey("x")
    await frame(setup, (value) => value.includes("Stop live session"))
    expect(selectedSpan(setup, "Stop")).toBeDefined()
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("stop:endpoint"))

    await Effect.runPromise(running.harness.update(rootsView()))
    await frame(setup, (value) => value.includes("Conversation roots"))
    setup.mockInput.pressKey("d")
    await frame(setup, (value) => value.includes("Delete conversation tree"))
    expect(selectedSpan(setup, "Cancel")).toBeDefined()
    setup.mockInput.pressEnter()
    await frame(setup, (value) => !value.includes("Delete conversation tree"))
    expect(running.harness.calls.some((call) => call.startsWith("remove:"))).toBeFalse()
  } finally {
    await running.stop()
  }
})

test("closes a stop confirmation when its session exits", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const graph = endpointGraph()
  const running = await startPresentation(setup.renderer, graph)

  try {
    await frame(setup, (value) => value.includes("pending text"))
    setup.mockInput.pressKey("x")
    await frame(setup, (value) => value.includes("Stop live session"))
    await Effect.runPromise(running.harness.update({
      ...graph,
      modal: { _tag: "ConfirmStop", sessionId: "endpoint", activity: "idle" },
      liveSessionIds: new Set(),
    }))
    await frame(setup, (value) => !value.includes("Stop live session"))
    setup.mockInput.pressEnter()
    await Bun.sleep(10)
    expect(running.harness.calls).not.toContain("stop:endpoint")
  } finally {
    await running.stop()
  }
})

test("closes a stop confirmation when the endpoint identity changes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const running = await startPresentation(setup.renderer, endpointGraph())

  try {
    await frame(setup, (value) => value.includes("pending text"))
    setup.mockInput.pressKey("x")
    await frame(setup, (value) => value.includes("Stop live session"))
    const adopted = endpointGraph("adopted")
    await Effect.runPromise(running.harness.update({
      ...adopted,
      modal: { _tag: "ConfirmStop", sessionId: "adopted", activity: "idle" },
    }))
    await frame(setup, (value) => !value.includes("Stop live session"))
    setup.mockInput.pressEnter()
    await Bun.sleep(10)
    expect(running.harness.calls.some((call) => call.startsWith("stop:"))).toBeFalse()
  } finally {
    await running.stop()
  }
})

test("reports a stopped Fork without requesting another stop", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const running = await startPresentation(setup.renderer, canonicalStoppedForkGraph())

  try {
    await frame(setup, (value) => value.includes("Fork 1"))
    setup.mockInput.pressKey("x")
    const rendered = await frame(setup, (value) => value.includes("This Fork is already stopped"))
    expect(rendered).toContain("Error")
    expect(running.harness.calls.some((call) => call.startsWith("stop:"))).toBeFalse()
  } finally {
    await running.stop()
  }
})

test("preserves a stopped endpoint preference through endpoint removal and refresh repair", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const live = ambiguousStoppedEndpointGraph("endpoint", true)
  const stoppedEndpoint = ambiguousStoppedEndpointGraph("endpoint", false)
  const repaired = ambiguousStoppedEndpointGraph("source", false)
  const running = await startPresentation(
    setup.renderer,
    live,
    new Map(),
    repaired,
    Effect.succeed(true),
    { stopSession: (_sessionId, update) => update(stoppedEndpoint).pipe(Effect.as(true)) },
  )

  try {
    await frame(setup, (value) => value.includes("shared source") && value.includes("Selected session"))
    setup.mockInput.pressKey("x")
    await frame(setup, (value) => value.includes("Stop live session"))
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("stop:stopped"))
    await frame(setup, (value) => value.includes("Selected fork · stopped"))

    await Effect.runPromise(running.harness.update(repaired))
    await frame(setup, () => isSelected(setup, "shared source"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Open leaf"))
    expect(isSelected(setup, "Stopped fork")).toBeTrue()

    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:stopped"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    await frame(setup, () => isSelected(setup, "shared source"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Open leaf"))
    expect(isSelected(setup, "Other leaf")).toBeTrue()
  } finally {
    await running.stop()
  }
})

test("opens a reachable leaf through the keyboard picker", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const graph = branchingGraph("root-1", "Leaf conversation")
  const running = await startPresentation(setup.renderer, graph, new Map())

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressEnter()
    const picker = await frame(setup, (value) => value.includes("Open leaf") && value.includes("Left leaf") && value.includes("Right leaf"))
    expect(picker).toContain("2 nodes down")
    setup.mockInput.pressArrow("down")
    await frame(setup, () => isSelected(setup, "Left leaf"))
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:left"))
  } finally {
    await running.stop()
  }
})

test("opens saved hidden endpoints and preserves canonical leaf ordering", async () => {
  const savedSetup = await createTestRenderer({ width: 80, height: 24 })
  const saved = canonicalSavedGraph()
  const savedRunning = await startPresentation(savedSetup.renderer, saved)

  try {
    await frame(savedSetup, (value) => value.includes("saved question"))
    expect(saved.surface._tag === "Graph" && saved.surface.nodes.some((node) => node._tag === "Endpoint")).toBeFalse()
    savedSetup.mockInput.pressEnter()
    await waitFor(() => savedRunning.harness.calls.includes("open:saved"))
  } finally {
    await savedRunning.stop()
  }

  const pickerSetup = await createTestRenderer({ width: 80, height: 24 })
  const canonical = canonicalBranchingGraph()
  const pickerRunning = await startPresentation(pickerSetup.renderer, canonical)
  try {
    await frame(pickerSetup, (value) => value.includes("canonical source"))
    pickerSetup.mockInput.pressEnter()
    await frame(pickerSetup, (value) => value.includes("Open leaf"))
    expect(isSelected(pickerSetup, "Newer child")).toBeTrue()
  } finally {
    await pickerRunning.stop()
  }
})

test("supports g top and G unique-leaf navigation", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const graph = branchingGraph("root-1", "Jump conversation")
  const running = await startPresentation(setup.renderer, graph)

  try {
    await frame(setup, (value) => value.includes("g/G top/leaf"))
    setup.mockInput.pressArrow("down")
    await frame(setup, () => isSelected(setup, "left branch"))
    setup.mockInput.pressKey("g", { shift: true })
    await waitFor(() => running.harness.calls.includes("select-graph:endpoint:left"))
    await frame(setup, (value) => value.includes("Selected session") && !value.includes("Jump to Leaf"))
    setup.mockInput.pressKey("g")
    await frame(setup, () => isSelected(setup, "branch source"))

    setup.mockInput.pressKey("g", { shift: true })
    await frame(setup, (value) => value.includes("Jump to Leaf"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("select-graph:endpoint:left"))
    await frame(setup, (value) => !value.includes("Jump to Leaf") && value.includes("Selected session"))
  } finally {
    await running.stop()
  }
})

test("scrolls a long leaf picker with the mouse wheel", async () => {
  const setup = await createTestRenderer({ width: 60, height: 12 })
  const running = await startPresentation(setup.renderer, manyLeafGraph())

  try {
    let rendered = await frame(setup, (value) => value.includes("many leaves"))
    setup.mockInput.pressEnter()
    rendered = await frame(setup, (value) => value.includes("Open leaf") && value.includes("Leaf 1"))
    const first = coordinateOf(rendered, "Leaf 1")
    for (let index = 0; index < 40; index += 1) {
      await setup.mockMouse.scroll(first.x, first.y, "down")
      await setup.renderOnce()
    }
    await setup.renderOnce()
    rendered = setup.captureCharFrame()
    expect(rendered).not.toContain("Leaf 1 ")
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.some((call) => call.startsWith("open:leaf-") && call !== "open:leaf-1"))
  } finally {
    await running.stop()
  }
})

test("renders stopped empty forks with stable numbered labels after a live return", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const graph = canonicalStoppedForkGraph()
  const running = await startPresentation(setup.renderer, graph, new Map(), graph)

  try {
    await frame(setup, (value) => value.includes("Fork 1") && value.includes("Fork 2"))
    setup.mockInput.pressEnter()
    await waitFor(() => running.harness.calls.includes("open:fork-one"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    const returned = await frame(setup, (value) => value.includes("Message graph") && value.includes("Fork 1"))
    expect(returned).not.toContain("Draft")
  } finally {
    await running.stop()
  }
})

test("surfaces canonical graph integrity warnings through the runtime", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const running = await startPresentation(setup.renderer, canonicalWarningGraph())

  try {
    const rendered = await frame(setup, (value) => value.includes("Graph integrity warning"))
    expect(rendered).toContain("source message missing is unavailable".split(" ")[0]!)
    expect(rendered).toContain("message missing is unavailable")
  } finally {
    await running.stop()
  }
})

test("restores live, update, and blocked picker markers", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 })
  const graph = pickerStatusGraph()
  const running = await startPresentation(setup.renderer, graph)

  try {
    await frame(setup, (value) => value.includes("picker statuses"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Live leaf") && value.includes("Update leaf") && value.includes("Blocked leaf"))
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.text.includes("•") && span.fg.equals(presentationTheme.success))).toBeTrue()
    expect(spans.some((span) => span.text.includes("●") && span.fg.equals(presentationTheme.warning))).toBeTrue()
    expect(spans.some((span) => span.text.includes("●") && span.fg.equals(presentationTheme.danger))).toBeTrue()
  } finally {
    await running.stop()
  }
})

test("rechecks interaction blocking before content mouse-up", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const initial = rootsView()
  const running = await startPresentation(setup.renderer, initial)

  try {
    const rendered = await frame(setup, (value) => value.includes("Second conversation"))
    const second = coordinateOf(rendered, "Second conversation")
    await setup.mockMouse.pressDown(second.x, second.y)
    await Effect.runPromise(running.harness.update({ ...initial, shuttingDown: true }))
    await setup.mockMouse.release(second.x, second.y)
    await Bun.sleep(20)
    expect(running.harness.calls).not.toContain("select-root:root-2")
    expect(running.harness.calls).not.toContain("enter-root:root-2")
  } finally {
    await running.stop()
  }
})

test("shows minimum dimensions and repairs the navigator after resize", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const graph = branchingGraph("root-1", "Resize conversation")
  const running = await startPresentation(setup.renderer, graph, new Map())

  try {
    await frame(setup, (value) => value.includes("branch source"))
    setup.mockInput.pressEnter()
    await frame(setup, (value) => value.includes("Open leaf"))

    setup.resize(40, 8)
    const minimum = await frame(setup, (value) => value.includes("Resize to at least 50×12"))
    expect(minimum).not.toContain("Open leaf")
    expect(minimum).not.toContain("branch source")

    setup.resize(80, 24)
    const restored = await frame(setup, (value) => value.includes("Message graph") && value.includes("branch source"))
    expect(restored).not.toContain("Open leaf")
  } finally {
    await running.stop()
  }
})

interface RuntimeHarness {
  readonly runtime: AppRuntime
  readonly calls: string[]
  readonly modalUpdates: ApplicationModal[]
  readonly update: (viewModel: ApplicationViewModel) => Effect.Effect<void>
}

interface RuntimeActionOverrides {
  readonly newSession?: Effect.Effect<boolean>
  readonly openEndpoint?: (sessionId: string) => Effect.Effect<boolean>
  readonly selectGraph?: (
    familySessionId: string,
    target: NavigationTarget,
    publishSelection: () => Effect.Effect<void>,
  ) => Effect.Effect<unknown, unknown>
  readonly stopSession?: (
    sessionId: string,
    update: (viewModel: ApplicationViewModel) => Effect.Effect<void>,
  ) => Effect.Effect<boolean>
  readonly beforeRefresh?: () => void
  readonly reportedRefreshFailure?: ApplicationOperationError
  readonly refresh?: () => Effect.Effect<unknown, unknown>
}

async function startPresentation(
  renderer: Parameters<typeof makeOpenTuiPresentation>[0],
  initial: ApplicationViewModel,
  graphs: ReadonlyMap<string, ApplicationViewModel> = new Map(),
  terminalReturn?: ApplicationViewModel,
  shutdown: Effect.Effect<boolean> = Effect.succeed(true),
  actionOverrides: RuntimeActionOverrides = {},
  presentationOptions: Parameters<typeof makeOpenTuiPresentation>[3] = {},
): Promise<{
  presentation: OpenTuiPresentation
  harness: RuntimeHarness
  stop: () => Promise<void>
}> {
  let resolveStarted!: (value: { presentation: OpenTuiPresentation; harness: RuntimeHarness }) => void
  const started = new Promise<{ presentation: OpenTuiPresentation; harness: RuntimeHarness }>((resolve) => {
    resolveStarted = resolve
  })
  const lifecycle = Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const harness = yield* makeHarness(initial, graphs, terminalReturn, shutdown, actionOverrides)
    const presentation = yield* makeOpenTuiPresentation(renderer, harness.runtime, provider, presentationOptions)
    yield* presentation.run
    resolveStarted({ presentation, harness })
    yield* presentation.wait
  })))
  const value = await started
  return {
    ...value,
    stop: async () => {
      await Effect.runPromise(value.presentation.stop)
      await lifecycle
    },
  }
}

function makeHarness(
  initial: ApplicationViewModel,
  graphs: ReadonlyMap<string, ApplicationViewModel>,
  terminalReturn?: ApplicationViewModel,
  shutdown: Effect.Effect<boolean> = Effect.succeed(true),
  actionOverrides: RuntimeActionOverrides = {},
): Effect.Effect<RuntimeHarness> {
  return Effect.gen(function*() {
    const updates = yield* SubscriptionRef.make(initial)
    const calls: string[] = []
    const modalUpdates: ApplicationModal[] = []
    let current = initial
    let lastGraph = terminalReturn ?? (initial.surface._tag === "Graph" ? initial : undefined)
    const update = (viewModel: ApplicationViewModel) => Effect.sync(() => {
      current = viewModel
      if (viewModel.surface._tag === "Graph") lastGraph = viewModel
    }).pipe(Effect.andThen(SubscriptionRef.set(updates, viewModel)))
    const modal = (value: ApplicationModal | null) => Effect.sync(() => {
      if (value) modalUpdates.push(value)
    }).pipe(Effect.andThen(update({ ...current, modal: value })))
    const runtime = {
      getViewModel: Effect.sync(() => current),
      viewModels: SubscriptionRef.changes(updates),
      getState: Effect.die("presentation must not read application state"),
      dispatch: () => Effect.succeed(false),
      shutdown: Effect.sync(() => calls.push("shutdown")).pipe(Effect.andThen(shutdown)),
      preparedTerminals: new Map(),
      terminalEvents: {},
      refresh: () => {
        actionOverrides.beforeRefresh?.()
        const refresh = Effect.sync(() => {
          calls.push("refresh")
        }).pipe(Effect.andThen(Effect.suspend(() => actionOverrides.refresh?.() ?? Effect.succeed(true))))
        const failure = actionOverrides.reportedRefreshFailure
        return failure === undefined
          ? refresh
          : refresh.pipe(
              Effect.andThen(modal({
                _tag: "Error",
                message: `${failure.operation}: ${failure.message}`,
              })),
              Effect.andThen(Effect.fail(failure)),
            )
      },
      selectRoot: (sessionId: string | null) => {
        calls.push(`select-root:${sessionId ?? "none"}`)
        if (current.surface._tag !== "Roots") {
          const roots = rootsView()
          if (roots.surface._tag !== "Roots") return Effect.succeed(false)
          return update({
            ...roots,
            surface: {
              ...roots.surface,
              roots: roots.surface.roots.map((root) => ({
                ...root,
                selected: root.sessionId === sessionId,
              })),
            },
          }).pipe(Effect.as(true))
        }
        const surface = current.surface
        return update({
          ...current,
          surface: {
            ...surface,
            roots: surface.roots.map((root) => ({
              ...root,
              selected: root.sessionId === sessionId,
            })),
          },
        }).pipe(Effect.as(true))
      },
      enterRoot: (sessionId: string) => {
        calls.push(`enter-root:${sessionId}`)
        const graph = graphs.get(sessionId)
        return graph ? update(graph).pipe(Effect.as(true)) : Effect.succeed(false)
      },
      selectGraph: (familySessionId: string, target: NavigationTarget) => {
        calls.push(`select-graph:${targetKey(target)}`)
        const publishSelection = () => {
          if (current.surface._tag !== "Graph") return Effect.void
          const surface: SurfaceViewModel = {
            ...current.surface,
            nodes: current.surface.nodes.map((node) => ({
              ...node,
              selected: targetKey(node.target) === targetKey(target),
            })),
            selectedNodeId: current.surface.nodes.find((node) =>
              targetKey(node.target) === targetKey(target)
            )?.id ?? null,
          }
          return update({ ...current, surface })
        }
        const override = actionOverrides.selectGraph?.(familySessionId, target, publishSelection)
        if (override) return override
        return publishSelection().pipe(Effect.as(true))
      },
      newSession: Effect.sync(() => calls.push("new")).pipe(
        Effect.andThen(actionOverrides.newSession ?? Effect.succeed(true)),
      ),
      resumeSession: (sessionId: string) => Effect.sync(() => {
        calls.push(`resume:${sessionId}`)
        return true
      }),
      openEndpoint: (sessionId: string) => Effect.gen(function*() {
        calls.push(`open:${sessionId}`)
        if (actionOverrides.openEndpoint) return yield* actionOverrides.openEndpoint(sessionId)
        const graph = current.surface._tag === "Graph" ? current : lastGraph
        if (graph) lastGraph = graph
        yield* update({
          ...current,
          liveSessionIds: new Set([sessionId]),
          surface: {
            _tag: "Terminal",
            sessionId,
            title: endpointTitle(graph, sessionId),
            status: "idle",
            draft: undefined,
          },
        })
        return true
      }),
      branchFrom: (target: { sessionId: string; messageId: string }) => Effect.sync(() => {
        calls.push(`branch:${target.sessionId}:${target.messageId}`)
        return true
      }),
      returnFromTerminal: Effect.gen(function*() {
        calls.push("return-terminal")
        if (lastGraph) yield* update(lastGraph)
        return true
      }),
      stopSession: (sessionId: string) => Effect.sync(() => {
        calls.push(`stop:${sessionId}`)
      }).pipe(Effect.andThen(actionOverrides.stopSession?.(sessionId, update) ?? Effect.succeed(true))),
      remove: (removal: { kind: string }) => Effect.sync(() => {
        calls.push(`remove:${removal.kind}`)
        return true
      }),
      openModal: (value: ApplicationModal) => modal(value).pipe(Effect.as(true)),
      closeModal: Effect.suspend(() => modal(null)).pipe(Effect.as(true)),
      handleTerminalActivity: () => Effect.succeed(true),
      handleTerminalExit: () => Effect.succeed(true),
      handleTerminalSessionChanged: () => Effect.succeed(true),
      handleTerminalTransitionError: () => Effect.succeed(true),
    } as unknown as AppRuntime
    return { runtime, calls, modalUpdates, update }
  })
}

function rootsView(firstTitle = "First conversation"): ApplicationViewModel {
  return {
    ...baseView(),
    surface: {
      _tag: "Roots",
      roots: [
        {
          sessionId: "root-1",
          title: firstTitle,
          lastModified: 2,
          memberSessionIds: ["root-1"],
          status: "idle",
          selected: true,
        },
        {
          sessionId: "root-2",
          title: "Second conversation",
          lastModified: 1,
          memberSessionIds: ["root-2"],
          status: "working",
          selected: false,
        },
      ],
    },
  }
}

function linearGraph(familySessionId: string, title: string, preview: string): ApplicationViewModel {
  const message = messageNode("message", preview, 24, 0, [], ["endpoint"], true, familySessionId)
  const endpoint = endpointNode("endpoint", familySessionId, title, 24, 4, ["message"], false)
  return graphView(familySessionId, title, [message, endpoint])
}

function branchingGraph(familySessionId: string, title: string): ApplicationViewModel {
  const source = messageNode("source", "branch source", 20, 0, [], ["left-message", "right-message"], true, familySessionId)
  const left = messageNode("left-message", "left branch", 2, 4, ["source"], ["left-endpoint"], false, familySessionId)
  const right = messageNode("right-message", "right branch", 38, 4, ["source"], ["right-endpoint"], false, familySessionId)
  const leftEndpoint = endpointNode("left-endpoint", "left", "Left leaf", 2, 8, ["left-message"], false)
  const rightEndpoint = endpointNode("right-endpoint", "right", "Right leaf", 38, 8, ["right-message"], false)
  return graphView(familySessionId, title, [source, left, right, leftEndpoint, rightEndpoint])
}

function endpointGraph(sessionId = "endpoint"): ApplicationViewModel {
  return withLiveSessions(graphView("root-1", "Draft conversation", [
    endpointNode("endpoint", sessionId, "Draft session", 24, 0, [], true, {
      text: "pending text",
      exact: false,
    }),
  ]), [sessionId])
}

function withLiveSessions(
  viewModel: ApplicationViewModel,
  sessionIds: readonly string[],
): ApplicationViewModel {
  return { ...viewModel, liveSessionIds: new Set(sessionIds) }
}

function ambiguousStoppedEndpointGraph(
  selection: "endpoint" | "source",
  live: boolean,
): ApplicationViewModel {
  const source = messageNode(
    "source",
    "shared source",
    20,
    0,
    [],
    ["stopped-endpoint", "other-endpoint"],
    selection === "source",
    "root",
  )
  const stopped = {
    ...endpointNode("stopped-endpoint", "stopped", "Stopped fork", 0, 4, [source.id], selection === "endpoint"),
    fork: {
      sourceNodeId: source.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      empty: true,
    },
  }
  const other = {
    ...endpointNode("other-endpoint", "other", "Other leaf", 40, 4, [source.id], false),
    session: { id: "other", title: "Other leaf", lastModified: 2 },
  }
  const view = graphView("root", "Stopped preference", [source, stopped, other])
  return withLiveSessions(view, live ? ["stopped"] : [])
}

function graphView(
  familySessionId: string,
  title: string,
  nodes: readonly GraphNodeViewModel[],
): ApplicationViewModel {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const projectedNodes = nodes.map((node): GraphNodeViewModel => ({
    ...node,
    reachableEndpoints: reachablePresentationEndpoints(node.id, nodeById),
  }))
  return {
    ...baseView(),
    surface: {
      _tag: "Graph",
      familySessionId,
      title,
      nodes: projectedNodes,
      selectedNodeId: projectedNodes.find((node) => node.selected)?.id ?? null,
      status: "idle",
      warnings: [],
      worldWidth: Math.max(...projectedNodes.map((node) => node.x + node.width)),
      worldHeight: Math.max(...projectedNodes.map((node) => node.y + node.height)),
    },
  }
}

function messageNode(
  id: string,
  preview: string,
  x: number,
  y: number,
  parentIds: readonly string[],
  childIds: readonly string[],
  selected: boolean,
  sessionId: string,
): GraphNodeViewModel {
  const ref = { sessionId, messageId: id }
  return {
    _tag: "Message",
    id,
    parentIds,
    childIds,
    x,
    y,
    width: 32,
    height: 2,
    target: { kind: "message", preferred: ref, aliases: [ref] },
    selected,
    reachableEndpoints: [],
    role: "user",
    preview,
    aliases: [ref],
  }
}

function endpointNode(
  id: string,
  sessionId: string,
  title: string,
  x: number,
  y: number,
  parentIds: readonly string[],
  selected: boolean,
  draft?: { text: string; exact: boolean },
): GraphNodeViewModel {
  return {
    _tag: "Endpoint",
    id,
    parentIds,
    childIds: [],
    x,
    y,
    width: 32,
    height: 2,
    target: { kind: "endpoint", sessionId },
    selected,
    session: { id: sessionId, title, lastModified: sessionId === "right" ? 2 : 1 },
    status: "idle",
    draft,
    fork: undefined,
    reachableEndpoints: [],
  }
}

function baseView(): Omit<ApplicationViewModel, "surface"> {
  return {
    modal: null,
    refreshing: false,
    initialLoadPending: false,
    shuttingDown: false,
    liveSessionIds: new Set(),
  }
}

function reachablePresentationEndpoints(
  nodeId: string,
  nodes: ReadonlyMap<string, GraphNodeViewModel>,
) {
  const queue = [{ nodeId, distance: 0 }]
  const visited = new Set<string>()
  const endpoints = []
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    if (visited.has(current.nodeId)) continue
    visited.add(current.nodeId)
    const node = nodes.get(current.nodeId)
    if (!node) continue
    if (node._tag === "Endpoint") {
      endpoints.push({
        session: node.session,
        status: node.status,
        draft: node.draft,
        fork: node.fork,
        distance: current.distance,
        visibleNodeId: node.id,
      })
    } else {
      for (const childId of node.childIds) queue.push({ nodeId: childId, distance: current.distance + 1 })
    }
  }
  return endpoints.sort((left, right) =>
    left.distance - right.distance ||
    right.session.lastModified - left.session.lastModified ||
    left.session.id.localeCompare(right.session.id)
  )
}

function canonicalSavedGraph(): ApplicationViewModel {
  return canonicalView(
    [agentSession("saved", "Saved conversation", 1)],
    new Map([["saved", [agentMessage("saved-question", "saved question", 0)]]]),
    [],
    "saved",
    { kind: "message", preferred: { sessionId: "saved", messageId: "saved-question" }, aliases: [] },
  )
}

function canonicalBranchingGraph(): ApplicationViewModel {
  const sessions = [
    agentSession("root", "Older root", 10),
    agentSession("child", "Newer child", 20),
  ]
  const transcripts = new Map<string, readonly AgentMessage[]>([
    ["root", [
      agentMessage("root-source", "canonical source", 0),
      agentMessage("root-tail", "older path", 1),
    ]],
    ["child", [
      agentMessage("child-source", "canonical source", 0),
      agentMessage("child-tail", "newer path", 1),
    ]],
  ])
  return canonicalView(
    sessions,
    transcripts,
    [{
      childSessionId: "child",
      parentSessionId: "root",
      sourceMessageId: "root-source",
      sharedMessages: [{ parentMessageId: "root-source", childMessageId: "child-source" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    "root",
    { kind: "message", preferred: { sessionId: "root", messageId: "root-source" }, aliases: [] },
  )
}

function canonicalStoppedForkGraph(): ApplicationViewModel {
  const sessions = [
    agentSession("root", "Fork family", 30),
    agentSession("fork-one", "First fork", 20),
    agentSession("fork-two", "Second fork", 10),
  ]
  const transcripts = new Map<string, readonly AgentMessage[]>([
    ["root", [agentMessage("source", "fork source", 0), agentMessage("main", "main path", 1)]],
    ["fork-one", [agentMessage("copy-one", "fork source", 0)]],
    ["fork-two", [agentMessage("copy-two", "fork source", 0)]],
  ])
  return canonicalView(
    sessions,
    transcripts,
    [
      {
        childSessionId: "fork-one",
        parentSessionId: "root",
        sourceMessageId: "source",
        sharedMessages: [{ parentMessageId: "source", childMessageId: "copy-one" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        childSessionId: "fork-two",
        parentSessionId: "root",
        sourceMessageId: "source",
        sharedMessages: [{ parentMessageId: "source", childMessageId: "copy-two" }],
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    "root",
    { kind: "endpoint", sessionId: "fork-one" },
  )
}

function canonicalWarningGraph(): ApplicationViewModel {
  return canonicalView(
    [agentSession("root", "Warning root", 2), agentSession("child", "Detached child", 1)],
    new Map([
      ["root", [agentMessage("question", "warning question", 0)]],
      ["child", []],
    ]),
    [{
      childSessionId: "child",
      parentSessionId: "root",
      sourceMessageId: "missing",
      sharedMessages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    "root",
    { kind: "message", preferred: { sessionId: "root", messageId: "question" }, aliases: [] },
  )
}

function canonicalView(
  sessions: readonly AgentSession[],
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
  relations: ApplicationState["relations"],
  familySessionId: string,
  target: NavigationTarget,
): ApplicationViewModel {
  const initial = makeInitialApplicationState({
    relations,
    surface: { _tag: "Graph", familySessionId, target },
  })
  const state: ApplicationState = {
    ...initial,
    provider: {
      sessions: new Map(sessions.map((session) => [session.id, session])),
      transcripts: new Map([...transcripts].map(([sessionId, messages]) => [sessionId, available(messages)])),
    },
    refresh: { generation: 1, active: new Map(), initialPending: false, appliedGenerationBySession: new Map() },
  }
  return projectApplicationViewModel(state)
}

function agentSession(id: string, title: string, lastModified: number): AgentSession {
  return { id, title, lastModified }
}

function agentMessage(id: string, preview: string, ordinal: number): AgentMessage {
  return { id, role: "user", preview, ordinal, visible: true }
}

function manyLeafGraph(): ApplicationViewModel {
  const source = messageNode("many", "many leaves", 14, 0, [], [], true, "root")
  const endpoints = Array.from({ length: 12 }, (_, index) =>
    endpointNode(
      `leaf-endpoint-${index + 1}`,
      `leaf-${index + 1}`,
      `Leaf ${index + 1}`,
      index * 4,
      4,
      [source.id],
      false,
    )
  )
  return graphView("root", "Many leaves", [
    { ...source, childIds: endpoints.map((endpoint) => endpoint.id) },
    ...endpoints,
  ])
}

function pickerStatusGraph(): ApplicationViewModel {
  const source = messageNode("statuses", "picker statuses", 20, 0, [], ["live", "update", "blocked"], true, "root")
  const live = { ...endpointNode("live", "live", "Live leaf", 0, 4, [source.id], false), status: "idle" as const }
  const update = { ...endpointNode("update", "update", "Update leaf", 20, 4, [source.id], false), status: "unviewed" as const }
  const blocked = { ...endpointNode("blocked", "blocked", "Blocked leaf", 40, 4, [source.id], false), status: "blocked" as const }
  const view = graphView("root", "Picker statuses", [source, live, update, blocked])
  return { ...view, liveSessionIds: new Set(["live"]) }
}

function coordinateOf(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(text)
    if (x >= 0) return { x, y }
  }
  throw new Error(`Could not find ${text} in frame:\n${frame}`)
}

function targetKey(target: NavigationTarget): string {
  return target.kind === "endpoint"
    ? `endpoint:${target.sessionId}`
    : `message:${target.preferred.sessionId}:${target.preferred.messageId}`
}

function endpointTitle(viewModel: ApplicationViewModel | undefined, sessionId: string): string {
  if (viewModel?.surface._tag !== "Graph") return sessionId
  const endpoint = viewModel.surface.nodes.find((node) =>
    node._tag === "Endpoint" && node.session.id === sessionId
  )
  return endpoint?._tag === "Endpoint" ? endpoint.session.title : sessionId
}

function releaseKittyKey(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  codepoint: number,
  modifiers = 1,
): void {
  setup.renderer.stdin.emit("data", Buffer.from(`\x1B[${codepoint};${modifiers}:3u`))
}

function isSelected(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
): boolean {
  return selectedSpan(setup, text) !== undefined
}

function selectedSpan(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
) {
  return setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes(text) && span.bg.equals(presentationTheme.selected))
}

async function frame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (value: string) => boolean,
): Promise<string> {
  const deadline = performance.now() + 2_000
  let value = ""
  while (performance.now() < deadline) {
    await Bun.sleep(10)
    await setup.renderOnce()
    value = setup.captureCharFrame()
    if (predicate(value)) return value
  }
  throw new Error(`Timed out waiting for frame:\n${value}`)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition")
}
