// @ts-check
// Pointer and Pencil input (PLAN §5). Real events and the robot painter's synthetic samples
// go through the same `handle()`.
//
// A sample is { clientX, clientY, pointerType, timeStamp, altitudeAngle?, tiltX?, tiltY? }.
// `pressure` is never read: the USB-C Pencil reports a constant.

/** The fields of a sample we keep. A real PointerEvent's fields are getters, so never spread one. */
const copySample = (s) => ({ clientX: s.clientX, clientY: s.clientY, pointerType: s.pointerType, timeStamp: s.timeStamp, width: s.width, height: s.height });

export class PointerInput {
  /**
   * @param {HTMLElement} el
   * @param {object} o
   * @param {(cx: number, cy: number, out: {x: number, y: number}) => boolean} o.toPaint client → paint coords
   * @param {import('../paint/stroke.js').StrokeEngine} o.engine
   * @param {number} o.palmSeconds touches don't paint this long after a pen was seen
   * @param {number} [o.touchDelayMs] a touch paints only once it has moved this long with no pen about
   * @param {number} [o.tapMs] a touch that lifts before this without moving still paints (a dab)
   * @param {number} [o.palmSizePx] a touch contact wider than this is a palm, never a finger
   * @param {() => boolean} [o.blocked] no stroke may start while this is true (the hand is turning)
   * @param {(cx: number, cy: number) => boolean} [o.offHand] true where a press is on empty
   *   background: it starts a swipe between nails, never a stroke
   * @param {(cx: number, cy: number, x: number, y: number, altitude: number | null, azimuth: number | null, touching: boolean) => void} [o.onCursor] where the Pencil is, for the brush model only
   * @param {() => void} [o.onStrokeStart]
   * @param {() => void} [o.onStrokeEnd]
   */
  constructor(el, o) {
    this.o = o;
    this.mode = 'auto';             // auto | pen | finger (Grown-ups "Paint with")
    this.lastPenAt = -Infinity;
    this.activeId = null;
    this.activeType = null;
    /** A touch waiting to show it is a finger, not a palm: its samples so far. */
    this.pending = null;
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
    // One contact paints at a time, but the Pencil always takes over from a touch: a palm that
    // landed first used to hold the stroke and lock the Pencil out.
    if (kind === 'down' && this.activeId !== null && !(e.pointerType === 'pen' && this.activeType !== 'pen')) return;
    this.handle(kind, e);
    if (kind === 'down') {
      const live = this.o.engine.down || this.pending;
      this.activeId = live ? id : null; this.activeType = live ? e.pointerType : null;
    }
    if (kind === 'up') { this.activeId = null; this.activeType = null; }
  }

  /** A contact too big for a fingertip. Only real touches report a size. */
  _palmSized(s) {
    const max = this.o.palmSizePx ?? 40;
    return (s.width ?? 0) > max || (s.height ?? 0) > max;
  }

  /**
   * May a touch press a button or swipe right now? Not a palm's: not palm-sized, and not while
   * the Pencil is in use (within `pressPalmMs` of a pen sample). Unlike painting, a finger
   * tapping an arrow a moment after the Pencil lifts is the normal case.
   */
  touchMayPress(e) {
    if (e.pointerType !== 'touch') return true;
    return !this._palmSized(e) && e.timeStamp - this.lastPenAt > (this.o.pressPalmMs ?? 800);
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

  /**
   * Palm rejection, then paint. A touch is held back until it has moved for `touchDelayMs` with
   * no pen about (a resting palm never paints); a short tap still dabs on lift. A pen sample
   * drops a held touch and ends a touch stroke.
   * @param {'down'|'move'|'up'} kind
   */
  handle(kind, s) {
    const { engine } = this.o, t = s.timeStamp, type = s.pointerType || 'mouse';
    const penNear = () => t - this.lastPenAt <= this.o.palmSeconds * 1000;
    if (kind === 'up') {
      const p = this.pending; this.pending = null;
      if (p && !penNear() && t - p.samples[0].timeStamp <= (this.o.tapMs ?? 250)) this._replay(p);
      this._end();
      return;
    }
    if (type === 'pen') {
      this.lastPenAt = t; this.pending = null;
      if (kind === 'down' && engine.down && this.strokeType !== 'pen') this._end();
    }
    if (kind === 'down') {
      if (this.o.blocked?.() || !this.canPaint(type, t) || this.o.offHand?.(s.clientX, s.clientY)) return;
      if (type === 'touch') {
        if (!this._palmSized(s)) this.pending = { samples: [copySample(s)] };
        return;
      }
    }
    if (kind === 'move' && this.pending) {
      if (penNear() || this._palmSized(s)) { this.pending = null; return; }
      this.pending.samples.push(copySample(s));
      if (t - this.pending.samples[0].timeStamp < (this.o.touchDelayMs ?? 120)) return;
      const p = this.pending; this.pending = null;
      this._replay(p);
      return;
    }
    this._paint(kind, s);
  }

  _replay(p) { p.samples.forEach((q, i) => this._paint(i ? 'move' : 'down', q)); }

  _end() { if (this.o.engine.down) { this.o.engine.end(); this.o.onStrokeEnd?.(); } this.strokeType = null; }

  /** Lay paint for one sample that has passed palm rejection. */
  _paint(kind, s) {
    const { engine, toPaint } = this.o, t = s.timeStamp, type = s.pointerType || 'mouse';
    if (kind === 'move' && !engine.down) return;

    const altitude = this._alt(s, type);
    if (type === 'pen') { this.info.altitude = altitude; this.info.azimuth = s.azimuthAngle ?? null; }
    this.info.type = type;
    if (!toPaint(s.clientX, s.clientY, this._p)) { this._end(); return; }
    const w = engine.tiltFactor(altitude);
    if (kind === 'down') { engine.begin(this._p.x, this._p.y, t, w); this.strokeType = type; this.o.onStrokeStart?.(); }
    else engine.move(this._p.x, this._p.y, t, w);
    this.o.onCursor?.(s.clientX, s.clientY, this._p.x, this._p.y, altitude, s.azimuthAngle ?? null, true);
  }
}
