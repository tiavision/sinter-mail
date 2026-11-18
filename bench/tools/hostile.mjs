// The hostile stylesheets of css.test.ts by resolve time, best of 3, for each folder given:
// `node bench/tools/hostile.mjs <sinter-mail folder> ...`.
import { bundle } from '../bundle.mjs';
const pkgs = process.argv.slice(2);
const mods = [];
for (const p of pkgs) mods.push(await import((await bundle(null, { code: `export { parseHTML, resolveStyles } from '${p}/sinter/engine.ts';`, minify: false })).path));
let deep = ''; for (let i = 0; i < 200; i++) deep += '<div><span><b>';
const wide = '<div><p><span>x</span></p></div>'.repeat(660);
const cases = { notStar: ':not(#a) * {color:red}'.repeat(40_000), star: '*{color:red;margin:0 auto}'.repeat(40_000) };
for (const [cn, css] of Object.entries(cases)) for (const [bn, body] of Object.entries({ deep, wide })) {
  const row = [];
  for (const m of mods) {
    const ts = [];
    for (let r = 0; r < 3; r++) { const root = m.parseHTML(`<style>${css}</style>${body}`); const t = performance.now(); m.resolveStyles(root, { media: 'wide' }); ts.push(performance.now() - t); }
    row.push(Math.min(...ts).toFixed(0));
  }
  console.log(cn.padEnd(8), bn.padEnd(5), row.join(' ms  vs  '), 'ms');
}
