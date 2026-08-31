import { describe, expect, test } from "bun:test"

import { Osc52Forwarder, decodeOsc52Write } from "../src/clipboard"

const encoder = new TextEncoder()

describe("Osc52Forwarder", () => {
  test("decodes clipboard writes terminated by BEL", () => {
    const forwarder = new Osc52Forwarder()
    expect(forwarder.observe(encoder.encode("\x1b]52;c;aHR0cHM6Ly9leGFtcGxlLmNvbQ==\x07"))).toEqual([
      "https://example.com",
    ])
  })

  test("reassembles writes split across chunks and an ST terminator", () => {
    const forwarder = new Osc52Forwarder()
    expect(forwarder.observe(encoder.encode("prefix\x1b]52;;Y29w"))).toEqual([])
    expect(forwarder.observe(encoder.encode("eSBtZQ==\x1b"))).toEqual([])
    expect(forwarder.observe(encoder.encode("\\suffix"))).toEqual(["copy me"])
  })

  test("recognizes tmux passthrough with doubled inner escapes", () => {
    const forwarder = new Osc52Forwarder()
    expect(
      forwarder.observe(
        encoder.encode("\x1bPtmux;\x1b\x1b]52;c;Y29weSB0aHJvdWdoIHRtdXg=\x1b\x1b\\\x1b\\"),
      ),
    ).toEqual(["copy through tmux"])
  })

  test("ignores queries, unsupported selectors, malformed base64, and unrelated output", () => {
    const forwarder = new Osc52Forwarder()
    expect(
      forwarder.observe(
        encoder.encode(
          "plain text\x1b]52;c;?\x07\x1b]52;p;aGk=\x07\x1b]52;c;not base64!\x07",
        ),
      ),
    ).toEqual([])
  })

  test("forwards multiple writes from one PTY chunk", () => {
    const forwarder = new Osc52Forwarder()
    expect(
      forwarder.observe(encoder.encode("\x1b]52;c;b25l\x07\x1b]52;c;dHdv\x1b\\")),
    ).toEqual(["one", "two"])
  })
})

test("decodeOsc52Write rejects non-UTF-8 clipboard data", () => {
  expect(decodeOsc52Write([...encoder.encode("52;c;/w==")])).toBeNull()
})
