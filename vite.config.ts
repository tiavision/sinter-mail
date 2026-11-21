// The library's own config, for `sinter check` over its fixture pages (fixtures/*.html) and for the
// tests that build them. Sinter reads the fixture pages' modules by their fixed names, as an app's:
// fixtures/sinter.helpers.ts re-exports the package as `mail`, fixtures/sinter.types.ts names the
// tree's types.
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter()],
});
