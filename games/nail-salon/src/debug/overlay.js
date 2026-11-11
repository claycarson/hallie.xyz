// @ts-check
// Debug overlay (PLAN §14.2), shown with ?debug. "Copy report" copies everything as text so
// the iPad's numbers can be pasted back.

export class DebugOverlay {
  /** @param {() => string[]} getLines @param {{label: string, href: string}[]} [links] */
  constructor(getLines, links = []) {
    this.getLines = getLines;
    this.errors = [];
    this.frames = 0; this.fps = 0; this._t = performance.now();
    addEventListener('error', (e) => this._err(e.message));
    addEventListener('unhandledrejection', (e) => this._err(String(e.reason)));

    const el = this.el = document.createElement('div');
    el.id = 'debug';
    el.innerHTML = `<pre></pre><button type="button">Copy report</button><nav>${links.map((l) => `<a href="${l.href}">${l.label}</a>`).join('')}</nav>`;
    document.body.appendChild(el);
    this.pre = /** @type {HTMLElement} */ (el.querySelector('pre'));
    el.querySelector('button')?.addEventListener('click', () => navigator.clipboard?.writeText(this.report()).catch(() => {}));
    setInterval(() => { this.pre.textContent = this.report(); }, 250);
  }

  _err(msg) {
    this.errors.push(msg); if (this.errors.length > 20) this.errors.shift();
    try { localStorage.setItem('nailSalon.errors', JSON.stringify(this.errors)); } catch { /* storage may be off */ }
  }

  tick() {
    this.frames++;
    const now = performance.now();
    if (now - this._t >= 500) { this.fps = Math.round(this.frames * 1000 / (now - this._t)); this.frames = 0; this._t = now; }
  }

  report() {
    return [`fps ${this.fps}`, ...this.getLines(), ...this.errors.map((e) => `ERR ${e}`)].join('\n');
  }
}
