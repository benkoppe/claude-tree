import { expect, test } from "bun:test"

import { errorDetails, errorSummary } from "../src/error-format"
import { TerminalCleanupError } from "../src/services/terminal-supervisor"

test("summaries preserve useful text and never accept a blank message", () => {
  expect(errorSummary(new Error("first line\nsecond line"))).toBe("first line\nsecond line")
  expect(errorSummary({ message: "  useful detail  " })).toBe("  useful detail  ")
  expect(errorSummary(new Error(""))).toBe("Error")
  expect(errorSummary({ message: " \n ", _tag: "TaggedFailure" })).toBe("TaggedFailure")
  expect(errorSummary({ message: "", name: "NamedFailure" })).toBe("NamedFailure")
  expect(errorSummary(" ")).toBe("Unknown error")
  expect(errorSummary(undefined)).toBe("Unknown error (undefined)")
  expect(errorSummary(null)).toBe("Unknown error (null)")
  expect(errorSummary(42)).toBe("42")
  expect(errorSummary({ unexpected: "private payload" })).toBe("Unknown error")
})

test("formatting survives throwing error accessors and conversion methods", () => {
  const error = { _tag: "BrokenError", get message() { throw new Error("getter failed") } }
  expect(errorSummary(error)).toBe("BrokenError")
  expect(errorDetails(error)).toBe("BrokenError")
  const inaccessible = new Proxy({}, {
    get() { throw new Error("inaccessible") },
    getPrototypeOf() { throw new Error("inaccessible") },
  })
  expect(errorSummary(inaccessible)).toBe("Unknown error")
  expect(errorDetails(inaccessible)).toContain("Unknown error")
})

test("details include nested causes and every aggregate child without dumping unrelated fields", () => {
  const source = new Error("disk offline")
  const wrapper = new Error("save failed", { cause: source })
  const aggregate = new AggregateError([wrapper, new Error("worker stuck")], "Navigation cleanup failed")
  Object.assign(aggregate, { privateData: "never display this" })
  const details = errorDetails(aggregate)
  expect(details).toBe("Navigation cleanup failed\nError 1: save failed\n  Caused by: disk offline\nError 2: worker stuck")
  expect(aggregate.errors[0]).toBe(wrapper)
  expect(wrapper.cause).toBe(source)
  expect(details).not.toContain("never display this")
  expect(errorDetails(new AggregateError(["child explanation"]))).toContain("child explanation")
})

test("cycles terminate, while shared causes remain visible under each failure", () => {
  const circular = new Error("circular")
  circular.cause = circular
  expect(errorDetails(circular)).toContain("[Circular error reference]")
  const shared = new Error("shared cause")
  expect(errorDetails(new AggregateError([shared, shared], "two failures")))
    .toBe("two failures\nError 1: shared cause\nError 2: shared cause")
})

test("excessive nesting and aggregate width have explicit omission markers", () => {
  let nested: Error = new Error("deepest")
  for (let i = 0; i < 100; i++) nested = new Error(`level ${i}`, { cause: nested })
  expect(errorDetails(nested)).toContain("[Further error details omitted]")
  const wide = new AggregateError(Array.from({ length: 1_000 }, (_, i) => new Error(`child ${i}`)), "wide")
  expect(errorDetails(wide)).toContain("[Further error details omitted]")
  const longMessage = "original message ".repeat(1_000)
  expect(errorDetails(new Error(longMessage))).toBe(longMessage)
})

test("terminal cleanup messages include all issue contexts and underlying failures", () => {
  const cause = new Error("state lock timed out")
  const issues = [
    { ownerId: "owner-1", sessionId: "session-1", stage: "lease" as const, message: "Unable to release ownership", cause },
    { ownerId: "terminal-supervisor", sessionId: "", stage: "runtime" as const, message: "Runtime scope did not close" },
  ]
  const error = new TerminalCleanupError({ operation: "shutdown", issues, ownershipReleased: true })
  expect(error.message).toBe(
    "Terminal shutdown cleanup failed:\nsession session-1 [lease]: Unable to release ownership\n  Caused by: state lock timed out\nterminal-supervisor [runtime]: Runtime scope did not close",
  )
  expect(errorSummary(error)).toBe(error.message)
  expect(errorDetails(error)).toBe(error.message)
  expect(error.issues).toBe(issues)
  expect(error.issues[0]?.cause).toBe(cause)
  expect(error.ownershipReleased).toBeTrue()
})

test("empty issue lists and cyclic structured cleanup failures still have useful messages", () => {
  expect(new TerminalCleanupError({ operation: "stop", issues: [] }).message)
    .toBe("Terminal stop cleanup failed (no issue details available)")
  const issue = { ownerId: "owner", sessionId: "session", stage: "provider" as const, message: "provider close failed", cause: undefined as unknown }
  const error = new TerminalCleanupError({ operation: "shutdown", issues: [issue] })
  issue.cause = error
  expect(error.message).toContain("[Circular error reference]")
  expect(error.message).toContain("session session [provider]: provider close failed")
})
