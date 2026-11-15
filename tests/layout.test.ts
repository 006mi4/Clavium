import { describe, expect, it } from 'vitest'
import { MAX_RATIO, MIN_RATIO, dividers, dropTarget, filterLayout, insertBeside, mapLayout, neighbor, paneRects, panes, removePane, setRatio, splitPane, type Layout } from '../src/shared/layout'

const one: Layout<string> = { pane: 'a' }

describe('split layout', () => {
  it('takes a whole tab in next to a pane, with the splits the tab had', () => {
    const target = splitPane(one, 'a', 'row', 'b')
    const moved = splitPane({ pane: 'x' } as Layout<string>, 'x', 'col', 'y')
    const merged = insertBeside(target, 'b', 'col', moved)
    expect(panes(merged)).toEqual(['a', 'b', 'x', 'y'])
    expect(paneRects(merged).find((p) => p.pane === 'y')?.rect).toEqual({ x: 0.5, y: 0.75, w: 0.5, h: 0.25 })
    // a pane that is not there: nothing changes
    expect(insertBeside(target, 'nope', 'row', moved)).toEqual(target)
  })

  it('finds the place where something dropped on a tab lands', () => {
    const two = splitPane(one, 'a', 'row', 'b')
    // upper part of the left pane: to the right of it, in its right half
    expect(dropTarget(two, 0.1, 0.2)).toEqual({ pane: 'a', dir: 'row', rect: { x: 0.25, y: 0, w: 0.25, h: 1 } })
    // lower part of the right pane: below it
    expect(dropTarget(two, 0.9, 0.9)).toEqual({ pane: 'b', dir: 'col', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } })
    expect(dropTarget(two, 1.5, 0.5)).toBeNull()
  })

  it('splits a pane to the right and below, and keeps the order of reading', () => {
    const two = splitPane(one, 'a', 'row', 'b')
    const three = splitPane(two, 'b', 'col', 'c')
    expect(panes(three)).toEqual(['a', 'b', 'c'])
    expect(paneRects(three)).toEqual([
      { pane: 'a', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { pane: 'b', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
      { pane: 'c', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }
    ])
    // a pane that is not there changes nothing
    expect(splitPane(three, 'x', 'row', 'y')).toEqual(three)
  })

  it('gives the room of a closed pane to its neighbour', () => {
    const three = splitPane(splitPane(one, 'a', 'row', 'b'), 'b', 'col', 'c')
    expect(removePane(three, 'b')).toEqual({ dir: 'row', ratio: 0.5, a: { pane: 'a' }, b: { pane: 'c' } })
    expect(removePane(removePane(three, 'b') as Layout<string>, 'a')).toEqual({ pane: 'c' })
    expect(removePane(one, 'a')).toBeNull()
  })

  it('moves a divider and never lets a pane vanish', () => {
    const three = splitPane(splitPane(one, 'a', 'row', 'b'), 'b', 'col', 'c')
    expect(dividers(three).map((d) => d.path)).toEqual(['', 'b'])
    const moved = setRatio(three, 'b', 0.3)
    expect(paneRects(moved)[1].rect.h).toBeCloseTo(0.3)
    expect(dividers(setRatio(three, '', 0.01))[0].ratio).toBe(MIN_RATIO)
    expect(dividers(setRatio(three, '', 7))[0].ratio).toBe(MAX_RATIO)
    expect(dividers(setRatio(three, '', Number.NaN))[0].ratio).toBe(0.5)
    // the area of the inner divider is the right half
    expect(dividers(three)[1].area).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 })
  })

  it('finds the neighbour in a direction by position', () => {
    // a | b over c, d below everything
    const grid = splitPane(splitPane(splitPane(one, 'a', 'col', 'd'), 'a', 'row', 'b'), 'b', 'col', 'c')
    expect(neighbor(grid, 'a', 'right')).toBe('b')
    expect(neighbor(grid, 'b', 'down')).toBe('c')
    expect(neighbor(grid, 'c', 'left')).toBe('a')
    expect(neighbor(grid, 'c', 'down')).toBe('d')
    expect(neighbor(grid, 'd', 'up')).toBe('a')
    expect(neighbor(grid, 'a', 'left')).toBeNull()
    expect(neighbor(grid, 'x', 'left')).toBeNull()
  })

  it('stores a layout by position and drops panes whose host is gone', () => {
    const three = splitPane(splitPane(one, 'a', 'row', 'b'), 'b', 'col', 'c')
    const ids = panes(three)
    const stored = mapLayout(three, (id) => ids.indexOf(id))
    expect(panes(stored)).toEqual([0, 1, 2])
    const back = filterLayout(mapLayout(stored, (i) => ['x', '', 'z'][i]), (id) => id !== '')
    expect(back).toEqual({ dir: 'row', ratio: 0.5, a: { pane: 'x' }, b: { pane: 'z' } })
    expect(filterLayout(stored, () => false)).toBeNull()
  })
})
