import { Schema } from "effect"

// Only the fields consumed by transcript validation and lifecycle observation.
export const CodexTurnStatusSchema = Schema.Literals(["completed", "interrupted", "failed", "inProgress"])

export const CodexThreadStatusNotificationSchema = Schema.Struct({
  threadId: Schema.String,
  status: Schema.Union([
    Schema.Struct({ type: Schema.Literal("notLoaded") }),
    Schema.Struct({ type: Schema.Literal("idle") }),
    Schema.Struct({ type: Schema.Literal("systemError") }),
    Schema.Struct({
      type: Schema.Literal("active"),
      activeFlags: Schema.Array(Schema.Literals(["waitingOnApproval", "waitingOnUserInput"])),
    }),
  ], { mode: "oneOf" }),
})
