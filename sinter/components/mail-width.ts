// The script of <mail-width>: the `media` of mail.parse that fits the box it is in, as an event when it changes.
import { MailWidthComponent } from './mail-width.html';

/** below this width an email's @media rules are evaluated for a phone: mobile layouts are written for 480–640 px */
const BREAKPOINT = 640;

export class MailWidth extends MailWidthComponent {
  #media: 'wide' | 'narrow' | null = null;
  #observer: ResizeObserver | null = null;

  connected() {
    this.#observer = new ResizeObserver(() => this.#measure());
    this.#observer.observe(this.root);
    this.#measure();
  }

  disconnected() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  propsChanged() {
    this.#measure();
  }

  #measure() {
    const width = this.root.clientWidth;
    // not laid out (a hidden reader, display: none around it): nothing to say until it is
    if (width === 0) return;
    const media = width < (this.props.breakpoint ?? BREAKPOINT) ? 'narrow' : 'wide';
    if (media === this.#media) return;
    this.#media = media;
    this.emit('media', media);
  }
}
