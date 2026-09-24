/**
 * A faithful stand-in for the framework's standard-source hook.
 *
 * `@deepseek-ai/dsh-client-ui-renderer` binds a `hooks` source through
 * `bindSnapshotSelector`, which returns
 * `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, selector, isEqual)`.
 * Component specs must therefore exercise a *selector* hook: rendering the
 * component with a plain `() => value` stub would accept a no-argument call that
 * the real binding rejects with `TypeError: selector is not a function` — a
 * defect that only the real Desktop surfaced.
 */
import { useSyncExternalStore } from 'react'

/** A framework-observable source. */
export interface SelectorSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/**
 * Bind one source the way the renderer does.
 * @param source - the observable snapshot source.
 * @returns the selector hook the slot registration exposes to the component.
 */
export function bindSelector<T>(source: SelectorSource<T>): <S>(selector: (state: T) => S) => S {
  return function useSelector<S>(selector: (state: T) => S): S {
    return useSyncExternalStore(
      source.subscribe,
      () => selector(source.getSnapshot()),
      () => selector(source.getSnapshot()),
    )
  }
}

/** Bind a fixed value, for specs that do not need a live source. */
export function selectorFor<T>(value: T): <S>(selector: (state: T) => S) => S {
  return bindSelector({ getSnapshot: () => value, subscribe: () => () => {} })
}
