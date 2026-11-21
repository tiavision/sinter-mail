// The library's own check (sinter's docs/libraries.md, "Checking a library"): `sinter check --strict` in
// this folder compiles and type-checks the fixture pages in fixtures/, which use the public component with
// the cases the library supports (a tree from a `file:` resource, both slots filled, a tree from an API, an
// email parsed for the width <mail-width> reports), and checks the library's rules: every declared slot is
// placed somewhere (SN331), `<sn-component use>` takes a map in a library with slots (SN312), internal
// components stay internal (SN339). The same rules are checked again in each app's build.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PKG } from './app.js';

test('the fixture pages check with no error and no warning', () => {
  const r = spawnSync(process.execPath, [join(PKG, 'node_modules/@tiaforge-ui/sinter/dist/cli.js'), 'check', '--strict'], { cwd: PKG, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  expect(out.split('\n').filter((l) => / (error|warning) SN\d+/.test(l))).toEqual([]);
  expect(out).toMatch(/sinter check --strict: 4 page\(s\), 0 error\(s\), 0 warning\(s\)/);
  expect(r.status).toBe(0);
}, 300_000);
