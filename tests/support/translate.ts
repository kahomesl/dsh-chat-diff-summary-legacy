/**
 * Translate stub for component specs.
 *
 * Mirrors the host locale runtime's `{name}` interpolation so a component that
 * renders a placeholder the dictionary does not supply looks the same here as it
 * would in the browser.
 */

/** Build a translate function over one dictionary, falling back to the key. */
export function makeTranslate(dict: Record<string, string>): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}
