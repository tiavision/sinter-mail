// Caley's <mail-frame> script before it moved to sinter-mail (frontend/src/components/mail-frame.ts at bb53e0f^),
// unchanged, for bench/html.mjs.
// The script of <mail-frame>: owns the iframe of an HTML mail body (a foreign document) and sizes it.
import { MailFrameComponent } from './mail-frame.html';

const overlayQuery = '(max-width: 1023px)';

export class MailFrame extends MailFrameComponent {
  #frame: HTMLIFrameElement | null = null;
  #shown = '';
  #observer: ResizeObserver | null = null;
  #media = window.matchMedia(overlayQuery);
  #onMedia = () => this.#fit();

  connected() {
    this.#media.addEventListener('change', this.#onMedia);
    this.#render();
  }

  propsChanged() { this.#render(); }

  disconnected() {
    this.#media.removeEventListener('change', this.#onMedia);
    this.#observer?.disconnect();
  }

  #render() {
    const { html, isolated, label } = this.props;
    const version = this.props.version ?? 0, height = this.props.height ?? '';
    const shown = `${version}|${isolated}|${height}|${html}`;
    if (this.#frame && shown === this.#shown) {
      this.#frame.title = label;
      return;
    }
    this.#shown = shown;
    this.#observer?.disconnect();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', isolated
      ? 'allow-popups allow-popups-to-escape-sandbox'
      : 'allow-popups allow-same-origin allow-popups-to-escape-sandbox');
    frame.title = label;
    if (height) frame.style.height = height;
    frame.srcdoc = html;
    frame.addEventListener('load', () => this.#fit());
    this.#frame?.remove();
    this.#frame = frame;
    this.root.append(frame);
  }

  #fit() {
    const frame = this.#frame;
    if (!frame || this.props.height) return;
    this.#observer?.disconnect();
    if (!this.#media.matches) {
      frame.style.height = '';
      frame.style.width = '';
      frame.removeAttribute('scrolling');
      return;
    }
    if (!this.props.isolated) frame.setAttribute('scrolling', 'no');
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      // The frame cannot scroll here. It fills the rest of the reader from the start (mail.scss), so it does not jump
      // when the mail has loaded, and grows past that to the mail's width (a wide mail then scrolls sideways in
      // <mail-frame>) and height. Inside, the mail is measured at least as large as the frame, so it only ever grows:
      // a content change (an image loading) keeps the reader's scroll position. A new reader width (rotation) starts
      // over from the filled size.
      let hostWidth = -1;
      const setSize = () => {
        if (this.root.clientWidth !== hostWidth) {
          hostWidth = this.root.clientWidth;
          frame.style.width = '';
          frame.style.height = '';
        }
        const root = doc.documentElement;
        const w = Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0);
        if (w > frame.clientWidth) frame.style.width = `${w}px`;
        const h = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0);
        if (h > frame.clientHeight) frame.style.height = `${h}px`;
      };
      setSize();
      this.#observer = new ResizeObserver(setSize);
      this.#observer.observe(this.root);
      this.#observer.observe(doc.documentElement);
      if (doc.body) this.#observer.observe(doc.body);
    } catch { /* an isolated frame is cross-origin and cannot be measured */ }
  }
}
