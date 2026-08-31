import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"

import { displayWidth, truncateToWidth } from "./display-text"
import { isEnterKey, isUnmodifiedKey, listNavigationDelta } from "./list-navigation"
import type { ReachableSessionEndpoint } from "./message-graph"
import { theme } from "./theme"

interface PickerRow {
  container: BoxRenderable
  marker: TextRenderable
  text: TextRenderable
}

export class OpenLeafPicker {
  private readonly overlay: BoxRenderable
  private readonly panel: BoxRenderable
  private readonly list: ScrollBoxRenderable
  private readonly rows: PickerRow[] = []
  private options: ReachableSessionEndpoint[] = []
  private activeSessionIds: ReadonlySet<string> = new Set()
  private selectedIndex = 0
  private pendingMouseIndex: number | null = null
  private pendingBackdropClick = false
  private rowTextWidth = 1

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onSelect: (option: ReachableSessionEndpoint) => void,
  ) {
    this.overlay = new BoxRenderable(renderer, {
      id: "open-leaf-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 3000,
      alignItems: "center",
      paddingTop: Math.floor(renderer.terminalHeight / 4),
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      visible: false,
      onMouseDown: this.onBackdropMouseDown,
      onMouseUp: this.onBackdropMouseUp,
    })
    this.panel = new BoxRenderable(renderer, {
      id: "open-leaf-panel",
      width: 60,
      maxWidth: Math.max(1, renderer.terminalWidth - 2),
      flexDirection: "column",
      paddingTop: 1,
      backgroundColor: theme.element,
      onMouseDown: this.stopPanelMouseEvent,
      onMouseUp: this.stopPanelMouseEvent,
    })
    const content = new BoxRenderable(renderer, {
      id: "open-leaf-content",
      paddingLeft: 2,
      paddingRight: 2,
      rowGap: 1,
      flexGrow: 1,
      backgroundColor: theme.element,
    })
    const header = new BoxRenderable(renderer, {
      id: "open-leaf-header",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.element,
    })
    const title = new TextRenderable(renderer, {
      id: "open-leaf-title",
      fg: theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      content: "Open leaf",
    })
    const escape = new TextRenderable(renderer, {
      id: "open-leaf-escape",
      fg: theme.textMuted,
      selectable: false,
      content: "esc",
      onMouseUp: this.onEscapeMouseUp,
    })
    header.add(title)
    header.add(escape)
    this.list = new ScrollBoxRenderable(renderer, {
      id: "open-leaf-list",
      width: "100%",
      flexGrow: 1,
      backgroundColor: theme.element,
      scrollX: false,
      scrollY: true,
      stickyScroll: false,
      marginBottom: 1,
      scrollbarOptions: { visible: false },
      contentOptions: { flexDirection: "column" },
    })
    content.add(header)
    content.add(this.list)
    this.panel.add(content)
    this.overlay.add(this.panel)
    renderer.root.add(this.overlay)
  }

  get isOpen(): boolean {
    return this.overlay.visible
  }

  open(
    options: ReachableSessionEndpoint[],
    selectedSessionId?: string,
    activeSessionIds: ReadonlySet<string> = new Set(),
  ): void {
    this.clearRows()
    this.options = options
    this.activeSessionIds = new Set(activeSessionIds)
    const selectedIndex = selectedSessionId
      ? options.findIndex((option) => option.endpoint.session.id === selectedSessionId)
      : -1
    this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0
    this.pendingMouseIndex = null
    this.pendingBackdropClick = false

    for (const [index] of options.entries()) {
      const container = new BoxRenderable(this.renderer, {
        id: this.rowId(index),
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        backgroundColor: theme.element,
        onMouseDown: (event) => this.onRowMouseDown(event, index),
        onMouseUp: (event) => this.onRowMouseUp(event, index),
      })
      const marker = new TextRenderable(this.renderer, {
        width: 2,
        height: 1,
        flexShrink: 0,
        fg: theme.success,
        bg: theme.element,
        selectable: false,
        wrapMode: "none",
        content: "  ",
      })
      const text = new TextRenderable(this.renderer, {
        flexGrow: 1,
        height: 1,
        fg: theme.text,
        bg: theme.element,
        selectable: false,
        wrapMode: "none",
        content: "",
      })
      container.add(marker)
      container.add(text)
      this.list.add(container)
      this.rows.push({ container, marker, text })
    }

    this.overlay.visible = true
    this.updateDimensions()
    this.updateRows()
    this.list.scrollTo(0)
    this.list.scrollChildIntoView(this.rowId(this.selectedIndex))
  }

  close(): void {
    this.pendingMouseIndex = null
    this.pendingBackdropClick = false
    this.overlay.visible = false
  }

  updateDimensions(): void {
    if (!this.isOpen) return
    const width = Math.max(1, Math.min(60, this.renderer.terminalWidth - 2))
    const maximumRows = Math.max(1, Math.floor(this.renderer.terminalHeight / 2) - 2)
    const visibleRows = Math.max(1, Math.min(this.options.length, maximumRows))
    this.overlay.paddingTop = Math.floor(this.renderer.terminalHeight / 4)
    this.panel.maxWidth = Math.max(1, this.renderer.terminalWidth - 2)
    this.panel.height = Math.max(
      1,
      Math.min(this.renderer.terminalHeight - 2, visibleRows + 4),
    )
    this.rowTextWidth = Math.max(1, width - 4)
    this.updateRows()
  }

  handleKeyPress(key: KeyEvent): void {
    const delta = listNavigationDelta(key)
    if (delta !== undefined) {
      this.move(delta)
    } else if (isEnterKey(key) && !key.repeated) {
      this.activateSelected()
    } else if (isUnmodifiedKey(key, "escape") && !key.repeated) {
      this.close()
    }
  }

  private move(delta: -1 | 1): void {
    if (this.options.length === 0) return
    this.selectedIndex =
      (this.selectedIndex + delta + this.options.length) % this.options.length
    this.updateRows()
    this.list.scrollChildIntoView(this.rowId(this.selectedIndex))
  }

  private activateSelected(): void {
    const option = this.options[this.selectedIndex]
    if (!option) return
    this.close()
    this.onSelect(option)
  }

  private updateRows(): void {
    for (const [index, row] of this.rows.entries()) {
      const option = this.options[index]
      if (!option) continue
      const selected = index === this.selectedIndex
      const active = this.activeSessionIds.has(option.endpoint.session.id)
      const background = selected ? theme.selected : theme.element
      const foreground = selected ? theme.selectedText : theme.text
      const distance =
        option.distance === 0
          ? "selected leaf"
          : `${option.distance} ${option.distance === 1 ? "node" : "nodes"} down`
      const metadata = `${distance} · ${option.endpoint.session.id.slice(0, 8)}`
      const suffix = `  ${metadata}`
      const titleWidth = Math.max(
        0,
        this.rowTextWidth - 2 - displayWidth(suffix),
      )
      const label = truncateToWidth(
        `${truncateToWidth(option.endpoint.session.title, titleWidth)}${suffix}`,
        this.rowTextWidth - 2,
      )
      row.container.backgroundColor = background
      row.marker.bg = background
      row.marker.fg = selected ? theme.selectedText : theme.success
      row.marker.attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE
      row.marker.content = active ? "• " : "  "
      row.text.bg = background
      row.text.fg = foreground
      row.text.attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE
      row.text.content = label
    }
  }

  private clearRows(): void {
    for (const row of this.rows.splice(0)) {
      this.list.remove(row.container)
      row.container.destroyRecursively()
    }
  }

  private rowId(index: number): string {
    return `open-leaf-option-${index}`
  }

  private readonly onBackdropMouseDown = (event: MouseEvent) => {
    this.pendingBackdropClick = event.button === 0
    if (!this.pendingBackdropClick) return
    event.preventDefault()
    event.stopPropagation()
  }

  private readonly onBackdropMouseUp = (event: MouseEvent) => {
    const shouldClose = this.pendingBackdropClick && event.button === 0
    this.pendingBackdropClick = false
    if (!shouldClose) return
    event.preventDefault()
    event.stopPropagation()
    this.close()
  }

  private readonly stopPanelMouseEvent = (event: MouseEvent) => {
    this.pendingBackdropClick = false
    event.stopPropagation()
  }

  private readonly onEscapeMouseUp = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    this.close()
  }

  private onRowMouseDown(event: MouseEvent, index: number): void {
    this.pendingBackdropClick = false
    this.pendingMouseIndex = null
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseIndex = index
    this.selectedIndex = index
    this.updateRows()
  }

  private onRowMouseUp(event: MouseEvent, index: number): void {
    const activate = event.button === 0 && this.pendingMouseIndex === index
    this.pendingMouseIndex = null
    if (!activate) return
    event.preventDefault()
    event.stopPropagation()
    this.selectedIndex = index
    this.activateSelected()
  }
}
