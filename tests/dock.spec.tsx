/**
 * The bar itself: what it draws, what it refuses to draw, and the colour and
 * geometry contract `/styles.ts` promises.
 */
import { describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ChatDiffSummary } from '../src/client/ChatDiffSummary.tsx'
import { en } from '../src/client/locales.ts'
import { STYLES } from '../src/client/styles.ts'
import { MAX_FILES, type ChangeSummary } from '../src/summary.ts'
import { selectorFor } from './support/selector.ts'
import { makeTranslate } from './support/translate.ts'

const t = makeTranslate(en)

/** One summary over the given files. */
function summary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    turn: 1,
    total: 26,
    added: 542,
    deleted: 20,
    files: [
      { path: 'app/MainActivity.kt', display: 'app/MainActivity.kt', added: 31, deleted: 4 },
      { path: 'Foo.kt', display: 'Foo.kt', added: 18, deleted: 7 },
      { path: 'README.md', display: 'README.md', added: 6, deleted: 0 },
    ],
    ...overrides,
  }
}

/**
 * Render the bar over a fixed summary.
 *
 * `useSummary` is bound the way `dsh-client-ui-renderer` binds a `hooks` source:
 * as a selector hook. A plain `() => value` stub would let a no-argument call
 * pass here and fail in the Desktop.
 */
function renderBar(value: ChangeSummary | undefined) {
  return render(<ChatDiffSummary useSummary={selectorFor({ summary: value })} t={t} />)
}

describe('the summary line', () => {
  test('reads as one line of ordinary text plus the two counts', () => {
    renderBar(summary())
    expect(screen.getByText('26 files changed')).toBeInTheDocument()
    expect(screen.getByText('+542')).toBeInTheDocument()
    expect(screen.getByText('-20')).toBeInTheDocument()
  })

  test('uses the singular wording for exactly one file', () => {
    renderBar(summary({ total: 1, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }] }))
    expect(screen.getByText('1 file changed')).toBeInTheDocument()
  })

  test('groups a long count without letting its width wander', () => {
    renderBar(summary({ total: 1234, added: 45678, deleted: 9, files: [] }))
    expect(screen.getByText('1,234 files changed')).toBeInTheDocument()
    expect(screen.getByText('+45,678')).toBeInTheDocument()
  })

  test('marks the counts so the additions and deletions colours can differ', () => {
    const { container } = renderBar(summary())
    expect(container.querySelector('.cdsl-added')?.textContent).toBe('+542')
    expect(container.querySelector('.cdsl-deleted')?.textContent).toBe('-20')
  })

  test('names the shape it draws with tabular figures and a single row', () => {
    const { container } = renderBar(summary())
    expect(container.querySelector('.cdsl-list')).toBeNull()
    expect(container.querySelector('[data-turn="1"]')).not.toBeNull()
  })

  test('keeps the counts next to the label instead of pushing them to the far edge', () => {
    // The row shrinks to its contents: no elastic spacer between the two halves.
    const { container } = renderBar(summary())
    const bar = container.querySelector('.cdsl-bar')
    const label = container.querySelector('.cdsl-label')
    expect(container.querySelector('.cdsl-spacer')).toBeNull()
    expect(label?.nextElementSibling?.className).toBe('cdsl-counts')
    expect(bar?.children).toHaveLength(2)
  })
})

describe('the injected hook contract', () => {
  test('reads through the selector the renderer hands it', () => {
    // A no-argument call would throw inside `useSyncExternalStoreWithSelector`,
    // which is exactly how this entry crashed on the first real Desktop run.
    const seen: unknown[] = []
    const useSummary = <T,>(selector: (state: { summary: ChangeSummary | undefined }) => T): T => {
      seen.push(selector)
      return selector({ summary: summary() })
    }
    render(<ChatDiffSummary useSummary={useSummary} t={t} />)
    expect(seen).toHaveLength(1)
    expect(typeof seen[0]).toBe('function')
    expect(screen.getByText('26 files changed')).toBeInTheDocument()
  })

  test('asks the selector for the summary field', () => {
    const state = { summary: summary() }
    const useSummary = <T,>(selector: (value: typeof state) => T): T => selector(state)
    render(<ChatDiffSummary useSummary={useSummary} t={t} />)
    expect(screen.getByText('+542')).toBeInTheDocument()
  })
})

describe('drawing nothing', () => {
  test('renders null when there is no summary at all', () => {
    const { container } = renderBar(undefined)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders null for a turn that changed no files', () => {
    const { container } = renderBar(summary({ total: 0, added: 0, deleted: 0, files: [] }))
    expect(container).toBeEmptyDOMElement()
  })

  test('never renders a zero as a count', () => {
    renderBar(summary({ total: 0, added: 0, deleted: 0, files: [] }))
    expect(screen.queryByText('0 files changed')).toBeNull()
    expect(screen.queryByText('+0')).toBeNull()
  })
})

describe('expanding the file list', () => {
  test('starts collapsed and opens on click', () => {
    renderBar(summary())
    const bar = screen.getByRole('button')
    expect(bar).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(bar)
    expect(bar).toHaveAttribute('aria-expanded', 'true')
  })

  test('previews on hover and closes after leaving the button and list', () => {
    vi.useFakeTimers()
    try {
      renderBar(summary())
      const bar = screen.getByRole('button')
      fireEvent.mouseEnter(bar)
      expect(bar).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('list')).toBeInTheDocument()
      fireEvent.mouseLeave(bar)
      act(() => { vi.runAllTimers() })
      expect(bar).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('list')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps the hover preview open across the gap into the file list', () => {
    vi.useFakeTimers()
    try {
      renderBar(summary())
      const bar = screen.getByRole('button')
      fireEvent.mouseEnter(bar)
      const list = screen.getByRole('list')
      fireEvent.mouseLeave(bar)
      fireEvent.mouseEnter(list)
      act(() => { vi.runAllTimers() })
      expect(list).toBeInTheDocument()
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
      fireEvent.mouseLeave(list)
      act(() => { vi.runAllTimers() })
      expect(screen.queryByRole('list')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('click locks a hover preview until the next click, including after leaving', () => {
    vi.useFakeTimers()
    try {
      renderBar(summary())
      const bar = screen.getByRole('button')
      fireEvent.mouseEnter(bar)
      fireEvent.click(bar)
      fireEvent.mouseLeave(bar)
      act(() => { vi.runAllTimers() })
      expect(bar).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(bar)
      expect(bar).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('list')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not carry a locked expansion into the next turn', () => {
    const first = summary({ turn: 4 })
    const { rerender } = render(<ChatDiffSummary useSummary={selectorFor({ summary: first })} t={t} />)
    fireEvent.click(screen.getByRole('button'))
    rerender(<ChatDiffSummary useSummary={selectorFor({ summary: summary({ turn: 5 }) })} t={t} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  test('lists each changed file with its own counts', () => {
    renderBar(summary())
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('app/MainActivity.kt')).toBeInTheDocument()
    expect(screen.getByText('Foo.kt')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    // The first file's own line carries its own numbers.
    const first = screen.getByText('app/MainActivity.kt').closest('li')
    expect(first?.textContent).toContain('+31')
    expect(first?.textContent).toContain('-4')
  })

  test('keeps file names non-interactive, because 2.0.13 has no review surface', () => {
    renderBar(summary())
    fireEvent.click(screen.getByRole('button'))
    const rows = screen.getAllByRole('listitem')
    expect(rows.every((row) => row.querySelector('button') === null)).toBe(true)
  })

  test('says a binary file is binary instead of inventing counts', () => {
    renderBar(summary({
      total: 1,
      files: [{ path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true }],
    }))
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('binary')).toBeInTheDocument()
  })

  test('reports the files the cap left out without changing the total', () => {
    const files = Array.from({ length: MAX_FILES }, (_unused, index) => ({
      path: `f${String(index)}.ts`,
      display: `f${String(index)}.ts`,
      added: 1,
      deleted: 0,
    }))
    renderBar(summary({ total: MAX_FILES + 12, files }))
    fireEvent.click(screen.getByRole('button'))
    // The count stays complete even though the list is capped.
    expect(screen.getByText(`${String(MAX_FILES + 12)} files changed`)).toBeInTheDocument()
    expect(screen.getByText('12 more not listed')).toBeInTheDocument()
  })

  test('stays open when the same turn is re-measured mid-flight', () => {
    // An open turn is re-measured while it runs, so the summary object can be
    // replaced without the turn changing. That must not fold the list the user
    // just opened.
    const files = [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }]
    const first = summary({ turn: 4, total: 1, files })
    const { rerender } = render(<ChatDiffSummary useSummary={selectorFor({ summary: first })} t={t} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    const again = summary({ turn: 4, total: 1, files })
    expect(again).not.toBe(first)
    rerender(<ChatDiffSummary useSummary={selectorFor({ summary: again })} t={t} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  test('collapses again on a second click', () => {
    renderBar(summary())
    const bar = screen.getByRole('button')
    fireEvent.click(bar)
    fireEvent.click(bar)
    expect(bar).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  test('labels the list for assistive technology', () => {
    renderBar(summary())
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('list', { name: 'Files changed in this turn' })).toBeInTheDocument()
  })
})

describe('the stylesheet', () => {
  test('takes every colour from a DSH alias token', () => {
    expect(STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(STYLES).not.toMatch(/\brgba?\(/)
    expect(STYLES).not.toMatch(/\bhsla?\(/)
    // The two counts are the shipped success/error tokens.
    expect(STYLES).toMatch(/\.cdsl-added\{[^}]*var\(--dsw-alias-state-success-primary\)/)
    expect(STYLES).toMatch(/\.cdsl-deleted\{[^}]*var\(--dsw-alias-state-error-primary\)/)
  })

  test('draws the briefed geometry: one row, a hairline border, a soft radius', () => {
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*height:38px/)
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/)
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*border-radius:14px/)
  })

  test('uses no gradient, no glass effect and no heavy shadow', () => {
    expect(STYLES).not.toMatch(/gradient/i)
    expect(STYLES).not.toMatch(/backdrop-filter/i)
    // The row is flat. The floating panel may take the host's own elevation
    // token — never a hand-rolled shadow — and falls back to none without it.
    const shadows = [...STYLES.matchAll(/box-shadow:([^;}]+)/gu)].map((match) => match[1]?.trim() ?? '')
    expect(shadows.length).toBeLessThanOrEqual(1)
    for (const shadow of shadows) expect(shadow).toMatch(/^var\(--dsw-shadow-lv3,none\)$/)
    expect(/\.cdsl-bar\{[^}]*box-shadow/u.test(STYLES)).toBe(false)
  })

  test('gives hover a surface change and keyboard focus a visible ring', () => {
    expect(STYLES).toMatch(/\.cdsl-bar:hover\{[^}]*var\(--dsw-alias-interactive-bg-hover\)/)
    expect(STYLES).toMatch(/\.cdsl-bar:focus-visible\{[^}]*outline:2px solid/)
  })

  test('uses tabular figures so the numbers never shift width', () => {
    expect(STYLES).toMatch(/font-variant-numeric:tabular-nums/)
  })

  test('shrinks itself in a narrow composer instead of overflowing', () => {
    expect(STYLES).toMatch(/container:cdsl \/ inline-size/)
    expect(STYLES).toMatch(/@container cdsl \(max-width:760px\)/)
    expect(STYLES).toMatch(/@container cdsl \(max-width:520px\)/)
    expect(STYLES).toMatch(/@container cdsl \(max-width:320px\)/)
  })

  test('centres the row without stretching it across the composer', () => {
    // Centring comes from the root's alignment, not from margins.
    expect(STYLES).toMatch(/\.cdsl-root\{[^}]*justify-content:center/)
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*width:max-content/)
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*max-width:100%/)
  })

  test('floats the file list over the conversation instead of pushing it up', () => {
    // Out of flow: the dock keeps its height, so expanding never reflows the
    // transcript above the composer.
    expect(STYLES).toMatch(/\.cdsl-root\{[^}]*position:relative/)
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*position:absolute/)
    // Anchored just above the row it belongs to, and centred on it.
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*bottom:calc\(100% \+ 2px\)/)
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*left:50%/)
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*transform:translateX\(-50%\)/)
    // Above whatever it covers.
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*z-index:1/)
    // Nothing in the row reserves the panel's height any more.
    expect(STYLES).not.toMatch(/flex-direction:column-reverse/)
  })

  test('shrinks the row to its contents, with nothing pushing the halves apart', () => {
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*width:max-content/)
    // It may never overflow the composer, and a long label ellipsizes instead.
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*max-width:100%/)
    // One character between the label and the counts.
    expect(STYLES).toMatch(/\.cdsl-bar\{[^}]*gap:1em/)
    // No elastic spacer, and no fixed min-width that would prop it open again.
    expect(STYLES).not.toMatch(/cdsl-spacer/)
    expect(STYLES).not.toMatch(/\.cdsl-bar\{[^}]*min-width/)
  })

  test('leaves the opened panel its own size rather than the row s', () => {
    // The list keeps a fixed fraction so a long file name has room.
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*width:33\.3333%/)
    // Only the list has to widen on a narrow composer.
    expect(STYLES).toMatch(/@container cdsl \(max-width:760px\)\{\s*\.cdsl-list\{width:50%\}\s*\}/)
    expect(STYLES).toMatch(/@container cdsl \(max-width:520px\)\{[\s\S]*?\.cdsl-list\{width:100%\}/)
  })

  test('pages the list at seven rows, with the rest reached by the wheel', () => {
    expect(STYLES).toMatch(/--cdsl-list-rows:7/)
    expect(STYLES).toMatch(/--cdsl-row-height:38px/)
    // Height is exactly seven rows plus the panel's own padding, so a row is
    // never half-clipped at the fold.
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*max-height:calc\(var\(--cdsl-list-rows\) \* var\(--cdsl-row-height\) \+ 2 \* var\(--cdsl-list-pad\)\)/)
    expect(STYLES).toMatch(/\.cdsl-list\{[^}]*overflow-y:auto/)
    // A fixed row height is what makes "seven rows" exact.
    expect(STYLES).toMatch(/\.cdsl-row\{[^}]*height:var\(--cdsl-row-height\)/)
    expect(STYLES).not.toMatch(/\.cdsl-row\{[^}]*min-height/)
  })

  test('keeps the wheel inside the panel at its ends', () => {
    expect(STYLES).toMatch(/overscroll-behavior:contain/)
  })

  test('styles its scrollbar from the host tokens', () => {
    expect(STYLES).toMatch(/::-webkit-scrollbar-thumb\{background:var\(--dsh-scrollbar-thumb/)
    expect(STYLES).toMatch(/::-webkit-scrollbar-thumb:hover\{background:var\(--dsh-scrollbar-thumb-hover/)
  })

  test('gives every row room for a name and its two counts', () => {
    expect(STYLES).toMatch(/\.cdsl-row\{[^}]*height:var\(--cdsl-row-height\)/)
    expect(STYLES).toMatch(/\.cdsl-row\{[^}]*font-size:13px/)
    // A bare basename reads in the UI face; only the figures are tabular.
    expect(STYLES).not.toMatch(/monospace/)
  })

  test('truncates the label rather than pushing the counts out of view', () => {
    expect(STYLES).toMatch(/\.cdsl-label\{[^}]*text-overflow:ellipsis/)
    expect(STYLES).toMatch(/\.cdsl-label\{[^}]*flex:0 1 auto/)
    expect(STYLES).toMatch(/\.cdsl-counts\{[^}]*flex:none/)
  })

  test('follows the text tokens rather than a fixed ink colour', () => {
    expect(STYLES).toMatch(/var\(--dsw-alias-label-secondary\)/)
    expect(STYLES).toMatch(/var\(--dsw-alias-label-caption\)/)
    expect(STYLES).toMatch(/var\(--dsw-alias-bg-layer-1\)/)
  })
})
