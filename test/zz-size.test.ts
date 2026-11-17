import { cpSync, rmSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { build } from 'vite';
import { test } from 'vitest';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page } from './app.js';
test('size', async () => {
  const a = app({ 'index.html': page('<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-prop="{ body: message }"></mail-body></main>') });
  if (process.env.PKGDIR) { rmSync(join(a.root, 'node_modules/@tiaforge-ui/sinter-mail')); symlinkSync(process.env.PKGDIR, join(a.root, 'node_modules/@tiaforge-ui/sinter-mail'), 'dir'); }
  await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ components: ['@tiaforge-ui/sinter-mail'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
  const d = join(a.root, 'dist/assets'); const fs = readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(d, f)));
  console.log('SIZE raw', fs.reduce((n, b) => n + b.length, 0), 'gzip', fs.reduce((n, b) => n + gzipSync(b, { level: 9 }).length, 0));
  a.remove();
}, 300000);
