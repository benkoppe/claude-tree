import { PROGRAM_NAME } from "./program"

export const CLI_HELP = `${PROGRAM_NAME} [--codex] [PROJECT]

Explore and run coding-agent conversations for PROJECT (default: current directory).
Claude Code is used by default; pass --codex to use Codex.

Root picker:
  Up/Down or k/j  select a conversation family
  Mouse wheel     select a conversation family
  Click           select a row; click the selected row to open it
  Enter           open its message graph
  d               delete the selected whole tree from roots
  n               start a new conversation
  r               refresh conversations
  ?               open About
  q               quit

Message graph:
  Up/Down or k/j  move along graph edges
  Left/Right or h/l move across branches
  g / G           jump to the top / a reachable leaf
  Click           select a card; click the selected card to open it
  Enter           open or resume the session ending at the selected node
  f               fork the selected provider-supported message
  d               delete the selected node and visual descendants from the graph
  x               kill the selected live endpoint after confirmation
  n               start a new conversation
  r               refresh the graph
  ?               open About
  q or Escape     return to roots

Delete confirmation:
  Cancel is selected by default; arrows, h/j/k/l, or Tab change the choice
  Enter           confirm the selected choice
  q or Escape     cancel
  Deletion cannot be undone in claude-tree; provider transcripts and project files remain
  Affected live sessions stop first; ancestors remain forkable
  A deleted original leaf cannot be opened from that path

Kill confirmation:
  Arrows, h/j/k/l, or Tab choose Kill or Cancel
  Enter           confirm the selected choice
  q or Escape     cancel

Footer actions can also be clicked.

Agent terminal:
  Ctrl+Space      return to the message graph
  d               ordinary provider input
`
