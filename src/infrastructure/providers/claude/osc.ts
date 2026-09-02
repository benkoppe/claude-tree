const ESCAPE = 0x1b
const BELL = 0x07
const OSC_MARKER = 0x5d
const STRING_TERMINATOR = 0x5c
const MAX_OSC_BODY_BYTES = 256 * 1024

type ParserState = "ground" | "escape" | "osc" | "osc-escape"

export class OscSequenceParser {
  private state: ParserState = "ground"
  private body: number[] = []

  observe(bytes: Uint8Array): number[][] {
    const sequences: number[][] = []

    for (const byte of bytes) {
      if (this.state === "ground") {
        if (byte === ESCAPE) this.state = "escape"
      } else if (this.state === "escape") {
        if (byte === OSC_MARKER) this.startOsc()
        else if (byte !== ESCAPE) this.state = "ground"
      } else if (this.state === "osc") {
        if (byte === BELL) {
          this.finish(sequences)
        } else if (byte === ESCAPE) {
          this.state = "osc-escape"
        } else {
          this.body.push(byte)
        }
      } else if (byte === STRING_TERMINATOR) {
        this.finish(sequences)
      } else if (byte === ESCAPE) {
        this.state = "osc-escape"
      } else {
        this.body.push(ESCAPE, byte)
        this.state = "osc"
      }

      if (this.body.length > MAX_OSC_BODY_BYTES) this.reset()
    }

    return sequences
  }

  private startOsc(): void {
    this.body = []
    this.state = "osc"
  }

  private finish(sequences: number[][]): void {
    sequences.push(this.body)
    this.reset()
  }

  private reset(): void {
    this.body = []
    this.state = "ground"
  }
}
