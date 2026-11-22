// The script of <mail-warm>: mail.parse and the builder run on a sample email, a slice per idle period, so
// their code is compiled (and its hot paths optimised) before the first real email. Nothing of it reaches the page.
import { build } from '../build.js';
import { parse } from '../parse.js';
import { MailWarmComponent } from './mail-warm.html';

const ROUNDS = 4;
/** an email as builders write them: a style sheet, nested layout tables, legacy attributes, inline styles, entities */
const sample = (k: number) => {
  const cell = (i: number) => `<td class="c" width="50%" valign="top" bgcolor="#f4f4f4" style="padding: 8px 12px; border: 1px solid #ddd; font-family: Arial, Helvetica, sans-serif"><p style="margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: #333333">Item ${i} &amp; more &mdash; text</p><a href="https://example.com/p/${i}?a=1&amp;b=${k}" style="color: #0066cc; text-decoration: underline">Read <b>more</b></a> <span style="font-size: 12px; color: rgb(102, 102, 102)">note ${i}</span><img src="https://example.com/i/${i}.png" width="20" height="20" alt="i"></td>`;
  const row = (i: number) => `<tr><td align="center" style="padding: 4px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>${cell(i)}${cell(i + 1)}</tr></table></td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body { margin: 0; background: #eeeeee; font-family: Arial, sans-serif } .c p { margin: 0 } table.w td > a:hover { color: red } @media (max-width: 600px) { .c { display: block !important; width: 100% !important } } h1, h2 { font-weight: bold; margin: 0 0 12px }</style></head><body><center><table class="w" width="600" align="center" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-collapse: collapse"><tr><td><h1 style="font-size: 22px">Title ${k}</h1><ul><li>one</li><li><i>two</i></li></ul></td></tr>${Array.from({ length: 24 }, (_, i) => row(i * 2)).join('')}</table><div style="font-size: 11px; color: #999">Footer<br>line</div></center></body></html>`;
};
const idle = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 200 }) : setTimeout(f, 0));

let started = false;
export class MailWarm extends MailWarmComponent {
  connected() {
    if (started) return;
    started = true;
    let k = 0;
    const step = () => { const b = parse(sample(k), { images: 'allow' }); build(b); this.emit('sample', b); if (++k < ROUNDS) idle(step); };
    idle(step);
  }
}
