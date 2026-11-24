// <mail-warm>'s sample emails (sinter/warm.ts): what makes them warm the parser is what they hold, so this keeps it
// there: three dialects by turns, each a tree of some size with many distinct styles, and the parts of mail.parse an
// ordinary sample would not reach (quoted history, a dark scheme, cid: and proxied images, in-email entities).
import { expect, test } from 'vitest';
import { parse } from '../sinter/parse.js';
import { sample } from '../sinter/warm.js';
import type { Body, Element } from '../sinter/sinter.types.js';
import { elements } from './app.js';

const all = (b: Body): Element[] => b.children.flatMap((c) => [...elements(c)]);
const styles = (b: Body) => new Set(all(b).map((e) => JSON.stringify(e.style))).size;
const OPTIONS = { images: 'proxy', proxy: '/img?u={url}', cid: '/cid?id={cid}' } as const;

test('the three dialects: a builder newsletter, an Outlook thread, a Gmail reply', () => {
  const [builder, outlook, reply] = [0, 1, 2].map((k) => parse(sample(k), OPTIONS));
  for (const b of [builder!, outlook!, reply!]) {
    expect(all(b).length).toBeGreaterThan(250);
    expect(styles(b)).toBeGreaterThan(50);
    expect(all(b).some((e) => e.tag === 'a' && e.attrs.href?.startsWith('https://'))).toBe(true);
  }
  // the newsletter's style sheet: a dark scheme, @media, its images through the proxy, the pixel left out
  expect(builder!.schemes).toEqual(['dark']);
  expect(JSON.stringify(builder)).toContain('light-dark(');
  expect(all(builder!).filter((e) => e.tag === 'img').every((e) => e.attrs.src?.startsWith('/img?u=https%3A%2F%2Fimg.example.com'))).toBe(true);
  expect(builder!.images.origins).toEqual(['https://img.example.com']);
  // Outlook: its header block starts the quoted history; Word's classes resolved (pt as written)
  expect(outlook!.quotes).toBe(true);
  expect(all(outlook!).some((e) => e.tag === 'p' && e.style['font-size'] === '11pt')).toBe(true);
  // Gmail: nested quotes, the signature, legacy attributes, a cid: image
  expect(all(reply!).filter((e) => e.part === 'quote').length).toBeGreaterThan(3);
  expect(all(reply!).some((e) => e.part === 'signature')).toBe(true);
  expect(all(reply!).some((e) => e.tag === 'img' && e.attrs.src?.startsWith('/cid?id=logo'))).toBe(true);
  expect(all(reply!).some((e) => e.tag === 'font' && e.style['font-family'] !== undefined)).toBe(true);
});

test('each round is another email, the same for the same round; the first are small', () => {
  expect(sample(4)).toBe(sample(4));
  expect(sample(3)).not.toBe(sample(0));
  expect(sample(0, 2).length).toBeLessThan(sample(0).length / 2);
  for (let k = 0; k < 6; k++) expect(all(parse(sample(k, 2), OPTIONS)).length).toBeGreaterThan(40);
});
