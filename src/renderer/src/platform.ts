/** Differences between Windows and macOS that the interface has to know about. */
export const isMac = /Mac/i.test(navigator.platform)

/** Name of the system and of its file manager, for texts shown to the user. */
export const OS_NAME = isMac ? 'macOS' : 'Windows'
export const FILE_MANAGER = isMac ? 'Finder' : 'Explorer'

/** The key that starts app shortcuts is held: Cmd on macOS, Ctrl elsewhere. */
export function mod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/**
 * A shortcut the way the system writes it. Shortcuts are written in Windows form in the code
 * ("Ctrl+Shift+L"); on macOS that becomes "⇧⌘L". Where macOS uses a different key altogether,
 * the second argument names it.
 */
export function keys(shortcut: string, onMac?: string): string {
  if (!isMac) return shortcut
  if (onMac !== undefined) return onMac
  return shortcut
    // These stay on the Control key: Cmd+Tab switches apps, and zooming listens to Control.
    .replace(/Ctrl\+Shift\+Tab/g, '⌃⇧Tab')
    .replace(/Ctrl\+Tab/g, '⌃Tab')
    .replace(/Ctrl\+mouse wheel/g, '⌃ and mouse wheel')
    .replace(/Ctrl\+Shift\+/g, '⇧⌘')
    .replace(/Ctrl ?\+ ?/g, '⌘')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
}
