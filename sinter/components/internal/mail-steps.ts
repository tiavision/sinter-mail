// The steps of a progressive render: <mail-body> renders the body's first part (`body.first`, from
// mail.progressive) in the task that receives the body; once the browser has painted it, this emits a `step` per
// task with the body further along (`upTo`: only the elements that step cuts are copies), then the body itself. The
// rows are keyed by the nodes' numbers, so each step renders the copied path and its new rows. A step's size follows
// the time the one before took, so that each fits in a frame whatever the device; between steps, input and paint go
// first.
import { upTo } from '../../tree.js';
import { MailStepsComponent } from './mail-steps.html';

/** script per step, ms: with style, layout and paint, a step fits in a frame (16 ms at 60 Hz) */
const BUDGET = 12;
/** nodes in the first step, before one has been timed */
const FIRST = 400;

/** a task after this one, without the 4 ms that nested timers wait: input and paint come first when they are due */
const next = (f: () => void) => { const c = new MessageChannel(); c.port1.onmessage = () => f(); c.port2.postMessage(0); };

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
    if (b.head! >= total) return void this.emit('step', b);
    // each step renders up to `upto`; the next one's size follows how long this one took, towards BUDGET
    const step = (upto: number, size: number) => {
      if (this.props.body !== b || !this.root.isConnected) return;
      const t0 = performance.now();
      this.emit('step', upto >= total ? b : upTo(b, upto));
      if (upto >= total) return;
      // the render runs in a microtask the event's state write queued: this one runs after it
      queueMicrotask(() => {
        const ms = performance.now() - t0;
        const n = Math.max(100, Math.min(size * 4, Math.round(size * BUDGET / Math.max(ms, 0.5))));
        next(() => step(upto + n, n));
      });
    };
    // the first step after the first part has painted: requestAnimationFrame runs before a paint, the task it posts after
    requestAnimationFrame(() => setTimeout(() => step(b.head! + FIRST, FIRST)));
  }
}
