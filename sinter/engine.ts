// What mail.parse runs: the HTML parser and the cascade, behind one specifier of the package's own
// (`@tiavision/sinter-mail/parser`). An app that lists this package in `sinter({ lazy })` makes both load
// when a let first needs mail.parse; lazy packages are matched by import specifier, so parse.ts imports
// them by that name and never by a relative path.
export { parseHTML } from './parser/index.js';
export { resolveStyles } from './css/index.js';
