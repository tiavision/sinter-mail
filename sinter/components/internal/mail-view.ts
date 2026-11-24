// The script of <mail-view>, <mail-body>'s renderer for a body that arrives at run time: the body's tree as
// elements, created directly (../../build.ts), about seven times faster than through the generated components. A new
// body replaces the one before, whole.
import { build } from '../../build.js';
import type { Body } from '../../sinter.types.js';
import { MailViewComponent } from './mail-view.html';

export class MailView extends MailViewComponent {
  #of: Body | null | undefined = undefined;
  connected() { this.#render(); }
  propsChanged() { this.#render(); }
  #render() {
    const b = this.props.body ?? null;
    if (b === this.#of) return;
    this.#of = b;
    // the email goes in the root's <div class="mail-box"> (mail-view.html), which clips it
    const box = this.root.firstElementChild!;
    if (b) box.replaceChildren(build(b)); else box.replaceChildren();
  }
}
