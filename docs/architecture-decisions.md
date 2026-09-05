# Architecture Decisions

This document records decisions that shape the project and the reasons behind them. Specific libraries and versions are an initial baseline and can be upgraded or replaced when a better implementation preserves these constraints.

## Providers Are Explicit Application Dependencies

One provider is selected when the application starts and is injected into the application controller. The provider owns session discovery, transcript normalization, new and resumed session launch preparation, historical branch semantics, and interpretation of provider-specific terminal output. The application core owns graph construction, navigation, rendering, process lifecycle, and relationship persistence.

Session and message identifiers are opaque provider strings. The core must not assume UUIDs, provider CLI flags, transcript payload formats, or a particular branching implementation. Historical branch results expose validated parent-to-child message correspondence so the graph can merge shared history without understanding how the provider created it.

Branching is an explicit capability. A provider that cannot branch through a supported interface must report that limitation rather than editing transcripts or simulating fragile terminal input. Claude Code and Codex are shipped providers, and only one provider's sessions appear in a given application invocation.

## Stock Agent TUIs Run In Owned PTYs

Each live branch is a normal interactive provider process attached to its own pseudo-terminal and terminal emulator state. The application forwards input to the selected process and continues consuming output from every hidden process. Keep hidden emulators transparently composed beneath the navigator so provider-specific screen observers continue receiving updates without exposing another terminal surface.

Only the selected emulator is rendered. Switching views must not suspend or recreate unrelated agent processes.

Every in-memory terminal owner receives an immutable owner ID before acquisition begins. That ID, rather than the provider session ID, identifies the resource bundle and every asynchronous callback for its lifetime. Session IDs may move during provider-native identity adoption; owner IDs never do. Sequence terminal events as well so a delayed callback from an earlier state cannot mutate a replacement owner that happens to use the same session ID.

Opening a terminal is a transaction across persisted ownership and runtime resources. Reserve the provider session first, acquire provider-specific resources in a dedicated scope, create the emulator and PTY, register the owner synchronously after spawn, persist the process group, and only then give it focus. Roll back in reverse when any stage fails. If process-group registration or cleanup cannot be verified, retain the persisted reservation and expose cleanup-incomplete state instead of permitting a second owner.

This preserves the complete stock-agent experience and avoids maintaining a partial clone of its UI. It also rules out tmux and Herdr-style visible panes as the primary architecture.

The generic terminal manager executes provider-prepared commands and delegates activity and draft observation to a provider-created terminal observer. The initial implementation uses Bun's native PTY API with OpenTUI's `EmbeddedTerminalRenderable`, which uses Ghostty's VT parser. This combination has been validated in the development environment, but the ownership model is more important than those particular dependencies.

## Provider APIs Are Session Tools, Not The Chat Runtime

Use supported provider APIs for session discovery, message reads, and historical forks. For the Claude adapter, historical branching is based on `forkSession(sessionId, { upToMessageId })` rather than direct transcript manipulation. For Codex, short-lived `codex app-server --stdio` processes perform thread listing, reading, and forking; interactive work remains in the stock `codex resume <thread-id>` TUI.

The packaged SDK and CLI baseline is `@anthropic-ai/claude-agent-sdk` 0.3.251 with Claude Code 2.1.251. Upgrade the pinned SDK deliberately and verify session compatibility. Do not version-gate an externally installed Claude Code executable: metadata reads and historical forks use the pinned SDK, and every created fork must pass strict copied-prefix validation before its ancestry is saved. For Claude forks, validate each copied record through the SDK-imported child's explicit `forkedFrom` provenance and exact payload rather than assuming the SDK's reconstructed active transcript has the same length. If a changed transcript format prevents that validation, preserve the created child as an independent session rather than guessing its relationship.

The packaged and validated Codex baseline is 0.150.1. Do not version-gate an externally installed Codex executable: app-server responses are strictly validated, unsupported protocol changes fail the affected operation, and every historical fork must preserve its copied prefix exactly before ancestry is saved. One refresh batches all transcript reads through one app-server process, and every metadata operation closes its process after a bounded wait.

Distinguish ordinary request failure from mutation ambiguity. A provider mutation may have committed once its request was sent even if its response times out, the transport closes, or the returned child identity is invalid. Never retry such a mutation automatically. Return an explicit ambiguous outcome, perform a full provider snapshot reconciliation, and do not invent ancestry or launch a guessed child. Reads and requests proven not to have been sent may still use bounded retries. This rule applies to both Claude `forkSession` and Codex `thread/fork`.

Codex does not allocate or persist a new thread until its first user turn, so a fresh thread cannot be handed to `codex resume`. New Codex sessions instead launch the stock TUI against a dedicated authenticated loopback app-server and let the TUI call `thread/start` when the user submits that turn. The application initially owns that terminal under a temporary ID, then replaces it with the real ID reported by the sidecar's loaded-thread API. The terminal manager cleans up the sidecar with the TUI. Once the first turn is persisted, normal discovery and later resume use short-lived metadata operations and the ordinary local TUI path.

Locally prepared sessions are an immediate overlay on the last provider snapshot. Project them into the conversation forest and establish their navigator destination before activating their terminal, including when the provider has not persisted or discovered them yet. Returning from a terminal must reveal that local graph synchronously; provider refresh reconciles metadata and transcripts afterward rather than deciding which navigator view appears. Temporary-to-provider ID adoption updates terminal ownership and the local graph projection as one transition.

Identity adoption is forward-only because the provider has already changed identity before the application observes it. Commit the temporary-to-provider replacement in the unified provider-state transaction: move the persisted owner while preserving its owner token, replace every relationship, removal, and per-instance navigation reference, save any validated relation, and append a pending-adoption journal record. Only then update the in-memory owner's session aliases and notify the application actor. Acknowledgment removes the journal record after the actor has projected the new identity. An uncertain local commit reserves both identities, is retried or reconciled from the journal, and stops the terminal if ownership cannot be proven; it must never rename the provider back or roll an acknowledged move backward. Adoption onto another live owner fails closed.

Forked sessions do not include the source session's file-history snapshots. A historical conversation fork therefore does not provide historical file rewind. Because all branches share the current working tree, it also does not restore files to their state at the selected message.

## Relationships And Navigator State Need Application Metadata

Claude sessions are persisted independently. Historical forking remaps message UUIDs and does not retain enough source-branch information for this application to reconstruct a reliable cross-session tree later.

Store only the missing relationship data: the child session, parent session, source message, and validated correspondence between shared parent and child messages. Treat that correspondence as retained evidence in both directions when a later compaction omits mapped records, and reconcile restored logical paths transactionally so contradictory metadata cannot partially mutate a family graph. Persist navigator-removal and current-view records as application-owned UI state. Keep them outside the repository under the user's XDG state directory, scoped by canonical project and provider identity.

Persistence schema v3 is one strict provider-state document containing shared relationships and removals, navigation records keyed by application instance, terminal owners, and pending identity adoptions. All reads and writes use one cross-process transaction lock, semantic validation, canonical ordering, and atomic replacement with file and directory durability. Relationships, removals, ownership, identity journals, and every navigation reference can therefore move together without partially updating the provider state.

Schema v3 is deliberately reset-only while the product is in alpha. Reject v1, v2, unknown, non-canonical, and structurally or semantically corrupt documents in place. Also reject the old separate lease layout. Do not automatically migrate, delete, quarantine, or overwrite incompatible state; preserve it and require the user to move or remove it explicitly. A lock or owner is reclaimable only when liveness is definitely absent. Permission failures and unknown liveness retain ownership.

Relationships and removals are shared by all invocations for the same project and provider. Navigation is not: each foreground process receives an application-instance ID and may read or replace only its own navigation record. Concurrent invocations must not move each other's cursor, selected family, or terminal-return destination. A new process does not silently adopt another instance's navigation record.

Apply navigator removals after constructing the complete graph so relationship and message-alias resolution still use intact provider history. Prune only the selected tree or the selected node and its visual descendants from the navigator. Never edit or delete provider transcripts to implement removal.

Sessions and forks not created or recorded by `claude-tree` should still be usable. When their ancestry cannot be established reliably, show them as independent roots rather than guessing from message content.

## Claude User Messages Replay From The Previous Agent

Forking an agent message copies the transcript through that exact SDK message. Forking a user message has different semantics: copy through its nearest earlier agent, then open the child with the selected user text in Claude's composer without submitting it. Transcript order is authoritative, and adjacent messages may have the same role.

A user replay with no agent ancestor copies a zero-message prefix but remains in the same conversation family. The graph represents all top-level roots as children of one synthetic empty-history origin. That origin is application state rather than a Claude message or session: it is never rendered, selected, counted, or used as a fork target, and no connectors are drawn from it.

User replay initializes the stock Claude composer through `--prefill` rather than timing simulated PTY keystrokes. Prompts that cannot be represented as text fail closed rather than silently losing content.

Claude Code does not expose semantic composer state. The application may show a conservative, in-memory preview parsed from the visible input box when leaving a live terminal, but it must mark that preview as approximate and never persist it as transcript or relationship state.

Claude Code also does not expose semantic generation state to its terminal host. Observe its OSC terminal-title activity indicator directly from PTY output so hidden processes remain observable, with conservative matching against the last visible Claude screen as a fallback. Claude versions that pin an idle title under terminal multiplexers may still be working; a live bottom-screen working footer overrides that stale title, while a visible composer remains idle. Recognized permission and input prompts are blocked rather than working. Render a blocked live endpoint as an Agent that needs user input and aggregate that red attention state at its conversation root and leaf pickers, ahead of Working, yellow New updates, and green Live. Keep it unresolved for transcript stabilization until the provider returns to working or idle. An idle transition triggers a fresh SDK transcript read; keep the live endpoint visually pending until the rebuilt graph is ready so a completed agent message and its following draft leaf appear atomically. Keep activity state ephemeral and informational: process exit remains authoritative, and detection must not control permissions or inject input.

After Claude reports that a historical fork was created, retry bounded reads of its active transcript and copied-record provenance before validating correspondence. Create the provider fork only once and keep provenance and payload validation strict. Require the physical child to contain every source conversation record in order through the requested boundary, no records beyond it, and an exact source role and payload for each record. Claude's compaction reconstruction may omit records that the fork physically copied, so the active child transcript may be an ordered subsequence of the validated shared prefix; require it to reach the requested source and reject reordered, contradictory, or child-specific records within that prefix. If correspondence still cannot be validated, save no ancestry and refresh the created child as an independent root rather than guessing its relationship or deleting its provider transcript.

Claude compaction can also reconstruct a newer summary before older preserved records. Physical file order therefore proves copy integrity, but does not define conversation order. Validate every physical copied record, including inactive history, while saving shared message correspondence in the source SDK transcript's logical order. The active child must be an ordered subsequence of that logical prefix and reach the selected boundary. Inactive physical records are not automatically graph ancestry: they may belong to history replaced by compaction.

Automatic terminal-return and completion refreshes reread the affected sessions and merge them with cached unrelated transcripts; initial loads and explicit manual refreshes remain complete snapshots. Preserve every ordered activity transition reported in one PTY chunk. Because provider persistence can lag an idle title, retain the pending endpoint and retry with bounded backoff until the transcript advances to a provider-confirmed completed turn. If the session resumes working, reject the stale completion and keep newly persisted assistant-tail records behind the single working endpoint.

Provider history is not append-only: an external rewind or missed composer observation can shorten or replace it. Without an observed rewind, retain the previous history on the first unexpected idle read and automatically confirm with another incremental read after 100 ms. Accept two matching reads; stop after three changing reads and report the instability. This is a consistency heuristic, not a provider revision guarantee. Failed reads or renewed activity discard the candidate. A shortened prefix alone never proves a new turn completed: preserve the completion barrier through its bounded retries, then reconcile the replacement without marking a new update. Rebuild the graph from accepted history while retaining independently copied descendant evidence.

Compaction is distinct from rewind. Claude transcript reads also import SDK session records within the same bounded read deadline. A compact boundary's explicit `logicalParentUuid` links to the history it summarized. Ask the SDK to read an in-memory navigation projection that follows those links instead of its compact-context rewiring; never write this projection to the provider store. The SDK still chooses the current path and reconstructs streamed blocks, so abandoned rewind paths are not resurrected. Validate that the navigation history contains the active context's exact identities, roles, and payloads, and reject missing or cyclic compaction links rather than silently truncating history. This reconstruction works on fresh startup without caching or persisting message content.

Keep explicit compact summaries hidden in the normalized history; summary wording is not evidence. Mark pre-compaction records outside the active context as historical. Save validated fork correspondence in navigation-history order, independently of active-context ordering used for strict SDK fork validation. Forking a pre-compaction node validates against the SDK's read of the original records through that exact boundary. Existing relationships may omit historical records and order summaries before preserved messages; hidden boundaries and omitted historical prefixes must not invalidate their attachment. If an older provider record supplies no logical link, retain only independently validated shared history rather than guessing ancestry from physical order. Continuations attach to the last surviving shared node, falling back to the recorded source only when compaction omitted the entire shared prefix.

When a hidden live session reaches that provider-confirmed completion boundary, mark its Draft endpoint as having new updates and aggregate that state in the conversation-root picker. This state is ephemeral application UI state rather than provider or relationship metadata. Keep it while the session remains live, clearing it after the exact stock terminal is successfully shown or the live session is stopped or removed; navigator selection alone does not count as viewing the update.

Claude may persist one user turn as multiple assistant records, including streamed content blocks and continuations around tool calls. Normalize those raw records into one visible Agent node per user turn while retaining every UUID for prefix validation, removals, and provider operations. A newly selected grouped Agent forks from its latest represented raw boundary. An existing recorded fork closes the display group at its exact source so later parent content never appears before the branch.

## Codex Forks Only At Completed Turn Boundaries

Codex app-server forks whole turns rather than arbitrary transcript items. A valid Codex fork target is therefore the final agent item in a completed turn. User-message replay, system-item targets, intra-turn targets, and incomplete turns fail before creating a child. After a fork, compare the copied child prefix against the source payloads and fail closed if Codex did not preserve it exactly.

Codex terminal activity and draft previews are observed conservatively from its OSC title and visible composer. An action-required title or recognized confirmation prompt is blocked rather than being mistaken for working or completion, because the user must return to the stock TUI to resolve it.

## Graph Navigation Preserves Cursor Intent

Vertical navigation follows visible graph edges: up selects the parent and down selects a child. It never falls diagonally into a neighboring branch. Horizontal navigation uses the same world-space node layout as rendering and may cross branches, root chains, and viewport boundaries.

Navigation retains a preferred world-space column for vertical movement and depth for horizontal movement, plus the exact source of the latest transition. This mirrors a text-editor cursor: moving through an ambiguous parent or a shorter neighboring branch and then reversing returns to the node that was left. Blocked movement does not discard that intent. Rebuilding or resizing the graph resets it. The synthetic family origin does not participate in navigation.

Persist navigation using opaque session IDs and message aliases, never list indexes or generated graph node IDs. Scope every lookup to the current application-instance ID. If a runtime is reconstructed with that same ID, restore its surviving roots selection or graph target; if it recorded a terminal view, ask the provider to resume that session and fall back to its graph or the roots list when it is unavailable. A fresh process uses a fresh instance ID and starts from the default view. Persisted navigation identifies semantic provider state only. PTYs, emulator scrollback, modal state, and approximate drafts remain process-local.

## One Application Actor In One Foreground Process

Each invocation has one application-state actor. User input, terminal callbacks, command completions, refresh results, and shutdown state changes enter its ordered event queue; only the reducer executed by that actor may replace `ApplicationState`. Effects may run concurrently outside the actor, but they return immutable completion events instead of mutating application state directly. Terminal callbacks are serialized before dispatch and carry immutable owner IDs and sequence IDs so stale activity, exit, or identity events can be rejected deterministically.

Command completion delivery is an exit finalizer, including interruption, so a cancelled provider operation cannot strand its caller. Presentation actions run in isolated scoped fibers while retaining foreground ordering. Refresh and quit use a separate background lane: provider reads must not block navigation against the last accepted snapshot, and quitting must not queue behind a stalled fork or terminal launch. Initial loading and foreground mutations still guard conflicting input. Graph projection reuses unchanged forest inputs and indexes endpoint ancestry once rather than traversing every node's subtree separately.

This actor boundary is not a daemon. Provider PTYs and all runtime scopes still belong to the foreground process, and separate invocations have separate actors even though they coordinate durable provider state through the transaction lock.

Live PTYs belong to the foreground `claude-tree` process. Closing the application gracefully terminates its child agent processes and restores the host terminal. Persisted sessions can be resumed on the next launch.

Terminal launch resources have explicit provider cleanup in addition to scope finalization. A prepared launch acquires its provider sidecars, proxies, subscriptions, and capability files together and returns an idempotent close effect. Stopping or rollback invokes that close effect with bounded retries, then closes its provider scope. Scope finalizers are a backstop, not the primary ownership protocol. Do not release a persisted terminal owner until its process group is absent, provider cleanup and scope closure are confirmed, any identity adoption is settled, its PTY is closed, and the child has been detached with `unref`.

Shutdown releases the navigator and terminal emulators immediately, then remains in the foreground for a short, bounded cleanup of each owned agent process group. Keep PTYs open during the graceful termination window so the agent can finish its signal handling; escalate surviving process groups from `SIGTERM` to `SIGKILL`, verify absence, close their provider resources and PTYs, and detach them before the application exits. Unknown or failed verification is a cleanup failure, not successful shutdown.

Stopping one live endpoint uses the same bounded process-group cleanup but leaves every unrelated endpoint running. Mark the session as stopping and reserve its session ID before signaling it, so graph actions cannot start a second owner while cleanup is in progress. Keep that ownership reserved if cleanup cannot be proven complete; application shutdown is the final cleanup boundary.

Before persisting a navigator removal, stop every affected live session with this same bounded cleanup. Do not apply the removal while an affected session remains live.

After an intentional stop, rebuild the graph from a fresh provider transcript read. A Draft with no persisted message disappears. When that Draft belonged to a recorded fork with no child-specific visible node, always retain its session endpoint as a Fork leaf so each fork remains a distinct navigable leaf; number the Fork leaves when more than one is materialized at the same source. A working response is frozen only to the extent the provider persisted it, and later resume creates a fresh Draft after that persisted boundary. Never reconstruct or append transcript history from terminal emulator cells.

A daemon/client split is intentionally deferred. Add one only if surviving application exit becomes a real requirement; do not pay the lifecycle and IPC complexity merely to imitate a terminal multiplexer.

Do not run two live processes against the same provider session ID, because concurrent transcript ownership is unsafe. Different branches may run concurrently.

Shutdown is an idempotent direct lifecycle operation, not merely an event queued behind ordinary work. The presentation, signal path, and scope finalizer call the application runtime's shutdown API directly. It stops admission of new terminal work, flushes pending navigation, asks the terminal supervisor to clean every owner concurrently, and reports success only after verified cleanup. Scope interruption and process exit remain last-resort backstops; they must not be the normal way provider resources or leases are released.

## Herdr Integration Reports One Visible Agent

When Herdr supplies its pane environment, report activity through the Herdr CLI with a dedicated `custom:claude-tree-lifecycle` source. Reporting is optional, serialized, bounded, and non-fatal. Reassert state shortly after each transition, including once after Herdr's release reacquisition window, so rapid restarts, startup process-detection races, and transient command failures recover. Send a low-frequency heartbeat at one exact interval per cycle so a Herdr server restart does not permanently lose registration. A timed-out Herdr child receives bounded `SIGTERM` and `SIGKILL` exit-verification windows and is then detached with `unref`. Release the source during shutdown. Do not add a runtime dependency on Herdr.

Register the pane's agent as `claude-tree`, which is the foreground application Herdr actually hosts. Application view publication is the production reporting authority: while viewing a tree, report the same aggregate status as that tree's root-list row; while viewing a stock terminal, report only that session; while viewing the roots list, report idle. Unrelated trees must not override the displayed tree or terminal. Herdr's CLI accepts idle, working, blocked, and unknown: map Live and New updates to idle with descriptive messages, Working to working, and Needs user to blocked. Remove Herdr's pane-specific environment variables from nested provider processes so their own hooks cannot claim the outer pane or persist a provider identity there.

Use one status priority and one marker renderer across session endpoints, root-list rows, and both Open leaf and Jump to Leaf pickers: Needs user (red dot), Working (animated braille), New updates (yellow dot), Live (green dot), then inactive (muted hollow dot). Working outranks unread updates, including when an unread session starts another turn; merely navigating the tree does not mark a terminal as viewed. Live requires a terminal, not just a persisted session. Open pickers refresh their status markers without resetting selection, and root-list working indicators animate independently of provider refreshes.

Herdr reporting does not change process ownership. claude-tree continues to own every provider PTY, and Herdr does not receive terminal handles or act as a multipane runtime. Navigation recovery remains scoped to the current application instance; a new invocation cannot restore a prior PTY or emulator state.

## Input And View Ownership

The application has two modes: navigator and embedded terminal. In terminal mode, input belongs to the selected agent except for one configurable host escape chord. The initial default is `Ctrl+Space`, selected explicitly for returning to the navigator.

Avoid intercepting ordinary agent keys. Host shortcuts should be mode-specific, visible to the user, and configurable when practical.

## Shared Working Tree Is Deliberate

Every agent process starts in the same project directory. This allows branches to observe and build on the same filesystem state, but it also permits simultaneous edits and conflicts. The application should communicate status accurately and must not claim branch-level file isolation or silently create worktrees.

Future agents have latitude in UI composition, state modeling, testing strategy, and dependency choices. Changes should be judged against the goals in `project-goals.md` and the behavioral constraints above.
