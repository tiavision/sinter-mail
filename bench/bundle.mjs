// Bundles a module of the package for Node or for size, with the same Vite (Rolldown + its minifier) an app
// builds with: `bundle(entry, { minify })` returns { code, gzip, path } of one ES module with every import
// inlined (the package's self-import `@tiaforge-ui/sinter-mail/parser` resolves through its exports).
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

export const PKG = resolve(import.meta.dirname, '..');
export const gz = (b) => gzipSync(b, { level: 9 }).length;

/** one ES module of `entry` (a path in the package, or code given as `code`) and all it imports */
export async function bundle(entry, { minify = true, code, external = [], define } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'sinter-mail-bundle-'));
  let input = entry && resolve(PKG, entry);
  if (code !== undefined) { input = join(PKG, `.bench-entry-${process.pid}-${Math.random().toString(36).slice(2)}.ts`); writeFileSync(input, code); }
  try {
    await build({
      root: PKG, configFile: false, logLevel: 'silent', define,
      build: {
        outDir: out, emptyOutDir: true, minify, target: 'es2023',
        lib: { entry: input, formats: ['es'], fileName: 'out' },
        rollupOptions: { external },
      },
    });
  } finally {
    if (code !== undefined) (await import('node:fs')).rmSync(input, { force: true });
  }
  const file = readdirSync(out).find((f) => f.endsWith('.js'));
  const path = join(out, file);
  const text = readFileSync(path);
  return { path, code: text.toString(), bytes: text.length, gzip: gz(text) };
}
