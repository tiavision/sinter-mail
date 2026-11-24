// mail.mime in a built app (docs/proposals/sinter-mail-mime.md, sections 1 and 8): fixtures/mime.html, the page that
// reads an .eml from a `file:` resource, built as an app builds it. In a plain build the message folds at build time:
// its subject and its text are in the HTML. With the package in `sinter({ lazy })`, mail.mime is a lazy helper: the
// reader is a chunk of its own, loaded when a let first needs it, and a page that also calls mail.bytes holds that
// helper in its own chunk, without the reader (bytes.ts imports no reader).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, PKG } from './app.js';

const PAGE = readFileSync(join(PKG, 'fixtures/mime.html'), 'utf8');
const EML = readFileSync(join(PKG, 'fixtures/mails/notes.eml'));
// the fixture page, plus an attachment's size read with mail.bytes where the reader has to have loaded
const BYTES = PAGE.replace('<ul id="attachments">',
  '<p id="size" data-sn-text="msg ? mail.bytes(raw, msg.attachments[0].ref).length : 0"></p>\n    <ul id="attachments">');

/** markers of each module in a built chunk: strings only it holds */
const READER = 'boundary-missing-close', BYTES_HELPER = "has no 'ok' plaintext";

const apps = {
  plain: { a: app({ 'mails/notes.eml': EML, 'index.html': PAGE }), lazy: false },
  lazy: { a: app({ 'mails/notes.eml': EML, 'index.html': BYTES }), lazy: true },
};
const out: Record<string, { html: string; chunks: { name: string; code: string }[]; error: string | null }> = {};
beforeAll(async () => {
  for (const [name, { a, lazy }] of Object.entries(apps)) {
    let error: string | null = null;
    const options = { libraries: ['@tiavision/sinter-mail'], ...(lazy ? { lazy: ['@tiavision/sinter-mail'] } : {}) };
    try {
      // (`as never`: sinter from a local path brings its own copy of Vite's types, which TypeScript sees as another Vite)
      await build({ root: a.root, logLevel: 'silent', plugins: [sinter(options) as never], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
    } catch (e) { error = (e as Error).message; }
    const dist = join(a.root, 'dist');
    const assets = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')) : [];
    out[name] = {
      html: existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '',
      chunks: assets.map((f) => ({ name: f, code: readFileSync(join(dist, 'assets', f), 'utf8') })),
      error,
    };
  }
}, 300_000);
afterAll(() => { for (const { a } of Object.values(apps)) a.remove(); });

test('a plain build folds the message: its subject, its body and its attachments are in the HTML', () => {
  const { html, chunks, error } = out.plain!;
  expect(error).toBe(null);
  expect(html).toContain('<h1 id="subject">Notes on the engine—G</h1>');
  expect(html).toContain('<p id="from">Ada Lovelace</p>');
  // the HTML alternative, through mail.parse into <mail-body>
  expect(html).toMatch(/<p>Note G is attached: <b>the Bernoulli numbers<\/b>, step by step\. The table is in the PDF\.<\/p>/);
  expect(html).toContain('<li>note-g.pdf (54 bytes)</li>');
  // no chunk of the page holds the reader: it ran at build time
  expect(chunks.filter((c) => c.code.includes(READER)).map((c) => c.name)).toEqual([]);
});

test('with the package lazy, the reader is a chunk of its own, and the page\'s chunk holds mail.bytes without it', () => {
  const { chunks, error } = out.lazy!;
  expect(error).toBe(null);
  const reader = chunks.filter((c) => c.code.includes(READER));
  expect(reader).toHaveLength(1);
  // the reader's chunk holds the reader only, not mail.bytes's validation
  expect(reader[0]!.code).not.toContain(BYTES_HELPER);
  const withBytes = chunks.filter((c) => c.code.includes(BYTES_HELPER));
  expect(withBytes.length).toBeGreaterThan(0);
  for (const c of withBytes) expect(c.code).not.toContain(READER);
  // the page loads mail.bytes with it and the reader on demand: from the page's script, its static imports reach a
  // chunk with mail.bytes, never the reader's (sinter 0.22 puts the import() in the page's chunk, beside its other
  // lazy helpers, and mail.bytes in a chunk it shares with the eager ones)
  const loaded = staticImports(out.lazy!.html, chunks);
  expect(withBytes.some((c) => loaded.has(c.name))).toBe(true);
  expect(loaded.has(reader[0]!.name)).toBe(false);
  expect(chunks.some((c) => loaded.has(c.name) && c.code.includes('import(`./'))).toBe(true);
});

/** the chunks the page loads before any let needs a lazy helper: its script and what that imports statically */
function staticImports(html: string, chunks: { name: string; code: string }[]): Set<string> {
  const byName = new Map(chunks.map((c) => [c.name, c.code]));
  const todo = [...html.matchAll(/<script[^>]*\ssrc="[^"]*\/assets\/([^"/]+\.js)"/g)].map((m) => m[1]!);
  const seen = new Set<string>();
  while (todo.length) {
    const name = todo.pop()!;
    if (seen.has(name) || !byName.has(name)) continue;
    seen.add(name);
    for (const m of byName.get(name)!.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) todo.push(m[1]!);
  }
  return seen;
}
