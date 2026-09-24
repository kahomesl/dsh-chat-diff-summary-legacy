const packageId = 'dsh-chat-diff-summary-legacy'

export default [
  {
    // Host half: the per-turn git snapshot tracker and its authenticated summary
    // route. Runs in the Node host process, so nothing of the browser half is
    // reachable from here and no `@deepseek-ai/*` package is imported at runtime.
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    clean: true,
  },
  {
    // Browser half: loaded through the web UI's `window.__ModuleLoader__`, so it
    // is wrapped in the loader's own registration call and must NOT bundle a
    // second React.
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    // React and ReactDOM come from the host's static module table (a seed word
    // in the ModuleLoader), exactly like every shipped client plugin. Inlining
    // them would create a second React instance and break every host hook, so
    // they are named explicitly here as well as in `peerDependencies`:
    // tsdown 0.15 has no `deps.neverBundle` option, and an unrecognized key is a
    // silent no-op that would quietly ship a second React.
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    dts: false,
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]
