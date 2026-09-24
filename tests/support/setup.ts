/**
 * Spec setup.
 *
 * The DOM helpers are only meaningful with a document, and host/git specs run
 * under `@vitest-environment node` while loading this same file.
 *
 * `globals: false` means Testing Library cannot register its own auto-cleanup,
 * so unmounting between component specs is registered here explicitly — without
 * it, every rendered bar from earlier specs stays mounted and queries find more
 * than one element.
 */
import { afterEach } from 'vitest'

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => {
    cleanup()
  })
}
