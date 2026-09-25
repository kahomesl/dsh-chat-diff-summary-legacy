// @vitest-environment node
/**
 * Built-artifact and compatibility gates.
 *
 * These specs read what `npm run build` actually produced, and read the source
 * tree for the APIs the target line does not have. They are the executable form
 * of two hard requirements: the browser half must not carry a second React, and
 * this plugin must not reference anything that only exists after 0.1.5-rc.2.
 */
import { describe, expect, test } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Read one built artifact, or undefined when the project has not been built. */
async function artifact(name: string): Promise<string | undefined> {
  try {
    return await readFile(join('lib', name), 'utf8')
  } catch {
    return undefined
  }
}

/** Every source file under `src/`, with its text. */
async function sources(): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push({ path, text: await readFile(path, 'utf8') })
    }
  }
  await walk('src')
  return found
}

/**
 * Remove comments, so the compatibility scan reads code rather than prose.
 *
 * The forbidden API names are worth *naming* in a comment that explains why this
 * build avoids them; what must never happen is a mention in executable code.
 * @param text - one source file, or one built artifact.
 * @returns the text with block and line comments removed.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/** React implementation markers that must never appear in a client bundle. */
const REACT_INTERNALS = [
  'react.production.min',
  'react.development.js',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
  'ReactCurrentOwner',
  'ReactCurrentDispatcher',
]

describe('the browser half', () => {
  test('registers itself through the host ModuleLoader under its package id', async () => {
    const text = await artifact('client.js')
    expect(text, 'run `npm run build` before this spec').toBeDefined()
    expect(text?.startsWith('window.__ModuleLoader__.load({ id: "dsh-chat-diff-summary-legacy", factory: (require) => {')).toBe(true)
    expect(text?.trimEnd().endsWith('return module.exports; } });')).toBe(true)
  })

  test('requires React from the host table instead of inlining a second copy', async () => {
    const text = (await artifact('client.js')) ?? ''
    const required = [...text.matchAll(/require\((?:"|')([^"']+)(?:"|')\)/gu)].map((match) => match[1])
    expect([...new Set(required)].sort()).toEqual(['react', 'react/jsx-runtime'])
    for (const marker of REACT_INTERNALS) expect(text).not.toContain(marker)
    // A second React would also be visible as React's own module table entries.
    expect(text).not.toContain('node_modules/react/cjs')
  })

  test('requires nothing from the client module graph beyond the platform seed words', async () => {
    const text = (await artifact('client.js')) ?? ''
    for (const match of text.matchAll(/require\((?:"|')([^"']+)(?:"|')\)/gu)) {
      expect(match[1]?.startsWith('@deepseek-ai/')).toBe(false)
    }
  })

  test('carries no source-map trailer, so the host never asks for a missing map', async () => {
    const text = (await artifact('client.js')) ?? ''
    expect(text).not.toContain('sourceMappingURL')
  })

  test('is a CJS factory the ModuleLoader can materialize, not an ES module', async () => {
    const text = (await artifact('client.js')) ?? ''
    expect(text).toContain('var module = { exports: {} };')
    expect(text).not.toMatch(/^import\s/mu)
    expect(text).not.toMatch(/^export\s/mu)
  })
})

describe('the host half', () => {
  test('imports nothing but Node built-ins at runtime', async () => {
    const text = (await artifact('index.js')) ?? ''
    expect(text, 'run `npm run build` before this spec').toBeDefined()
    const imported = [...text.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] ?? '')
    expect(imported.length).toBeGreaterThan(0)
    for (const specifier of imported) expect(specifier.startsWith('node:')).toBe(true)
  })

  test('is an ES module the host Loader can import', async () => {
    const text = (await artifact('index.js')) ?? ''
    expect(text).toMatch(/^export \{/mu)
    expect(text).toMatch(/export \{ apply, inject, name \}|apply.*inject.*name/u)
  })
})

describe('the target line', () => {
  test('never names an API that only exists after DeepSeek Harness 0.1.5-rc.2', async () => {
    // DSH Desktop 2.0.13 ships 0.1.5-rc.2, which has no workspace-changes
    // package, no `ctx.workspaceChanges`, no `workspace/changes` Session event
    // and no `changes-review` resource type.
    const forbidden = ['dsh-workspace-changes', 'workspaceChanges', 'workspace/changes', 'changes-review']
    const files = await sources()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const code = stripComments(file.text)
      for (const name of forbidden) expect(code, `${file.path} names ${name}`).not.toContain(name)
    }
  })

  test('scans code rather than comments, without emptying the file it scans', async () => {
    const files = await sources()
    const host = files.find((file) => file.path.endsWith('src/index.ts'))
    expect(host).toBeDefined()
    // The strip must leave executable text behind, or every assertion above
    // would pass vacuously.
    expect(stripComments(host?.text ?? '')).toContain("ctx.on('session/event'")
  })

  test('never reaches for the official changed-files card or its routes', async () => {
    const forbidden = ['/api/changes', 'changed-files', 'ChangedFilesCard', 'useWorkspaceChanges']
    for (const file of await sources()) {
      const code = stripComments(file.text)
      for (const name of forbidden) expect(code, `${file.path} names ${name}`).not.toContain(name)
    }
  })

  test('declares the exact compatibility it was built for', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { dsh?: { engines?: { dsh?: string } } }
    const range = manifest.dsh?.engines?.dsh ?? ''
    // The floor stays on the legacy line, so a 2.0.13 install keeps working.
    expect(range).toContain('0.1.5-rc.1')
    // The brief is explicit: this build must not *require* 0.1.6 or later.
    expect(range).not.toMatch(/>=\s*0\.1\.[6-9]/u)
    // The ceiling covers the kernel the current desktop build ships (0.1.7-rc.2).
    expect(range).toContain('<0.1.8')
  })

  test('declares React as a peer so the bundler keeps it external', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      peerDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    // tsdown externalizes `dependencies` + `peerDependencies`; a React that is
    // only a devDependency would be inlined into the browser bundle.
    expect(manifest.peerDependencies?.['react']).toBeDefined()
    expect(manifest.peerDependencies?.['react-dom']).toBeDefined()
    expect(manifest.dependencies ?? {}).toEqual({})
  })
})

describe('the bundle patch', () => {
  test('inserts this plugin and disables nothing', async () => {
    const text = await readFile('cordis.patch.yml', 'utf8')
    expect(text).toContain('dsh-chat-diff-summary-legacy')
    expect(text).toContain('insert:')
    // A bundle layer of this plugin must never switch a shipped row off.
    expect(text).not.toMatch(/^\s*disabled:\s*true/mu)
  })
})
