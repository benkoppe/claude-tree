import { expect, test } from "bun:test"

import { createHerdrReporter, NULL_HERDR_REPORTER } from "../src/herdr-reporter"

test("is disabled outside a Herdr pane", () => {
  expect(createHerdrReporter({ env: {} })).toBe(NULL_HERDR_REPORTER)
})

test("serializes and deduplicates pane status reports before releasing the pane", async () => {
  const calls: string[][] = []
  const reporter = createHerdrReporter(
    {
      env: {
        HERDR_ENV: "1",
        HERDR_BIN_PATH: "/tmp/herdr",
        HERDR_PANE_ID: "pane-7",
      },
      async run(command) {
        calls.push([...command])
      },
    },
  )

  reporter.report("working")
  await waitUntil(() => calls.length === 1)
  reporter.report("working")
  reporter.report("blocked")
  await waitUntil(() => calls.length === 2)
  await reporter.shutdown()

  expect(calls).toEqual([
    [
      "/tmp/herdr",
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "custom:claude-tree-lifecycle",
      "--agent",
      "claude-tree",
      "--state",
      "working",
    ],
    [
      "/tmp/herdr",
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "custom:claude-tree-lifecycle",
      "--agent",
      "claude-tree",
      "--state",
      "blocked",
    ],
    [
      "/tmp/herdr",
      "pane",
      "release-agent",
      "pane-7",
      "--source",
      "custom:claude-tree-lifecycle",
      "--agent",
      "claude-tree",
    ],
  ])
})

test("reasserts the current state after a transient registration failure", async () => {
  const calls: string[][] = []
  const reporter = createHerdrReporter({
    env: {
      HERDR_ENV: "1",
      HERDR_BIN_PATH: "/tmp/herdr",
      HERDR_PANE_ID: "pane-7",
    },
    async run(command) {
      calls.push([...command])
      if (calls.length === 1) throw new Error("server not ready")
    },
  })

  reporter.report("idle")
  await waitUntil(() => calls.length >= 2)
  expect(calls.slice(0, 2)).toEqual([
    [
      "/tmp/herdr",
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "custom:claude-tree-lifecycle",
      "--agent",
      "claude-tree",
      "--state",
      "idle",
    ],
    [
      "/tmp/herdr",
      "pane",
      "report-agent",
      "pane-7",
      "--source",
      "custom:claude-tree-lifecycle",
      "--agent",
      "claude-tree",
      "--state",
      "idle",
    ],
  ])
  await reporter.shutdown()
})

test("reasserts after Herdr's release reacquisition window", async () => {
  const reportTimes: number[] = []
  const startedAt = performance.now()
  const reporter = createHerdrReporter({
    env: {
      HERDR_ENV: "1",
      HERDR_BIN_PATH: "/tmp/herdr",
      HERDR_PANE_ID: "pane-7",
    },
    async run(command) {
      if (command.includes("report-agent")) reportTimes.push(performance.now() - startedAt)
    },
  })

  reporter.report("idle")
  await waitUntil(() => reportTimes.length === 3)
  expect(reportTimes[2]!).toBeGreaterThanOrEqual(1_400)
  await reporter.shutdown()
})

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!condition() && performance.now() < deadline) await Bun.sleep(10)
  expect(condition()).toBeTrue()
}
