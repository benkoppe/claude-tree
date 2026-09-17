import { Cause } from "effect"

export const describeError = Symbol("describeError")

export interface ErrorDescription {
  readonly message: string
  readonly children?: readonly { readonly label: string; readonly error: unknown }[]
}

const MAX_DETAIL_DEPTH = 16
const MAX_DETAIL_NODES = 256

/** Squashing a compound Effect cause would retain only its first failure. */
export function causeFailures(cause: Cause.Cause<unknown>): readonly unknown[] {
  const failures = cause.reasons.flatMap((reason) => reason._tag === "Fail"
    ? [reason.error]
    : reason._tag === "Die" ? [reason.defect] : [])
  return failures.length > 0 ? failures : [Cause.squash(cause)]
}

/** A concise, nonempty explanation; preserve meaningful original message text. */
export function errorSummary(error: unknown): string {
  if (isReference(error)) {
    return nonempty(read(error, "message")) ?? errorName(error)
  }
  if (typeof error === "string") return nonempty(error) ?? "Unknown error"
  return error === undefined || error === null ? `Unknown error (${String(error)})` : String(error)
}

/** Structured descriptions avoid reentering an error's derived message getter. */
export function errorDetails(error: unknown): string {
  const ancestors = new Set<object>()
  let remaining = MAX_DETAIL_NODES
  const render = (value: unknown, depth: number): string => {
    if (isReference(value) && ancestors.has(value)) return "[Circular error reference]"
    if (depth >= MAX_DETAIL_DEPTH || remaining-- <= 0) return "[Further error details omitted]"
    if (!isReference(value)) return errorSummary(value)
    ancestors.add(value)
    try {
      let description: ErrorDescription
      const describe = read(value, describeError)
      if (typeof describe === "function") {
        description = describe.call(value) as ErrorDescription
      } else {
        const children: Array<{ label: string; error: unknown }> = []
        if (value instanceof AggregateError || Array.isArray(value)) {
          const errors: unknown = Array.isArray(value) ? value : read(value, "errors")
          if (Array.isArray(errors)) {
            for (const [index, child] of errors.entries()) {
              children.push({ label: `Error ${index + 1}`, error: child })
              if (children.length >= MAX_DETAIL_NODES) break
            }
            if (errors.length > children.length) children.push({ label: "More errors", error: "[Further error details omitted]" })
          }
        }
        const cause = read(value, "cause")
        if (cause !== undefined) children.push({ label: "Caused by", error: cause })
        description = { message: Array.isArray(value) ? "Multiple errors" : errorSummary(value), children }
      }
      const lines = [nonempty(description.message) ?? errorName(value)]
      for (const child of description.children ?? []) {
        if (remaining <= 0) {
          lines.push("[Further error details omitted]")
          break
        }
        const detail = render(child.error, depth + 1)
        lines.push(`${child.label}: ${detail.replaceAll("\n", "\n  ")}`)
      }
      return lines.join("\n")
    } catch {
      return `${errorName(value)} [Error details unavailable]`
    } finally {
      ancestors.delete(value)
    }
  }
  return render(error, 0)
}

function errorName(error: object): string {
  return nonempty(read(error, "_tag")) ?? nonempty(read(error, "name")) ?? "Unknown error"
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function isReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

function read(value: object, key: PropertyKey): unknown {
  try { return Reflect.get(value, key) } catch { return undefined }
}
