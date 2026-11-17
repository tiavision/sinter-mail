// mail.parse in Node, by phase: the HTML parser (sinter/parser), the cascade (sinter/css resolveStyles),
// the tree (parse.ts's build after them), memo's deep freeze; and parse5's own parse of the same HTML.
//
//   node bench/parse.mjs [--blocks 67] [--runs 30] [--pkg <sinter-mail folder>]
//
// Method: each phase bundled as the browser gets it (Vite, unminified), run `runs` times after 10 warm-up
// runs on the same string; the median of each phase is printed. One process, so the JIT is warm: the
// first parse of a page is slower (printed too, from a fresh process: `cold`).
import { execFileSync } from 'node:child_process';
import { bundle, PKG } from './bundle.mjs';
import { newsletterHtml } from './newsletter.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const BLOCKS = Number(opt('--blocks', 67));
const RUNS = Number(opt('--runs', 30));
const pkg = opt('--pkg', PKG);
const html = newsletterHtml(BLOCKS);

const entry = `
import { parseHTML, resolveStyles } from '${pkg}/sinter/engine.ts';
import { parse } from '${pkg}/sinter/parse.ts';
import { parse as parse5 } from 'parse5';
export { parseHTML, resolveStyles, parse, parse5 };
`;
const b = await bundle(null, { code: entry, minify: false });
const m = await import(b.path);

if (args.includes('--cold')) {
  // the first call of each phase in a fresh process: parser, cascade, then mail.parse of another source
  // (its parser and cascade now warm once, so its remainder is the tree and the freeze, cold)
  const t0 = performance.now(); const root = m.parseHTML(html);
  const t1 = performance.now(); m.resolveStyles(root, { media: 'wide' });
  const t2 = performance.now(); m.parse(html + '<!---->');
  const t3 = performance.now();
  const r2 = m.parseHTML(html + ' '); const t4 = performance.now(); m.resolveStyles(r2, { media: 'wide' }); const t5 = performance.now();
  console.log(JSON.stringify({ parser: t1 - t0, cascade: t2 - t1, second: t3 - t2, parser2: t4 - t3, cascade2: t5 - t4 }));
  process.exit(0);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (f) => { const t = performance.now(); f(); return performance.now() - t; };
const t = { parser: [], cascade: [], total: [], parse5: [], freeze: [] };
for (let i = 0; i < 10 + RUNS; i++) {
  let root;
  const a = time(() => { root = m.parseHTML(html); });
  const c = time(() => m.resolveStyles(root, { media: 'wide' }));
  // the whole of mail.parse, a new source each time so memo runs it (a comment at the end changes nothing else)
  const src = html + `<!--${i}-->`;
  const all = time(() => m.parse(src));
  const p5 = time(() => m.parse5(html));
  if (i >= 10) { t.parser.push(a); t.cascade.push(c); t.total.push(all); t.parse5.push(p5); }
}
const parser = median(t.parser), cascade = median(t.cascade), total = median(t.total);
const colds = Array.from({ length: 5 }, () => JSON.parse(execFileSync(process.execPath, [import.meta.filename, '--blocks', String(BLOCKS), '--pkg', pkg, '--cold'], { encoding: 'utf8' }).trim().split('\n').pop()));
const c = Object.fromEntries(Object.keys(colds[0]).map((k) => [k, median(colds.map((x) => x[k]))]));
const cold = c.parser + c.cascade;
console.log(`html ${(html.length / 1024).toFixed(1)} kB; medians of ${RUNS}`);
console.log(`  HTML parser      ${parser.toFixed(2)} ms`);
console.log(`  cascade          ${cascade.toFixed(2)} ms`);
console.log(`  tree + freeze    ${(total - parser - cascade).toFixed(2)} ms   (mail.parse less the two)`);
console.log(`  mail.parse       ${total.toFixed(2)} ms   (cold: parser and cascade ${cold.toFixed(1)} ms)`);
console.log(`  cold (fresh process, median of 5): parser ${c.parser.toFixed(1)} ms, cascade ${c.cascade.toFixed(1)} ms; then a second mail.parse ${c.second.toFixed(1)} ms (parser ${c.parser2.toFixed(1)}, cascade ${c.cascade2.toFixed(1)} on a third)`);
console.log(`  parse5.parse     ${median(t.parse5).toFixed(2)} ms   (its document only, for comparison with the HTML parser)`);
