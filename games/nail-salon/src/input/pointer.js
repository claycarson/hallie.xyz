// @ts-check
// Pointer and Pencil input (PLAN §5). Real events and the robot painter's synthetic samples
// go through the same `handle()`.
//
// A sample is { clientX, clientY, pointerType, timeStamp, altitudeAngle?, tiltX?, tiltY? }.
// `pressure` is never read: the USB-C Pencil reports a constant.

export class PointerInput {
  /**
   * @param {HTMLElement} el
   * @param {object} o
   * @param {(cx: number, cy: number, out: {x: number, y: number}) => boolean} o.toPaint client → paint coords
   * @param {import('../paint/stroke.js').StrokeEngine} o.engine
   * @param {number} o.palmSeconds touches don't paint this long after a pen was seen
   * @param {() => boolean} [o.blocked] no stroke may start while this is true (the hand is turning)
   * @param {(cx: number, cy: number, x: number, y: number, altitude: number | null, azimuth: number | null, touching: boolean) => void} [o.onCursor] where the Pencil is, for the brush model only
   * @param {() => void} [o.onStrokeStart]
   * @param {() => void} [o.onStrokeEnd]
   */
  constructor(el, o) {
    this.o = o;
    this.mode = 'auto';             // auto | pen | finger (Grown-ups "Paint with")
    this.lastPenAt = -Infinity;
    this.activeId = null;
    this.info = { type: '-', altitude: null, azimuth: null, coalesced: 0, predicted: 0, hover: false };
    this._p = { x: 0, y: 0 };
    this._c = { x: 0, y: 0 };

    const stop = (e) => e.preventDefault();
    for (const type of ['contextmenu', 'selectstart', 'gesturestart']) document.addEventListener(type, stop);
    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture?.(e.pointerId); } catch { /* the pointer can already be gone */ }
      this._event('down', e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons === 0 && e.pointerType !== 'touch') {         // no contact: the brush floats above the nail
        if (e.pointerType === 'pen') { this.info.hover = true; this.lastPenAt = e.timeStamp; }
        this.cursor(e, false);
        return;
      }
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length) { this.info.coalesced = list.length; for (const c of list) this._event('move', c, e.pointerId); }
      else this._event('move', e);
      if (e.pointerId === this.activeId && e.getPredictedEvents) {      // the brush only: predicted samples never paint
        const p = e.getPredictedEvents();
        if (p.length) { this.info.predicted = p.length; this.cursor(p[p.length - 1], true); }
      }
    });
    for (const type of ['pointerup', 'pointercancel']) el.addEventListener(type, (e) => this._event('up', e));
  }

  _event(kind, e, id = e.pointerId) {
    if (kind !== 'down' && id !== this.activeId) return;
    if (kind === 'down') { if (this.activeId !== null) return; }
    this.handle(kind, e);
    if (kind === 'down') this.activeId = this.o.engine.down ? id : null;
    if (kind === 'up') this.activeId = null;
  }

  /** Tell the brush model where the Pencil is. Never touches the stroke engine. */
  cursor(s, touching) {
    if (!this.o.onCursor || !this.o.toPaint(s.clientX, s.clientY, this._c)) return;
    this.o.onCursor(s.clientX, s.clientY, this._c.x, this._c.y, this._alt(s, s.pointerType), s.azimuthAngle ?? null, touching);
  }

  /** Altitude of a pen sample in radians, or null for finger and mouse. */
  _alt(s, type) {
    if (type !== 'pen') return null;
    if (typeof s.altitudeAngle === 'number') return s.altitudeAngle;
    if (typeof s.tiltX !== 'number') return null;
    const tx = s.tiltX * Math.PI / 180, ty = s.tiltY * Math.PI / 180;
    return Math.atan(1 / Math.hypot(Math.tan(tx), Math.tan(ty)));
  }

  /** May this pointer paint right now? Pen always; touch not within palmSeconds of a pen. */
  canPaint(type, timeMs) {
    if (type === 'pen') return true;
    if (this.mode === 'pen') return type === 'mouse';
    if (type === 'touch' && this.mode === 'auto') return timeMs - this.lastPenAt > this.o.palmSeconds * 1000;
    return true;
  }

  /** @param {'down'|'move'|'up'} kind */
  handle(kind, s) {
    const { engine, toPaint } = this.o, t = s.timeStamp, type = s.pointerType || 'mouse';
    if (kind === 'up') { if (engine.down) { engine.end(); this.o.onStrokeEnd?.(); } return; }
    if (kind === 'down' && (this.o.blocked?.() || !this.canPaint(type, t))) return;
    if (type === 'pen') this.lastPenAt = t;
    if (kind === 'move' && !engine.down) return;

    const altitude = this._alt(s, type);
    if (type === 'pen') { this.info.altitude = altitude; this.info.azimuth = s.azimuthAngle ?? null; }
    this.info.type = type;
    if (!toPaint(s.clientX, s.clientY, this._p)) { if (engine.down) { engine.end(); this.o.onStrokeEnd?.(); } return; }
    const w = engine.tiltFactor(altitude);
    if (kind === 'down') { engine.begin(this._p.x, this._p.y, t, w); this.o.onStrokeStart?.(); }
    else engine.move(this._p.x, this._p.y, t, w);
    this.o.onCursor?.(s.clientX, s.clientY, this._p.x, this._p.y, altitude, s.azimuthAngle ?? null, true);
  }
}
