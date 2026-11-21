// The library's helpers, in three modules under one namespace. An app re-exports the package as a
// namespace (`export * as mail from '@tiavision/sinter-mail'` in its src/sinter.helpers.ts) and calls
// `mail.parse`, `mail.plain`, `mail.text`, `mail.links`, `mail.progressive` and `mail.unquoted` in markup.
//
// - parse.ts imports the parser (`@tiavision/sinter-mail/parser`). An app that lists this package in
//   `sinter({ lazy })` makes it load when a let first needs it; the let waits for it.
// - plain.ts and tree.ts import no parser, so `mail.plain` and tree.ts's helpers stay ordinary
//   helpers either way: they render early and fold at build time.
export { parse } from './parse.js';
export { plain } from './plain.js';
export { text, links, progressive, unquoted } from './tree.js';
