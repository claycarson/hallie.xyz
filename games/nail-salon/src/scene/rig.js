// @ts-check
import * as THREE from 'three';

// The camera (PLAN §6): hand view or one nail, fingertips down (t = 0) or up (t = 1).
// The turn is a half circle of the camera about the view's own axis, so the nail or the hand
// spins in place on screen. Paint lives in the nail's frame, so a turn cannot change it.
// Changing view or nail glides (`glideMs`, eased) from wherever the camera was.

const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;
const RAD = Math.PI / 180;

export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {any} data data/camera.json
   * @param {number} finger the active finger, 0–4
   * @param {'nail'|'hand'} view
   * @param {boolean} up start fingertips-up
   */
  constructor(camera, data, finger, view, up) {
    this.camera = camera; this.data = data; this.finger = finger; this.view = view;
    this.t = up ? 1 : 0;
    this.anim = /** @type {{from: number, to: number, start: number} | null} */ (null);
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
    /** Where a glide started: camera position, look-at point and up. */
    this.glide = /** @type {{pos: THREE.Vector3, tgt: THREE.Vector3, up: THREE.Vector3, start: number, k: number} | null} */ (null);
    this.lookAt = new THREE.Vector3();
  }

  get gliding() { return this.glide !== null; }
  /** Busy: turning or gliding. Nothing may start a stroke. */
  get moving() { return this.anim !== null || this.glide !== null; }

  /** Glide to a view (and, for 'nail', a finger). The caller re-points `apply` at that finger. */
  goTo(view, finger, now) {
    const c = this.camera;
    this.glide = { pos: c.position.clone(), tgt: this.lookAt.clone(), up: c.up.clone(), start: now, k: 0 };
    this.view = view; this.finger = finger;
  }

  get up() { return (this.anim ? this.anim.to : this.t) > 0.5; }
  get turning() { return this.anim !== null; }

  /** One finger's nail framing for a direction: the defaults, then that finger's own numbers. */
  framing(dir) { return { ...this.data.nail, ...this.data.fingers[dir][this.finger] }; }

  /** Jump to a direction with no animation. */
  set(up) { this.anim = null; this.t = up ? 1 : 0; }

  /** Start a turn. Returns false if one is already running. */
  turn(now) {
    if (this.anim) return false;
    this.anim = { from: this.t, to: this.t > 0.5 ? 0 : 1, start: now };
    return true;
  }

  /** Advance the turn. Returns true if the camera moved. */
  update(now) {
    if (this.glide) {
      this.glide.k = Math.min(1, (now - this.glide.start) / this.data.glideMs);
      if (this.glide.k >= 1) { this.glide = null; return true; }
    }
    if (!this.anim) return this.glide !== null;
    const k = Math.min(1, (now - this.anim.start) / this.data.turnMs);
    this.t = mix(this.anim.from, this.anim.to, k);
    if (k >= 1) this.anim = null;
    return true;
  }

  /**
   * Place the camera.
   * @param {THREE.Matrix4} frameToWorld the active nail's paint frame
   * @param {number} length the nail's length in nail widths
   */
  apply(frameToWorld, length) {
    const e = ease(this.t), spin = Math.PI * e, { camera, _a: pos, _b: tgt, _c: up } = this;
    if (this.view === 'hand') {
      const a = this.data.hand.down, b = this.data.hand.up;
      const pitch = mix(a.pitch, b.pitch, e) * RAD, yaw = mix(a.yaw, b.yaw, e) * RAD + spin, d = mix(a.distance, b.distance, e);
      tgt.set(mix(a.target[0], b.target[0], e), mix(a.target[1], b.target[1], e), mix(a.target[2], b.target[2], e));
      pos.set(Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)).multiplyScalar(d).add(tgt);
      camera.position.copy(pos); camera.up.set(0, 0, 1); camera.lookAt(tgt);
    } else {
      const a = this.framing('down'), b = this.framing('up');
      const x = mix(a.x, b.x, e), y = mix(a.centre, b.centre, e) * length, roll = spin + mix(a.roll, b.roll, e) * RAD;
      pos.set(x, y, mix(a.distance, b.distance, e)).applyMatrix4(frameToWorld);
      tgt.set(x, y, 0).applyMatrix4(frameToWorld);
      up.set(Math.sin(roll), -Math.cos(roll), 0).transformDirection(frameToWorld);
      camera.position.copy(pos); camera.up.copy(up); camera.lookAt(tgt);
    }
    if (this.glide) {                        // blend from where the glide started
      const g = this.glide, k = ease(g.k);
      if (this.view === 'hand') up.set(0, 0, 1);
      pos.lerpVectors(g.pos, camera.position, k); tgt.lerpVectors(g.tgt, tgt, k); up.lerpVectors(g.up, camera.up, k).normalize();
      camera.position.copy(pos); camera.up.copy(up); camera.lookAt(tgt);
    }
    this.lookAt.copy(tgt);
    camera.updateMatrixWorld(true);
  }
}
