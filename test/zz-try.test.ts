import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { test } from 'vitest';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page, PKG } from './app.js';
test('x', async () => {
  const a = app({ 'src/sinter.helpers.ts': 'export const x = 1;\n', 'tree.json': readFileSync(join(PKG, 'fixtures/trees/all.json')), 'index.html': page(`<sn-resource name="mail" src="file:./tree.json" type="Body"></sn-resource>\n<main><mail-body id="message" data-sn-prop="{ body: mail }"></mail-body></main>`) });
  try {
    await build({ root: a.root, logLevel: 'info', plugins: [sinter({ components: ['@tiaforge-ui/sinter-mail'], static: ['index.html'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
  } catch (e) { console.log('ERR', (e as Error).message.slice(0, 3000)); }
  const d = join(a.root, 'dist');
  writeFileSync('/tmp/claude-0/-home-user/1f29fc5c-ff0f-5558-90f8-0f04d991082f/scratchpad/comp/assets.txt', String(existsSync(d) ? readdirSync(d, { recursive: true }) : 'no dist'));
  if (existsSync(join(d, 'index.html'))) writeFileSync('/tmp/claude-0/-home-user/1f29fc5c-ff0f-5558-90f8-0f04d991082f/scratchpad/comp/static.html', readFileSync(join(d, 'index.html')));
  /* keep */ writeFileSync('/tmp/claude-0/-home-user/1f29fc5c-ff0f-5558-90f8-0f04d991082f/scratchpad/comp/root.txt', a.root);
}, 300000);
