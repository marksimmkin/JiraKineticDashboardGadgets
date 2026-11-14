# Security: npm audit findings

Last reviewed 2026-11-14 (KDG-20) with `@forge/bridge` 7.3.0.

## Outcome

`npm audit` went from 11 findings (7 high, 4 moderate) to 8 (5 high, 3 moderate).

- **Fixed:** `undici`, `fast-uri` (upgrading `@forge/bridge` 7.1.0 to 7.3.0) and `markdown-it` (non-breaking `npm audit fix`).
- **Remaining:** `prosemirror-view` (through `@atlaskit/editor-prosemirror` and `@atlaskit/adf-schema`), and `glob` and `minimatch` (through `@forge/manifest`). npm reports them against `@forge/bridge` itself. Their only suggested fix is a downgrade to `@forge/bridge` 5.5.0, which we don't take. Don't run `npm audit fix --force`.

## Why the remaining findings don't ship

The gadgets ship only `static/*/dist/app.js`. esbuild bundles only the code that is imported. An esbuild metafile for every gadget bundle lists the same `node_modules` packages:

`@forge/bridge`, `@forge/egress`, `@forge/i18n`, `iframe-resizer`, `lodash`, `tslib`

None of these is flagged by `npm audit`. No `@atlaskit/*`, `prosemirror-*`, `@forge/manifest`, `glob`, `minimatch`, `markdown-it`, `undici` or `fast-uri` file is an input to any bundle. A text search of the built bundles for those package names also finds nothing. The flagged packages are install-time dependencies of `@forge/bridge` (manifest validation and ADF types), not part of its browser runtime.

## How to re-check

1. `npm ci && npm audit`
2. `npm view @forge/bridge version` to see whether a newer release clears more findings.
3. Build each gadget with esbuild's `metafile: true` (same options as `scripts/build.mjs`) and list the `node_modules/<package>` paths in `metafile.inputs`. Don't commit the metafile.
4. `grep -lE 'prosemirror|undici|markdown-it|minimatch|fast-uri' static/*/dist/app.js` after `npm run build`. It should print nothing.

If a flagged package ever shows up in a bundle, treat the finding as shipped and fix it.
