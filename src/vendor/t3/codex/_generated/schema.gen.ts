// Generated subset from T3 Code de343914273eceb852a1d1d739cd1d38df7796ee; do not edit.
import * as Schema from "effect/Schema";

export type V2ThreadStatusChangedNotification__ThreadActiveFlag =
  | "waitingOnApproval"
  | "waitingOnUserInput";
export const V2ThreadStatusChangedNotification__ThreadActiveFlag = Schema.Literals([
  "waitingOnApproval",
  "waitingOnUserInput",
]).annotate({ identifier: "V2ThreadStatusChangedNotification__ThreadActiveFlag" });

export type V2TurnCompletedNotification__TurnStatus =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";
export const V2TurnCompletedNotification__TurnStatus = Schema.Literals([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]).annotate({ identifier: "V2TurnCompletedNotification__TurnStatus" });

export type V2ThreadStatusChangedNotification__ThreadStatus =
  | { readonly type: "notLoaded" }
  | { readonly type: "idle" }
  | { readonly type: "systemError" }
  | {
      readonly activeFlags: ReadonlyArray<V2ThreadStatusChangedNotification__ThreadActiveFlag>;
      readonly type: "active";
    };
export const V2ThreadStatusChangedNotification__ThreadStatus = Schema.Union(
  [
    Schema.Struct({
      type: Schema.Literal("notLoaded").annotate({ title: "NotLoadedThreadStatusType" }),
    }).annotate({ title: "NotLoadedThreadStatus" }),
    Schema.Struct({
      type: Schema.Literal("idle").annotate({ title: "IdleThreadStatusType" }),
    }).annotate({ title: "IdleThreadStatus" }),
    Schema.Struct({
      type: Schema.Literal("systemError").annotate({ title: "SystemErrorThreadStatusType" }),
    }).annotate({ title: "SystemErrorThreadStatus" }),
    Schema.Struct({
      activeFlags: Schema.Array(V2ThreadStatusChangedNotification__ThreadActiveFlag),
      type: Schema.Literal("active").annotate({ title: "ActiveThreadStatusType" }),
    }).annotate({ title: "ActiveThreadStatus" }),
  ],
  { mode: "oneOf" },
).annotate({ identifier: "V2ThreadStatusChangedNotification__ThreadStatus" });

export type V2ThreadStatusChangedNotification = {
  readonly status: V2ThreadStatusChangedNotification__ThreadStatus;
  readonly threadId: string;
};
export const V2ThreadStatusChangedNotification = Schema.Struct({
  status: V2ThreadStatusChangedNotification__ThreadStatus,
  threadId: Schema.String,
}).annotate({ title: "ThreadStatusChangedNotification" });
