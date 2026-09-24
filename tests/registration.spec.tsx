/**
 * Registration contract: where the plugin mounts, that it collides with nothing
 * shipped, and that disposal unregisters it completely.
 *
 * The slot half runs against the production `SlotCore` from
 * `@deepseek-ai/dsh-client-ui-slots@0.1.5-rc.2` — the real declaration,
 * registration, duplicate-id and disposal implementation, pinned to the exact
 * version DSH Desktop 2.0.13 ships — rather than a stub. "It sits beside the
 * shipped entries" and "disposal leaves nothing behind" are therefore the
 * framework's own semantics, not this plugin's claims about itself.
 */
import { describe, expect, test } from 'vitest'
import { SlotCore, standardHookPropName, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '../src/client/contract.ts'
import { apply, ENTRY_ID, inject as clientInject, SUMMARY_SOURCE_NAME } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { STYLE_TAG_ID } from '../src/client/styles.ts'

/** The shipped occupants of the dock, exactly as 0.1.5-rc.2 registers them. */
const SHIPPED = [
  { id: 'todo', order: 0 },
  { id: 'goal', order: 10 },
  { id: 'queue', order: 20 },
]

/** A client context whose slot registry is the production core. */
class Harness {
  readonly core = new SlotCore()
  readonly disposers: (() => void)[] = []
  readonly registrations: { name: string; id?: string; order?: number; locale?: string }[] = []
  readonly injections: { name: string; sessionId: string; face: Record<string, unknown> }[] = []
  readonly dictionaries: { ns: string; locales: string[] }[] = []
  readonly resets: (() => void)[] = []
  services: Record<string, unknown> = {}

  constructor() {
    // The dock is declared by an occupant of root, exactly as ui-conversation's
    // ConversationRoot declares it in 0.1.5-rc.2: a session-scoped list.
    this.rawRegister({
      name: 'root',
      children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
    })
    for (const entry of SHIPPED) this.rawRegister({ name: 'conversation.input.dock', ...entry })
  }

  /**
   * Register against the production core without its `SlotMap` typing.
   *
   * `SlotMap` is populated by declaration merging in the package that declares
   * each slot; this plugin deliberately imports no host package, so the key is
   * untyped here while the behaviour under test is entirely the real core's.
   */
  rawRegister(options: Record<string, unknown>, component: unknown = () => null): () => void {
    const register = this.core.register as unknown as (options: unknown, component: unknown) => () => void
    return register.call(this.core, options, component)
  }

  /** Ids currently occupying the dock, in the core's own render order. */
  dockIds(): (string | undefined)[] {
    return this.core.entriesOfSlot('conversation.input.dock').map((entry: StoredEntry) => entry.options.id)
  }

  readonly ctx = {
    sessions: undefined as unknown,
    on: (event: string, listener: () => void): (() => void) => {
      if (event === 'connection/reset') this.resets.push(listener)
      return () => {
        this.resets.splice(this.resets.indexOf(listener) >>> 0, 1)
      }
    },
    effect: (mount: () => (() => void) | void): void => {
      const dispose = mount()
      if (typeof dispose === 'function') this.disposers.push(dispose)
    },
    locale: {
      register: (ns: string, dicts: Record<string, unknown>): (() => void) => {
        this.dictionaries.push({ ns, locales: Object.keys(dicts) })
        return () => {}
      },
    },
    slots: {
      inject: (_name: string, mount: () => (() => void) | void): void => {
        const dispose = mount()
        if (typeof dispose === 'function') this.disposers.push(dispose)
      },
      register: (options: { name: string; id?: string; order?: number; locale?: string; inject?: (id: string) => Record<string, unknown> }, component: unknown): (() => void) => {
        this.registrations.push({
          name: options.name,
          ...options.id === undefined ? {} : { id: options.id },
          ...options.order === undefined ? {} : { order: options.order },
          ...options.locale === undefined ? {} : { locale: options.locale },
        })
        const dispose = this.rawRegister(options as unknown as Record<string, unknown>, component)
        this.disposers.push(dispose)
        return dispose
      },
    },
  }

  /** Resolve the entry's injected face for one Session, as the renderer does. */
  injectFor(sessionId: string): Record<string, unknown> {
    for (const entry of this.core.entriesOfSlot('conversation.input.dock') as unknown as { inject?: (id: string) => Record<string, unknown> }[]) {
      // The core keeps `inject` on the entry itself, beside `options`.
      if (entry.inject === undefined) continue
      const face = entry.inject(sessionId)
      this.injections.push({ name: sessionId, sessionId, face })
      return face
    }
    throw new Error('the dock entry injected nothing')
  }

  mount(): void {
    apply(this.ctx as unknown as ClientContext)
  }

  dispose(): void {
    for (const dispose of [...this.disposers].reverse()) dispose()
    this.disposers.length = 0
  }

  /** Whether the dock is still declared: a probe registration must succeed. */
  dockStillDeclared(): boolean {
    try {
      const dispose = this.rawRegister({ name: 'conversation.input.dock', id: 'probe' })
      dispose()
      return true
    } catch {
      return false
    }
  }
}

/** A binding whose event window can be driven. */
function binding(sessionId: string) {
  const listeners = new Set<() => void>()
  return {
    sessionId,
    eventSource: {
      getSnapshot: () => ({ entries: [] as readonly never[] }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
}

/** A harness with a working `sessions` service. */
function mountWithBindings(): Harness {
  const harness = new Harness()
  harness.services = { sessions: { binding: (id: string) => binding(id) } }
  harness.ctx.sessions = harness.services['sessions']
  harness.mount()
  return harness
}

describe('mounting the dock entry', () => {
  test('registers once, into the composer extension row and nothing else', () => {
    const harness = mountWithBindings()
    expect(harness.registrations).toEqual([{ name: 'conversation.input.dock', id: ENTRY_ID, order: 30, locale: NS }])
    // The composer itself is never registered into, replaced, or shadowed.
    expect(harness.registrations.some((entry) => entry.name.includes('composer'))).toBe(false)
  })

  test('sits beside every shipped occupant instead of replacing one', () => {
    const harness = mountWithBindings()
    expect(harness.dockIds()).toEqual(['todo', 'goal', 'queue', ENTRY_ID])
  })

  test('renders closest to the composer, directly above the input box', () => {
    const harness = mountWithBindings()
    const entries = harness.core.entriesOfSlot('conversation.input.dock') as unknown as { options: { id?: string; order?: number } }[]
    const last = entries.at(-1)?.options
    expect(last?.id).toBe(ENTRY_ID)
    // The list renders in ascending order, so the highest order is nearest the input.
    expect(last?.order).toBe(Math.max(...entries.map((entry) => entry.options.order ?? 0)))
  })

  test('uses an id no shipped entry owns', () => {
    mountWithBindings()
    expect(SHIPPED.some((entry) => entry.id === ENTRY_ID)).toBe(false)
  })

  test('refuses to double-register at the same priority', () => {
    const harness = mountWithBindings()
    // The production core rejects a duplicate (id, priority); mounting twice is a
    // composition error, and this plugin does not swallow it.
    expect(() => harness.rawRegister({ name: 'conversation.input.dock', id: ENTRY_ID, order: 30 })).toThrow(/already has an entry/u)
  })
})

describe('the injected face', () => {
  test('hands the component a source the renderer names useSummary', () => {
    const harness = mountWithBindings()
    const face = harness.injectFor('session-a')
    expect(Object.keys(face)).toEqual(['hooks'])
    const hooks = face['hooks'] as Record<string, unknown>
    expect(Object.keys(hooks)).toEqual([SUMMARY_SOURCE_NAME])
    // The framework's own derivation, from the pinned version.
    expect(standardHookPropName(SUMMARY_SOURCE_NAME)).toBe('useSummary')
  })

  test('hands out an observable with a stable snapshot and a working subscription', () => {
    const harness = mountWithBindings()
    const hooks = harness.injectFor('session-a')['hooks'] as Record<string, { getSnapshot(): unknown; subscribe(listener: () => void): () => void }>
    const source = hooks[SUMMARY_SOURCE_NAME]
    expect(source).toBeDefined()
    expect(source?.getSnapshot()).toEqual({ summary: undefined })
    const unsubscribe = source?.subscribe(() => {})
    expect(typeof unsubscribe).toBe('function')
    unsubscribe?.()
  })

  test('gives each Session its own source', () => {
    const harness = mountWithBindings()
    const first = harness.injectFor('session-a')['hooks'] as Record<string, unknown>
    const second = harness.injectFor('session-b')['hooks'] as Record<string, unknown>
    expect(first[SUMMARY_SOURCE_NAME]).not.toBe(second[SUMMARY_SOURCE_NAME])
  })
})

describe('the rest of the plugin body', () => {
  test('registers its dictionaries for the shipped languages', () => {
    const harness = mountWithBindings()
    expect(harness.dictionaries).toEqual([{ ns: NS, locales: ['en', 'zh'] }])
  })

  test('installs exactly one stylesheet, tagged for the module system', () => {
    mountWithBindings()
    const tags = document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
    expect(tags).toHaveLength(1)
    expect(tags[0]?.getAttribute('data-plugin')).toBe('dsh-chat-diff-summary-legacy')
    // A second mount of the same plugin must not stack another copy.
    mountWithBindings()
    expect(document.querySelectorAll(`style[data-plugin-css="${STYLE_TAG_ID}"]`)).toHaveLength(1)
  })

  test('subscribes to connection resets and releases them on disposal', () => {
    const harness = mountWithBindings()
    expect(harness.resets).toHaveLength(1)
    harness.dispose()
    expect(harness.resets).toHaveLength(0)
  })

  test('declares only the services 0.1.5-rc.2 provides', () => {
    expect([...clientInject]).toEqual(['slots', 'sessions', 'locale'])
  })
})

describe('disposal', () => {
  test('unregisters the dock entry and leaves the shipped ones intact', () => {
    const harness = mountWithBindings()
    expect(harness.dockIds()).toContain(ENTRY_ID)
    harness.dispose()
    expect(harness.dockIds()).toEqual(['todo', 'goal', 'queue'])
    expect(harness.dockStillDeclared()).toBe(true)
  })
})

describe('installing twice', () => {
  test('is a composition error rather than a silent duplicate', () => {
    const harness = mountWithBindings()
    expect(() => harness.mount()).toThrow(/already has an entry/u)
  })
})
