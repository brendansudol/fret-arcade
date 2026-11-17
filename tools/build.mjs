// Bundles the app into one self-contained page fragment for publishing
// (dist/fret-arcade.html), plus a local preview of that same fragment
// wrapped the way the publisher wraps it (dist/preview.html).
//
//   node tools/build.mjs

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await mkdir(out, { recursive: true });

const js = await build({
  entryPoints: [join(root, 'js/main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = await readFile(join(root, 'css/app.css'), 'utf8');
const index = await readFile(join(root, 'index.html'), 'utf8');
const fonts = index.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];

const page = `<title>Fret Arcade</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
<div id="viewport"><div id="fit"><main id="stage"></main></div></div>
<script>
${script}
</script>
`;
await writeFile(join(out, 'fret-arcade.html'), page);

const skeleton = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${page}</body></html>`;
await writeFile(join(out, 'preview.html'), skeleton);
console.log(`dist/fret-arcade.html  ${(page.length / 1024).toFixed(0)} KB`);
