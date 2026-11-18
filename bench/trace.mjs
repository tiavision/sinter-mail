import { buildApi, serve, launch, newsletter, elements } from './harness.mjs';
const { progressive } = await import(new URL('../sinter/tree.ts', import.meta.url).pathname);
const v = process.argv[2] ?? 'prog', N = +(process.argv[3] ?? 2000), head = +(process.argv[4] ?? 200);
const t = newsletter(N); if (v === 'prog') progressive(t, head);
const COUNT = t.children.flatMap((c) => [...elements(c)]).length, MSG = JSON.stringify(t);
const a = await buildApi(v === 'prog' ? '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-prop="{ body: message }"></mail-body></main>' : undefined); const srv = await serve(a.root + '/dist', () => MSG);
const b = await launch(); const p = await b.newPage();
await p.goto(srv.url); await p.close();               // warm the HTTP cache / compile cache
const q = await b.newPage();
await b.startTracing(q, { categories: ['devtools.timeline', 'blink.user_timing', 'loading'] });
await q.goto(srv.url + (process.env.Q ? '?' + process.env.Q : ''));
await q.waitForFunction((n) => document.querySelectorAll('#message *:not(#message > i[hidden])').length === n, COUNT, { polling: 50 });
await q.waitForTimeout(200);
const ev = JSON.parse((await b.stopTracing()).toString()).traceEvents;
const send = ev.find((e) => e.name === 'ResourceSendRequest' && JSON.stringify(e.args).includes('api/message'));
const rid = send.args.data.requestId;
const resp = ev.filter((e) => e.args?.data?.requestId === rid && e.name === 'ResourceFinish')[0] ?? ev.filter((e) => e.args?.data?.requestId === rid).at(-1);
const fcp = ev.find((e) => e.name === 'firstContentfulPaint');
const ME = ev.filter((e) => e.pid === fcp.pid && e.tid === fcp.tid);
const t0 = resp.ts;
const NAMES = ['HandlePostMessage','FunctionCall','EvaluateScript','UpdateLayoutTree','Layout','Paint','PrePaint','Layerize','TimerFire','FireAnimationFrame','RunMicrotasks','ParseHTML','Commit'];
const tasks = []; let end = -1;
for (const e of ME.filter((e) => e.dur && NAMES.includes(e.name) && e.ts > t0 - 2000).sort((x, y) => x.ts - y.ts)) { if (e.ts < end) continue; end = e.ts + e.dur; if (e.dur > 300) tasks.push({ name: e.name, at: +((e.ts - t0) / 1000).toFixed(1), ms: +(e.dur / 1000).toFixed(1) }); }
const paints = ME.filter((e) => e.name === 'Paint' || e.name === 'firstContentfulPaint').map((e) => `${e.name}@${((e.ts - t0) / 1000).toFixed(1)}`);
console.log(v, COUNT, 'elements; times from the API response (ms)'); console.table(tasks); console.log(paints.slice(0, 8).join('  '));
await b.close(); srv.close(); a.remove();
