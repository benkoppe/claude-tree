import type { KeyEvent } from "@opentui/core"

export function listNavigationDelta(key: KeyEvent): -1 | 1 | undefined {
  if (isUnmodifiedKey(key, "up") || isUnmodifiedKey(key, "k")) return -1
  if (isUnmodifiedKey(key, "down") || isUnmodifiedKey(key, "j")) return 1
  if (isControlKey(key, "p")) return -1
  if (isControlKey(key, "n")) return 1
  return undefined
}

export function isUnmodifiedKey(key: KeyEvent, name: string): boolean {
  return key.name === name && !hasModifiers(key)
}

export function isEnterKey(key: KeyEvent): boolean {
  return (
    (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") &&
    !hasModifiers(key)
  )
}

function isControlKey(key: KeyEvent, name: string): boolean {
  return (
    key.name === name &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  )
}

function hasModifiers(key: KeyEvent): boolean {
  return Boolean(
    key.ctrl || key.shift || key.meta || key.option || key.super || key.hyper,
  )
}
