// @ts-check
// Brush sound (PLAN §12): filtered noise that follows stroke speed, drier as the brush runs
// low. Ported from the v2 mockup. Everything goes through one master gain.

export class BrushSound {
  constructor() { this.ac = null; this.muted = false; }

  /** Call from a pointerdown: iOS only starts audio inside a user gesture. */
  wake() {
    if (this.muted) return;
    if (!this.ac) this._build();
    if (this.ac && this.ac.state !== 'running') this.ac.resume().catch(() => {});
  }

  _build() {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    const ac = this.ac = new AC();
    const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;                       // soft pink-ish noise
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    this.bp = ac.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.frequency.value = 2400; this.bp.Q.value = 0.8;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500;
    this.gain = ac.createGain(); this.gain.gain.value = 0;
    this.master = ac.createGain(); this.master.gain.value = 1;
    src.connect(hp).connect(this.bp).connect(lp).connect(this.gain).connect(this.master).connect(ac.destination);
    src.start();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.wake(); });
  }

  /** Every frame: speed in nail widths per second (0 when the brush is up), load 0…1. */
  update(speed, load) {
    if (!this.ac || !this.gain || !this.bp) return;
    const t = this.ac.currentTime, v = Math.min(1, speed / 5);
    this.gain.gain.setTargetAtTime(this.muted ? 0 : v * 0.32, t, v > 0 ? 0.04 : 0.08);
    // A loaded brush is duller and wetter; a dry one is brighter and scratchier.
    this.bp.frequency.setTargetAtTime(1500 + v * 2400 + (1 - load) * 900, t, 0.05);
  }
}
