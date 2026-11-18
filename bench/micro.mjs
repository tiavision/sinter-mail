import { launch } from './harness.mjs';
const b = await launch(); const p = await b.newPage();
await p.setContent('<div id=r></div>');
const r = await p.evaluate(() => {
  const props = [['padding-top','8px'],['padding-right','8px'],['padding-bottom','8px'],['padding-left','8px'],['vertical-align','top'],['background-color','rgb(250, 250, 250)'],['border-bottom-width','1px'],['border-bottom-style','solid'],['border-bottom-color','rgb(221, 221, 221)'],['width','33%']];
  const run = (k, mode, N = 2000) => {
    const els = Array.from({ length: N }, () => document.createElement('div'));
    const t = performance.now();
    for (const e of els) {
      if (mode == 'set') for (let i = 0; i < k; i++) e.style.setProperty(props[i][0], props[i][1]);
      else { let s = ''; for (let i = 0; i < k; i++) s += props[i][0] + ':' + props[i][1] + ';'; e.style.cssText = s; }
    }
    const d = performance.now() - t;
    document.getElementById('r').replaceChildren(...els); document.body.offsetHeight; // style recalc
    return d;
  };
  const out = {};
  for (const k of [2, 5, 10]) for (const m of ['set', 'css']) { const xs = []; for (let i = 0; i < 15; i++) xs.push(run(k, m)); xs.sort((a, b) => a - b); out[`${k} props ${m}`] = +xs[7].toFixed(2); }
  return out;
});
console.log('2000 fresh elements, median ms of the write loop:', r);
await b.close();
