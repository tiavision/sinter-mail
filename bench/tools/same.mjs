// Trees of this package and of another folder (a worktree at another commit) equal, as JSON, over the corpus,
// the benchmark's email and the cascade tests' documents, both media: `node bench/tools/same.mjs <folder>`.
import { readFileSync, readdirSync } from 'node:fs';
import { bundle, PKG } from '../bundle.mjs';
import { newsletterHtml } from '../newsletter.mjs';
const other = process.argv[2];
const a = await import((await bundle(null, { code: `export { parse } from '${PKG}/sinter/parse.ts';`, minify: false })).path);
const b = await import((await bundle(null, { code: `export { parse } from '${other}/sinter/parse.ts';`, minify: false })).path);
const inputs = { bench: newsletterHtml() };
for (const f of readdirSync(PKG + '/test/corpus')) if (f.endsWith('.html')) inputs[f] = readFileSync(PKG + '/test/corpus/' + f, 'utf8');
// the cascade test's documents: every string literal over 200 chars with a <style in it
const src = readFileSync(PKG + '/test/css.browser.test.ts', 'utf8') + readFileSync(PKG + '/test/css.test.ts', 'utf8');
let k = 0; for (const m of src.matchAll(/`([^`]{80,})`/g)) if (/<style|style=/.test(m[1]) && !m[1].includes('${')) inputs['lit' + k++] = m[1];
let n = 0;
for (const [name, h] of Object.entries(inputs)) for (const media of ['wide', 'narrow']) {
  const x = JSON.stringify(a.parse(h, { media, images: 'allow' })), y = JSON.stringify(b.parse(h, { media, images: 'allow' }));
  if (x !== y) { console.log('DIFFER', name, media); process.exitCode = 1; } else n++;
}
console.log(`${n} trees equal (${Object.keys(inputs).length} inputs × 2 media)`);
