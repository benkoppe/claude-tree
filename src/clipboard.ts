const ESCAPE = 0x1b
const BELL = 0x07
const OSC_MARKER = 0x5d
const STRING_TERMINATOR = 0x5c
const MAX_OSC52_BODY_BYTES = 256 * 1024

type ParserState = "ground" | "escape" | "osc" | "osc-escape"

export class Osc52Forwarder {
  private state: ParserState = "ground"
  private body: number[] = []

  observe(bytes: Uint8Array): string[] {
    const clipboardWrites: string[] = []

    for (const byte of bytes) {
      if (this.state === "ground") {
        if (byte === ESCAPE) this.state = "escape"
      } else if (this.state === "escape") {
        if (byte === OSC_MARKER) {
          this.body = []
          this.state = "osc"
        } else if (byte !== ESCAPE) {
          this.state = "ground"
        }
      } else if (this.state === "osc") {
        if (byte === BELL) {
          this.finish(clipboardWrites)
          this.state = "ground"
        } else if (byte === ESCAPE) {
          this.state = "osc-escape"
        } else {
          this.body.push(byte)
        }
      } else if (byte === STRING_TERMINATOR) {
        this.finish(clipboardWrites)
        this.state = "ground"
      } else if (byte === ESCAPE) {
        // tmux passthrough doubles the inner escape, including the one in ST.
        this.state = "osc-escape"
      } else {
        this.body.push(ESCAPE, byte)
        this.state = "osc"
      }

      if (this.body.length > MAX_OSC52_BODY_BYTES) {
        this.body = []
        this.state = "ground"
      }
    }

    return clipboardWrites
  }

  private finish(clipboardWrites: string[]): void {
    const text = decodeOsc52Write(this.body)
    if (text !== null) clipboardWrites.push(text)
    this.body = []
  }
}

export function decodeOsc52Write(body: readonly number[]): string | null {
  if (body[0] !== 0x35 || body[1] !== 0x32 || body[2] !== 0x3b) return null

  const separator = body.indexOf(0x3b, 3)
  if (separator < 0) return null
  const selector = body.slice(3, separator)
  if (selector.length > 1 || (selector.length === 1 && selector[0] !== 0x63)) return null

  const payloadBytes = body.slice(separator + 1)
  if (payloadBytes.length === 0 || (payloadBytes.length === 1 && payloadBytes[0] === 0x3f)) {
    return null
  }
  if (payloadBytes.some((byte) => !isBase64Byte(byte))) return null

  const payload = Buffer.from(payloadBytes).toString("ascii")
  if (payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null

  const decoded = Buffer.from(payload, "base64")
  if (decoded.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) return null

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded)
    return text.length > 0 && !text.includes("\0") ? text : null
  } catch {
    return null
  }
}

function isBase64Byte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2b ||
    byte === 0x2f ||
    byte === 0x3d
  )
}
