// The arrangement of the panes of a tab: a tree of splits. Pure functions, used by the renderer
// (leaves are session ids) and for saved workspaces (leaves are indexes into the list of panes).

export type SplitDir = 'row' | 'col'

/** `row` puts `a` left of `b`, `col` puts `a` above `b`. `ratio` is the share of `a`. */
export type Layout<T> = { pane: T } | { dir: SplitDir; ratio: number; a: Layout<T>; b: Layout<T> }

/** A rectangle in fractions (0..1) of the area of the tab. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Divider {
  /** the way from the root to the split: 'a' and 'b' steps */
  path: string
  dir: SplitDir
  ratio: number
  /** the area the split divides */
  area: Rect
}

export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85
/** More panes than this are not useful on any screen, and a stored layout is never trusted blindly. */
export const MAX_PANES = 8

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }

export function clampRatio(r: number): number {
  return Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5
}

function halves(l: Extract<Layout<unknown>, { dir: SplitDir }>, area: Rect): [Rect, Rect] {
  const r = clampRatio(l.ratio)
  return l.dir === 'row'
    ? [{ ...area, w: area.w * r }, { ...area, x: area.x + area.w * r, w: area.w * (1 - r) }]
    : [{ ...area, h: area.h * r }, { ...area, y: area.y + area.h * r, h: area.h * (1 - r) }]
}

export function panes<T>(l: Layout<T>): T[] {
  return 'pane' in l ? [l.pane] : [...panes(l.a), ...panes(l.b)]
}

/** Where every pane sits, in reading order. */
export function paneRects<T>(l: Layout<T>, area: Rect = FULL): { pane: T; rect: Rect }[] {
  if ('pane' in l) return [{ pane: l.pane, rect: area }]
  const [a, b] = halves(l, area)
  return [...paneRects(l.a, a), ...paneRects(l.b, b)]
}

export function dividers<T>(l: Layout<T>, area: Rect = FULL, path = ''): Divider[] {
  if ('pane' in l) return []
  const [a, b] = halves(l, area)
  return [{ path, dir: l.dir, ratio: clampRatio(l.ratio), area }, ...dividers(l.a, a, path + 'a'), ...dividers(l.b, b, path + 'b')]
}

/** Put `added` next to `target`: to the right of it for `row`, below it for `col`. */
export function splitPane<T>(l: Layout<T>, target: T, dir: SplitDir, added: T): Layout<T> {
  if ('pane' in l) return l.pane === target ? { dir, ratio: 0.5, a: l, b: { pane: added } } : l
  return { ...l, a: splitPane(l.a, target, dir, added), b: splitPane(l.b, target, dir, added) }
}

/** The layout without `target`; null when it was the last pane. */
export function removePane<T>(l: Layout<T>, target: T): Layout<T> | null {
  if ('pane' in l) return l.pane === target ? null : l
  const a = removePane(l.a, target)
  const b = removePane(l.b, target)
  if (a && b) return a === l.a && b === l.b ? l : { ...l, a, b }
  return a ?? b
}

export function setRatio<T>(l: Layout<T>, path: string, ratio: number): Layout<T> {
  if ('pane' in l) return l
  if (path === '') return { ...l, ratio: clampRatio(ratio) }
  return path[0] === 'a' ? { ...l, a: setRatio(l.a, path.slice(1), ratio) } : { ...l, b: setRatio(l.b, path.slice(1), ratio) }
}

export function mapLayout<T, U>(l: Layout<T>, fn: (pane: T) => U): Layout<U> {
  return 'pane' in l ? { pane: fn(l.pane) } : { dir: l.dir, ratio: clampRatio(l.ratio), a: mapLayout(l.a, fn), b: mapLayout(l.b, fn) }
}

/** Keep only the panes `keep` accepts; null when none is left. */
export function filterLayout<T>(l: Layout<T>, keep: (pane: T) => boolean): Layout<T> | null {
  if ('pane' in l) return keep(l.pane) ? l : null
  const a = filterLayout(l.a, keep)
  const b = filterLayout(l.b, keep)
  if (a && b) return { ...l, a, b }
  return a ?? b
}

/** The pane next to `from` in a direction, judged by where the panes are on screen. */
export function neighbor<T>(l: Layout<T>, from: T, direction: 'left' | 'right' | 'up' | 'down'): T | null {
  const all = paneRects(l)
  const me = all.find((p) => p.pane === from)?.rect
  if (!me) return null
  const eps = 1e-6
  const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0)
  let best: { pane: T; score: number } | null = null
  for (const { pane, rect } of all) {
    if (pane === from) continue
    let touching: boolean
    let shared: number
    if (direction === 'left' || direction === 'right') {
      touching = direction === 'left' ? Math.abs(rect.x + rect.w - me.x) < eps : Math.abs(me.x + me.w - rect.x) < eps
      shared = overlap(me.y, me.y + me.h, rect.y, rect.y + rect.h)
    } else {
      touching = direction === 'up' ? Math.abs(rect.y + rect.h - me.y) < eps : Math.abs(me.y + me.h - rect.y) < eps
      shared = overlap(me.x, me.x + me.w, rect.x, rect.x + rect.w)
    }
    if (touching && shared > eps && (!best || shared > best.score)) best = { pane, score: shared }
  }
  return best?.pane ?? null
}
