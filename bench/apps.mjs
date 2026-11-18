// The benchmark's apps: each a folder with a page, built with Vite and sinter as an app builds, served with
// an API that answers the message. A variant names its page, its sinter options and what the API sends.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

export const PKG = resolve(import.meta.dirname, '..');
/**
 * The two sinters a variant builds with: `base`, sinter's branch ccr-dc349183-ubeji7 as it is (a worktree at
 * ../sinter-base, or $SINTER_BASE), and `work`, the branch with this research's changes (../sinter, which this
 * package's node_modules links, or $SINTER_WORK). Both built (`npm ci && npm run build`).
 */
export const SINTERS = {
  base: resolve(process.env.SINTER_BASE ?? join(PKG, '../sinter-base')),
  work: resolve(process.env.SINTER_WORK ?? realpathSync(join(PKG, 'node_modules/@tiaforge-ui/sinter'))),
  /** a fixed build to compare `work` with while it changes: a worktree of sinter at the commit to compare with */
  ref: resolve(process.env.SINTER_REF ?? join(PKG, '../sinter-ref')),
};
const SINTER = SINTERS.base;

export const CSP = "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'";
/** Caley's own policy (backend/src/main.rs): no Trusted Types, and style-src 'unsafe-inline' for the iframe's email */
export const CALEY_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'";

export const page = (body, head = '') => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>bench</title>${head}</head>
<body>
${body}
</body>
</html>
`;

/**
 * A built app. `files`: the app's own files (index.html, src/...); `modules`: packages beside sinter and
 * sinter-mail to link into its node_modules; `sinter`: the plugin's options; `pkg`: the sinter-mail folder
 * to link (a prototype's copy). Returns { root, dist, js: { raw, gzip, files }, remove }.
 */
export async function buildApp(files, { options = {}, modules = [], pkg = PKG, sinter: which = 'base', minify = true, compileHints = false } = {}) {
  const sinterPkg = SINTERS[which] ?? which;
  const root = mkdtempSync(join(tmpdir(), 'sinter-mail-bench-'));
  const all = {
    'src/sinter.helpers.ts': "export * as mail from '@tiaforge-ui/sinter-mail';\n",
    'src/sinter.types.ts': "export type { Body, Element } from '@tiaforge-ui/sinter-mail';\nexport interface Message { html: string }\n",
    ...files,
  };
  for (const [f, s] of Object.entries(all)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), s);
  }
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(pkg, join(root, 'node_modules/@tiaforge-ui/sinter-mail'), 'dir');
  symlinkSync(sinterPkg, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  for (const m of modules) symlinkSync(realpathSync(join(PKG, 'node_modules', m)), join(root, 'node_modules', m), 'dir');
  const { default: sinter } = await import(join(sinterPkg, 'dist/vite.js'));
  const dist = join(root, 'dist');
  await build({
    root, configFile: false, logLevel: 'silent',
    // one sinter: the package's own imports of it (memo) resolve to the app's, the one chosen
    resolve: { dedupe: ['@tiaforge-ui/sinter'] },
    plugins: [sinter({ components: ['@tiaforge-ui/sinter-mail'], ...options })],
    build: { outDir: dist, emptyOutDir: true, minify },
  });
  // sinter's inline speculation rules (prefetch of the app's other pages) need 'inline-speculation-rules'
  // in script-src; the benchmark's pages have no other page, and keep the policy as the guarantees state it
  for (const f of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
    writeFileSync(join(dist, f), readFileSync(join(dist, f), 'utf8').replace(/<script type="speculationrules">[^<]*<\/script>/, ''));
  }
  // V8's explicit compile hints (Chromium 136+): `//# allFunctionsCalledOnLoad` as a file's first line
  // compiles all of it eagerly, on the streaming thread, instead of each function on its first call
  if (compileHints && existsSync(join(dist, 'assets'))) {
    for (const f of readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'))) {
      writeFileSync(join(dist, 'assets', f), '//# allFunctionsCalledOnLoad\n' + readFileSync(join(dist, 'assets', f), 'utf8'));
    }
  }
  const assets = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')) : [];
  const sizes = assets.map((f) => { const b = readFileSync(join(dist, 'assets', f)); return { file: f, raw: b.length, gzip: gzipSync(b, { level: 9 }).length }; });
  return {
    root, dist,
    js: { files: sizes, raw: sizes.reduce((n, s) => n + s.raw, 0), gzip: sizes.reduce((n, s) => n + s.gzip, 0) },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** serves a build: `/api/message?n=` answers `api(n)` (a JSON string); every HTML page gets the `csp` header */
export function serve(dist, api, csp = CSP) {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(api(Number(url.searchParams.get('n') ?? 1))); }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const body = readFileSync(join(dist, path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      if (path.endsWith('.html') && csp) res.setHeader('Content-Security-Policy', csp);
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() })));
}
