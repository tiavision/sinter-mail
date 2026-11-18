// PROTOTYPE (progressive rendering): a body that mail.progressive numbered (`body.head`) renders its first
// nodes in the task that receives it; once the browser has painted them, the rest renders (in one task, or STEP
// nodes per task). The rows already rendered are kept (the tree's objects are the same, and
// rows match by item), and only the elements a step's limit cuts through render again.
import { MailBodyComponent } from './mail-body.html';

/**
 * nodes per task after the first paint: by default all of them, in one task (two phases). `?step=400` in the
 * page URL steps instead, for measuring: each step re-renders every list already rendered (they all read
 * the limit), so stepping costs about 3 times the total (docs/proposals/progressive-rendering.md).
 */
const STEP = +(new URLSearchParams(location.search).get('step') ?? Infinity);

export class MailBody extends MailBodyComponent {
  connected() { this.#later(); }
  propsChanged() { this.#later(); }
  #later() {
    const b = this.props.body;
    if (!b?.head || this.state.of === b) return;
    const last = b.children.at(-1), total = last ? (last.type === 'element' ? last.z! : last.n!) + 1 : 0;
    const step = (upto: number) => setTimeout(() => {
      if (this.props.body !== b) return;
      this.state.of = b;
      this.state.upto = upto >= total ? 1e9 : upto;
      if (upto < total) step(upto + STEP);
    });
    // after the next frame: requestAnimationFrame runs before its paint, the task it posts after it
    requestAnimationFrame(() => step(b.head! + STEP));
  }
}
