// The MIME reader's structure against the corpus (test/mime-corpus/README.md): Stalwart's messages agree with
// structure.json (content-type trees, charsets, text prefixes, delimiter problems), the charset fixtures decode
// to their expected strings, and every hostile fixture and generator meets the structure-layer part of its
// expected outcome in test/mime-corpus/hostile/manifest.json, within its time bound.
import { describe, expect, test } from 'vitest';
import { mime } from '../sinter/mime.js';
import { paramOf, scan, type Entity } from '../sinter/mime/scan.js';
import { reader, textQuiet } from '../sinter/mime/show.js';
import type { Address, Message, Part } from '../sinter/mime/types.js';
import { corpus, corpusJson, generators, type GeneratorName } from './mime-corpus.js';

type Node = { type: string; parts?: Node[]; message?: Node; charset?: string | null; encoding?: string | null; text?: string };
const structure = corpusJson<{ messages: Record<string, { tree: Node; problems: string[] }>; skipped: Record<string, string> }>('stalwart/structure.json');
const stalwart = new Map(corpus('stalwart').map((f) => [f.name, f.bytes]));

/**
 * Where our reading differs from Stalwart's on purpose, and what ours is. The Content-Type of malformed/017.eml
 * has no `;` before its boundary (`multipart/mixed\r\n\tboundary="boundary"`): the lexical layer reads it as
 * not `type/subtype` followed by parameters, so it is RFC 2045's default with `content-type-invalid`.
 */
const DIFFERENT: Record<string, (m: Message, root: Entity) => void> = {
  'malformed/017.eml': (m, root) => {
    expect(root.type).toBe('text/plain');
    expect(m.problems).toEqual([{ code: 'content-type-invalid', part: '1', blocking: true }]);
  },
};

/** the differences between the tree read and the expected one, as messages */
function compare(src: Uint8Array, root: Entity, tree: Node): string[] {
  const r = reader(new Map([['input', src]]), [], 'html');
  const out: string[] = [];
  const walk = (e: Entity, n: Node, path: string) => {
    if (e.type !== n.type) out.push(`${path}: type ${e.type}, expected ${n.type}`);
    if (n.parts) {
      if (e.children.length !== n.parts.length) out.push(`${path}: ${e.children.length} children, expected ${n.parts.length}`);
      else n.parts.forEach((p, i) => walk(e.children[i]!, p, e.children[i]!.id));
    }
    if (n.message) {
      if (!e.message) out.push(`${path}: no nested message`);
      else walk(e.message, n.message, `${path}>`);
    }
    if ('charset' in n) {
      const c = paramOf(e.params, 'charset');
      if ((c === null ? null : c.toLowerCase()) !== n.charset) out.push(`${path}: charset ${c}, expected ${n.charset}`);
      if (n.encoding) {
        const label = c ?? 'utf-8';
        let name: string | null = null;
        try { name = new TextDecoder(label.trim()).encoding; } catch { /* not a WHATWG label */ }
        if (name !== n.encoding) out.push(`${path}: encoding ${name}, expected ${n.encoding}`);
      }
    }
    if (n.text !== undefined) {
      const t = Array.from(textQuiet(r, e)).slice(0, 40).join('');
      if (t !== n.text) out.push(`${path}: text ${JSON.stringify(t)}, expected ${JSON.stringify(n.text)}`);
    }
  };
  walk(root, tree, root.id);
  return out;
}

describe('the Stalwart corpus', () => {
  const names = Object.keys(structure.messages);

  test('structure.json covers 97 messages', () => expect(names.length).toBe(97));

  test.each(names)('%s agrees with structure.json', (name) => {
    const src = stalwart.get(name)!;
    const s = scan(src);
    const m = mime(src);
    if (DIFFERENT[name]) { DIFFERENT[name](m, s.root); return; }
    expect(compare(src, s.root, structure.messages[name]!.tree)).toEqual([]);
    const found = new Set(m.problems.map((p) => p.code));
    for (const c of structure.messages[name]!.problems) expect(found.has(c as never), c).toBe(true);
  });

  test('every message, the skipped ones too, reads without throwing, fast, deterministically', () => {
    for (const [name, src] of stalwart) {
      const t = performance.now();
      const m = mime(src.slice());
      expect(performance.now() - t, name).toBeLessThan(1000);
      expect(JSON.stringify(mime(src.slice())), name).toBe(JSON.stringify(m));
      expect(JSON.parse(JSON.stringify(m)), name).toEqual(m);
    }
  });

  test('the skipped messages read by the proposal\'s rules', () => {
    const read = (name: string) => mime(stalwart.get(name)!);
    const has = (m: Message, code: string, part: string) => expect(m.problems).toContainEqual({ code, part, blocking: true });
    // a boundary that starts with an ancestor's, one longer than 70, two Content-Type fields
    has(read('malformed/006.eml'), 'boundary-invalid', '1.1');
    has(read('malformed/016.eml'), 'boundary-invalid', '1');
    has(read('malformed/007.eml'), 'duplicate-field', '1.1');
    has(read('malformed/020.eml'), 'duplicate-field', '1.1');
    // a transfer encoding on a message/rfc822: ignored, the nested message read as it is
    has(read('rfc/008.eml'), 'encoding-on-multipart', '1.2');
    has(read('regressions/doubly-encoded-message.eml'), 'encoding-on-multipart', '1');
    expect(read('malformed/016.eml').attachments).toMatchObject([{ id: '1', contentType: 'multipart/mixed', kind: 'file' }]);
  });

  test('thirdparty/011.eml: an empty body whose blank line is the delimiter\'s line break is no problem', () => {
    const m = mime(stalwart.get('thirdparty/011.eml')!);
    expect(m.problems.filter((p) => p.code === 'no-header-end')).toEqual([]);
  });
});

describe('the charset fixtures', () => {
  type Expected = { file: string; subject?: string; parts: { part: string; text?: string; problems?: string[] }[] };
  test.each(['own', 'jsmime-charsets', 'jsmime-shift-jis-image'])('%s decodes to its expected strings', (name) => {
    const e = corpusJson<Expected>(`charsets/${name}.expected.json`);
    const src = corpus('charsets').find((f) => f.name === e.file)!.bytes;
    const m = mime(src);
    if (e.subject) expect(m.headers.subject).toBe(e.subject);
    const s = scan(src), r = reader(new Map([['input', src]]), [], 'html');
    const entity = (id: string) => [s.root, ...s.root.children].find((x) => x.id === id)!;
    for (const p of e.parts) {
      if (p.text === undefined) continue;
      const part = m.parts.find((x) => x.id === p.part) as Part & { type: 'text' };
      expect(part?.type, p.part).toBe('text');
      expect(part.text.trimEnd(), p.part).toBe(p.text.trimEnd());
      // the problems of decoding the body (a header read as UTF-8 can add its own, of the same entity)
      textQuiet(r, entity(p.part));
      expect([...r.texts.get(entity(p.part))!.codes].sort(), p.part).toEqual([...(p.problems ?? [])].sort());
    }
  });
});

describe('the hostile manifest', () => {
  type Expected = {
    outcome: string; timeBoundMs: number; problems?: string[]; noProblems?: boolean; blocking?: boolean; noSteps?: boolean;
    steps?: string[]; tree?: Node; texts?: string[]; subject?: string | null; noControls?: boolean; maxAddresses?: number;
    headersFrom?: string; addresses?: unknown; suspicious?: unknown; summaryFrom?: unknown;
  };
  type Entry = { name: string; file?: string; generator?: string; expected: Expected };
  const manifest = corpusJson<{ fixtures: Entry[]; generators: Entry[] }>('hostile/manifest.json');
  const hostile = new Map(corpus('hostile').map((f) => [f.name, f.bytes]));

  /**
   * Where the structure layer departs from the manifest on purpose. postal-mime-boundary-near-miss: the boundary
   * B…B10 starts with its ancestor B…B1, so that entity is `boundary-invalid` and one attachment of its bytes; the
   * walk stops there, at level 11, and never reaches the 32-level limit the manifest also expects.
   */
  const NOT_EXPECTED: Record<string, string[]> = {
    'postal-mime-boundary-near-miss': ['limit'],
    // the Subject of 100,000 words (about 1.9 MB) runs past the root's 1 MB header limit and is dropped whole
    // (headers.readHeaders), so no word of it is decoded and nothing falls back to windows-1252
    'postal-mime-encoded-word-join-invalid': ['charset-fallback'],
  };
  /** problems that only a step's result makes: not asserted here (test/mime-crypto.test.ts feeds results) */
  const WAVE_3 = new Set(['integrity']);

  const tree = (e: Entity): Node => ({ type: e.type, ...(e.children.length ? { parts: e.children.map(tree) } : {}) });
  /** the expected tree's shape, with only the keys it names */
  const shape = (n: Node): Node => ({ type: n.type, ...(n.parts ? { parts: n.parts.map(shape) } : {}) });

  const strings = (m: Message): string[] => {
    const out: string[] = [];
    const stack: unknown[] = [m.headers, m.attachments.map((a) => [a.filename, a.originalFilename])];
    while (stack.length) {
      const x = stack.pop();
      if (typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object') stack.push(...Object.values(x));
    }
    return out;
  };

  const check = (name: string, input: () => Uint8Array, x: Expected) => {
    const src = input();
    const t = performance.now();
    const m = mime(src);
    expect(performance.now() - t, `${name}: ${x.outcome}`).toBeLessThan(x.timeBoundMs);
    const codes = new Set(m.problems.map((p) => p.code));
    for (const c of x.problems ?? []) {
      if (WAVE_3.has(c)) continue;
      if (NOT_EXPECTED[name]?.includes(c)) { expect(codes.has(c as never), c).toBe(false); continue; }
      expect(codes.has(c as never), `${name}: ${c}`).toBe(true);
      if (x.blocking) expect(m.problems.some((p) => p.code === c && p.blocking), `${name}: ${c} blocking`).toBe(true);
    }
    if (x.noProblems) expect(m.problems).toEqual([]);
    if (x.noSteps) expect(m.steps).toEqual([]);
    if (x.steps) expect(m.steps.map((s) => s.kind)).toEqual(x.steps);
    if (x.tree) expect(tree(scan(src).root)).toEqual(shape(x.tree));
    if (x.texts) expect(m.parts.map((p) => (p.type === 'text' ? p.text : p.type))).toEqual(x.texts);
    if ('subject' in x) expect(m.headers.subject).toBe(x.subject);
    if (x.headersFrom) expect(m.headers.from.map((a) => a.address)).toEqual([x.headersFrom]);
    if (x.noControls) for (const s of strings(m)) expect(s).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f؜‎‏‪-‮⁦-⁩]/);
    if (x.maxAddresses) for (const f of ['from', 'to', 'cc'] as const) expect((m.headers[f] as Address[]).length).toBeLessThanOrEqual(x.maxAddresses);
    return m;
  };

  test.each(manifest.fixtures.map((e) => [e.name, e] as const))('fixture %s', (name, e) => {
    check(name, () => hostile.get(e.file!)!, e.expected);
  });

  test.each(manifest.generators.map((e) => [e.name, e] as const))('generator %s', (name, e) => {
    check(name, generators[e.generator as GeneratorName], e.expected);
  });

  test('the generators\' structure in detail', () => {
    const many = mime(generators.manyParts());
    expect(many.parts.length).toBe(999);
    expect(many.attachments).toMatchObject([{ id: '1.1000', kind: 'file' }]);
    const deep = mime(generators.deepNesting());
    expect(deep.attachments).toMatchObject([{ id: Array(33).fill('1').join('.'), contentType: 'multipart/mixed' }]);
    const near = mime(generators.postalMimeBoundaryNearMiss());
    expect(near.problems[0]).toEqual({ code: 'boundary-invalid', part: Array(11).fill('1').join('.'), blocking: true });
    const single = mime(generators.singlePart());
    expect((single.parts[0] as Part & { type: 'text' }).text.length).toBe(2 * 1024 * 1024);
    // the PGP shapes, pending their steps
    expect(mime(generators.pgpMimeEncrypted()).parts).toMatchObject([{ id: '1', type: 'encrypted', reason: 'pending' }]);
    expect(mime(generators.exchangePgpMime()).parts).toMatchObject([{ id: '1', type: 'encrypted', reason: 'pending' }]);
    expect(mime(generators.pgpMimeSigned()).parts).toMatchObject([{ type: 'text', text: 'The signed text.', protection: { signed: 'pending' } }]);
    const lf = mime(generators.pgpMimeSignedLf());
    expect(lf.steps).toMatchObject([{ kind: 'verify', signed: { canonical: true } }]);
    expect(mime(generators.pgpMimeSigned()).steps[0]).not.toHaveProperty('signed.canonical');
    const words = mime(generators.manyEncodedWords()).headers.subject;
    expect(words === null || /^(ABC){0,4096}$/.test(words)).toBe(true);
  });
});
