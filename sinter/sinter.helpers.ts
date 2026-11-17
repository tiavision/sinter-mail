// The library's helpers, in three modules under one namespace. An app re-exports the package as a
// namespace (`export * as mail from '@tiaforge-ui/sinter-mail'` in its src/sinter.helpers.ts) and calls
// `mail.parse`, `mail.plain`, `mail.text` and `mail.links` in markup.
//
// - parse.ts imports the parser (`@tiaforge-ui/sinter-mail/parser`). An app that lists this package in
//   `sinter({ lazy })` makes it load when a let first needs it; the let waits for it.
// - plain.ts and tree.ts import no parser, so `mail.plain`, `mail.text` and `mail.links` stay ordinary
//   helpers either way: they render early and fold at build time.
export { parse } from './parse.js';
export { plain } from './plain.js';
export { text, links } from './tree.js';
