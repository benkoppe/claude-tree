import { OscSequenceParser } from "./osc"

export class Osc52Forwarder {
  private readonly parser = new OscSequenceParser()

  observe(bytes: Uint8Array): string[] {
    return this.parser
      .observe(bytes)
      .map(decodeOsc52Write)
      .filter((text): text is string => text !== null)
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
