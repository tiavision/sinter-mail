// How much of the wait for an email from an API is the network: the API answer gzipped, as a server sends it,
// under Chromium's network throttling. Times from the request's start (navigation already done).
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApi, launch, newsletter, elements } from './harness.mjs';
const N = +(process.argv[2] ?? 2000), runs = +(process.argv[3] ?? 5);
const tree = newsletter(N), COUNT = tree.children.flatMap((c) => [...elements(c)]).length;
const json = Buffer.from(JSON.stringify(tree)), gz = gzipSync(json, { level: 6 });
const a = await buildApi();
const dir = join(a.root, 'dist');
const s = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/message') { res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Encoding', 'gzip'); return res.end(gz); }
  try { const b = readFileSync(join(dir, p === '/' ? 'index.html' : p)); res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(b); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${s.address().port}/`;
const PROFILES = { none: null, 'fast 4G (9 Mbps, 85 ms RTT)': [9e6, 85], 'slow 4G (1.6 Mbps, 150 ms RTT)': [1.6e6, 150] };
const b = await launch();
console.log(`${COUNT} elements: ${(json.length / 1024).toFixed(0)} kB JSON, ${(gz.length / 1024).toFixed(1)} kB gzip`);
for (const [name, prof] of Object.entries(PROFILES)) {
  const xs = [];
  for (let r = 0; r < runs; r++) {
    const p = await b.newPage();
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Network.enable');
    if (prof) await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: prof[0] / 8, uploadThroughput: prof[0] / 8, latency: prof[1] });
    await p.goto(url);
    await p.waitForFunction((n) => document.querySelectorAll('#message *').length === n, COUNT, { polling: 50, timeout: 60000 });
    await p.waitForTimeout(100);
    xs.push(await p.evaluate(() => {
      const e = performance.getEntriesByType('resource').find((x) => x.name.endsWith('/api/message'));
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const js = Math.max(...performance.getEntriesByType('resource').filter((x) => x.name.endsWith('.js')).map((x) => x.responseEnd));
      return { firstByte: e.responseStart - e.startTime, transfer: e.responseEnd - e.responseStart, paint: fcp.startTime - e.responseEnd, jsLate: js - e.responseEnd, afterJs: fcp.startTime - Math.max(js, e.responseEnd) };
    }));
    await p.close();
  }
  const med = (k) => { const v = xs.map((x) => x[k]).sort((p, q) => p - q); return v[v.length >> 1].toFixed(0).padStart(5); };
  console.log(`  ${name.padEnd(32)} request to first byte ${med('firstByte')} ms   body transfer ${med('transfer')} ms   last byte to first paint ${med('paint')} ms (page JS arrives ${med('jsLate')} ms after it; first paint ${med('afterJs')} ms after both)`);
}
await b.close(); s.close(); a.remove();
