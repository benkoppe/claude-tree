import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

// Deliberate update only: never fetch moving main during installation or startup.
const revision = "de343914273eceb852a1d1d739cd1d38df7796ee"
const files = [
  "protocol.ts", "errors.ts", "_internal/shared.ts", "_generated/schema.gen.ts",
] as const

const extracted = await Promise.all(files.map(async (file) => {
  const response = await fetch(`https://raw.githubusercontent.com/pingdotgg/t3code/${revision}/packages/effect-codex-app-server/src/${file}`)
  if (!response.ok) throw new Error(`Upstream fetch failed for ${file}: ${response.status}`)
  const destination = resolve(import.meta.dir, "../src/vendor/t3/codex", file)
  const text = await response.text()
  const content = file === "_generated/schema.gen.ts" ? selectLifecycleCodecs(text)
    : file === "protocol.ts" ? adaptProtocol(text) : text
  return { destination, content }
}))
for (const { destination, content } of extracted) {
  if (process.argv.includes("--check")) {
    if (await readFile(destination, "utf8") !== content) throw new Error(`Vendor drift: ${destination}`)
  } else {
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
}

function adaptProtocol(source: string): string {
  const replace = (before: string, after: string) => {
    if (!source.includes(before)) throw new Error("Upstream protocol changed; review local dispatch adaptations")
    source = source.replace(before, after)
  }
  replace("  readonly stdio: Stdio.Stdio;", `  readonly stdio: Stdio.Stdio;
  /** Host-owned bounded writer tracks dispatch and cancellation of mutations. */
  readonly sendWire?: (encoded: string) => Effect.Effect<void, CodexError.CodexAppServerError>;`)
  replace(`  readonly request: (
    method: string,
    payload?: unknown,`, `  readonly request: (
    method: string,
    payload?: unknown,
    requestId?: number,`)
  replace("    const request = (method: string, payload?: unknown) =>", "    const request = (method: string, payload?: unknown, assignedRequestId?: number) =>")
  replace(`        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );`, `        const requestId = assignedRequestId ?? (yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        ));`)
  replace("        const accepted = yield* Queue.offer(outgoing, encoded);", `        if (options.sendWire) return yield* options.sendWire(encoded);
        const accepted = yield* Queue.offer(outgoing, encoded);`)
  replace(`        yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(Effect.tapError(() => removePending(String(requestId))));
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => removePending(String(requestId))),
        );`, `        return yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.ensuring(removePending(String(requestId))),
        );`)
  replace("    yield* Stream.fromQueue(outgoing).pipe(Stream.run(options.stdio.stdout()), Effect.forkScoped);", `    if (!options.sendWire) yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(options.stdio.stdout()),
      Effect.catchCause((cause) => handleTermination(() => Effect.succeed(
        normalizeIncomingError(Cause.squash(cause), "read-input-stream"),
      ))),
      Effect.forkScoped,
    );`)
  return source
}

function selectLifecycleCodecs(source: string): string {
  const declarations = [...source.matchAll(/^export (?:type|const) (\w+)/gm)]
  const blocks = declarations.map((match, index) => ({
    name: match[1]!,
    text: source.slice(match.index, declarations[index + 1]?.index ?? source.length),
  }))
  const names = new Set(blocks.map((block) => block.name))
  const selected = new Set(["V2ThreadStatusChangedNotification", "V2TurnCompletedNotification__TurnStatus"])
  for (const name of selected) {
    for (const block of blocks.filter((block) => block.name === name)) {
      for (const reference of block.text.matchAll(/\b\w+\b/g)) {
        if (names.has(reference[0])) selected.add(reference[0])
      }
    }
  }
  return `// Generated subset from T3 Code ${revision}; do not edit.\nimport * as Schema from "effect/Schema";\n\n` +
    blocks.filter((block) => selected.has(block.name)).map((block) => block.text).join("").trimEnd() + "\n"
}
