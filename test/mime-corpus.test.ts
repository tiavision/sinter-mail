// The MIME test corpus loads and is well-formed; the generators are deterministic and the right size.
// (Tests of the reader itself use these; see test/mime-corpus/README.md.)

import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORPUS_DIR, corpus, corpusJson, generators, type GeneratorName } from './mime-corpus.js';

const PROBLEM_CODES = new Set([
  'boundary-missing-close', 'boundary-invalid', 'duplicate-field', 'duplicate-parameter', 'encoding-on-multipart',
  'encoding-unknown', 'no-header-end', 'crypto-shape', 'armor-headers', 'limit', 'integrity', 'duplicate-header',
  'canonicalized', 'exchange-shape', 'charset-unknown', 'charset-fallback', 'base64-junk', 'qp-invalid',
  'field-dropped', // section 4; not yet in section 2's table
]);

const count = (bytes: Uint8Array, needle: string) => {
  const s = Buffer.from(bytes).toString('latin1');
  let n = 0;
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
};
const headerBlock = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').indexOf('\r\n\r\n');

describe('fixtures', () => {
  test('the Stalwart corpus loads and structure.json names only its files', () => {
    const files = corpus('stalwart');
    expect(files.length).toBe(147);
    const names = new Set(files.map((f) => f.name));
    const s = corpusJson<{ messages: Record<string, { tree: { type: string } }>; skipped: Record<string, string> }>('stalwart/structure.json');
    expect(Object.keys(s.messages).length).toBeGreaterThan(90);
    for (const name of [...Object.keys(s.messages), ...Object.keys(s.skipped)]) expect(names.has(name), name).toBe(true);
    for (const m of Object.values(s.messages)) expect(m.tree.type).toMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
  });

  test('the charset fixtures load with their expectations', () => {
    const files = corpus('charsets');
    expect(files.map((f) => f.name)).toEqual(['jsmime-charsets.eml', 'jsmime-shift-jis-image.eml', 'own.eml']);
    for (const name of ['own', 'jsmime-charsets', 'jsmime-shift-jis-image']) {
      const e = corpusJson<{ file: string; parts: { part: string; problems?: string[] }[] }>(`charsets/${name}.expected.json`);
      expect(existsSync(resolve(CORPUS_DIR, 'charsets', e.file))).toBe(true);
      for (const p of e.parts) for (const c of p.problems ?? []) expect(PROBLEM_CODES.has(c), c).toBe(true);
    }
    const words = corpusJson<{ cases: { input: string; proposal: string | null }[] }>('charsets/encoded-words.json');
    expect(words.cases.length).toBeGreaterThan(40);
  });

  test('the hostile manifest is well-formed and names existing fixtures and generators', () => {
    type Entry = { name: string; file?: string; generator?: string; source: string[]; attacks: string; expected: { outcome: string; timeBoundMs: number; problems?: string[] } };
    const m = corpusJson<{ fixtures: Entry[]; generators: Entry[] }>('hostile/manifest.json');
    const all = [...m.fixtures, ...m.generators];
    expect(new Set(all.map((e) => e.name)).size).toBe(all.length);
    for (const e of m.fixtures) expect(existsSync(resolve(CORPUS_DIR, 'hostile', e.file!)), e.name).toBe(true);
    for (const e of m.generators) expect(e.generator! in generators, e.name).toBe(true);
    for (const e of all) {
      expect(typeof e.attacks).toBe('string');
      expect(Array.isArray(e.source)).toBe(true);
      expect(e.expected.outcome.length, e.name).toBeGreaterThan(0);
      expect(e.expected.timeBoundMs).toBeGreaterThan(0);
      for (const c of e.expected.problems ?? []) expect(PROBLEM_CODES.has(c), `${e.name}: ${c}`).toBe(true);
    }
    expect(corpus('hostile').length).toBe(m.fixtures.length);
  });
});

describe('generators', () => {
  test.each(Object.keys(generators) as GeneratorName[])('%s is deterministic', (name) => {
    const a = generators[name]();
    const b = generators[name]();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBeGreaterThan(0);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('the large ones are the right size', () => {
    const single = generators.singlePart();
    expect(single.length - headerBlock(single) - 4).toBe(2 * 1024 * 1024);
    expect(count(generators.manyParts(), '--flat\r\n')).toBe(20_000);
    expect(count(generators.deepNesting(), 'Content-Type: multipart/mixed')).toBe(300);
    expect(headerBlock(generators.oversizedHeader())).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    expect(count(generators.manyEncodedWords(), '=?utf-8?B?QUJD?=')).toBe(100_000);
    expect(count(generators.manyEncodedWordsUnderHeaderLimit(), '=?utf-8?B?QUJD?=')).toBe(50_000);
    expect(headerBlock(generators.manyEncodedWordsUnderHeaderLimit())).toBeLessThan(1_000_000);
    expect(headerBlock(generators.nodemailerGroupOpeners())).toBeLessThan(1_000_000);
    expect(count(generators.postalMimeBoundaryNearMiss(), '_NOMATCH\r\n')).toBe(16_000);
  });

  test('the LF variant of the signed shape has no CR', () => {
    expect(generators.pgpMimeSignedLf().includes(0x0d)).toBe(false);
  });
});
