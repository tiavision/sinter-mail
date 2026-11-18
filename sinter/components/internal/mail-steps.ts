// The steps of a progressive render: <mail-body> renders the body's first part (`body.first`, from
// mail.progressive) in the task that receives the body; once the browser has painted it, this emits a `step` per
// task with the body up to STEP nodes further (`upTo`: only the elements that step cuts are copies), then the body
// itself. The rows are keyed by the nodes' numbers, so each step renders the copied path and its new rows.
import { upTo } from '../../tree.js';
import { MailStepsComponent } from './mail-steps.html';

/** nodes per step: about 10 to 16 ms on a desktop for a newsletter's tables */
const STEP = 400;

export class MailSteps extends MailStepsComponent {
  #of: unknown = undefined;
  connected() { this.#start(); }
  propsChanged() { this.#start(); }
  #start() {
    const b = this.props.body;
    if (b === this.#of) return;
    this.#of = b;
    // in this render (the event writes <mail-body>'s state before the browser paints): the first part
    this.emit('step', b.first ?? upTo(b, b.head!));
    const last = b.children.at(-1), total = last ? (last.type === 'element' ? last.z! : last.n!) + 1 : 0;
    const step = (upto: number) => setTimeout(() => {
      if (this.props.body !== b || !this.root.isConnected) return;
      this.emit('step', upto >= total ? b : upTo(b, upto));
      if (upto < total) step(upto + STEP);
    });
    // after the next frame: requestAnimationFrame runs before its paint, the task it posts after it
    if (b.head! < total) requestAnimationFrame(() => step(b.head! + STEP));
    else this.emit('step', b);
  }
}
