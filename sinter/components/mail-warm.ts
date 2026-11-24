// The script of <mail-warm>: mail.parse and the builder run on sample emails (../warm.ts), one per idle period, so
// their code is compiled, and its hot paths optimised, before the first real email: V8 compiles a function at its
// first call and runs it in its interpreter until it has seen enough of it, which makes the first email of a session
// three to four times as slow to parse as a later one. Nothing of it reaches the page.
import { build } from '../build.js';
import { parseOnce } from '../parse.js';
import { sample } from '../warm.js';
import { MailWarmComponent } from './mail-warm.html';

// Measured on the corpus of bench/html.mjs: the first parse is at a later one's speed after about 24 samples, and no
// faster after 36. The first of them are small: a first run costs by the code it compiles, not by the email's length,
// and an idle period should not run 40 ms of it at once.
const ROUNDS = 24, SMALL = 3;
const idle = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 200 }) : setTimeout(f, 0));

let started = false;
export class MailWarm extends MailWarmComponent {
  connected() {
    if (started) return;
    started = true;
    let k = 0;
    const step = () => {
      // not kept: mail.parse's cache is for the emails the reader opens
      const b = parseOnce(sample(k, k < SMALL ? 2 : 8), { images: 'proxy', proxy: '/?{url}', cid: '/?{cid}' });
      build(b);
      this.emit('sample', b);
      if (++k < ROUNDS) idle(step);
    };
    idle(step);
  }
}
