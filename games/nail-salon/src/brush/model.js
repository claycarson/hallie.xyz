// @ts-check
import * as THREE from 'three';

// The little polish brush on screen (PLAN §5). It lives in the active nail's paint frame, so all
// its numbers are in nail widths. It only shows where the Pencil is; it never paints.

const UP = new THREE.Vector3(0, 1, 0);
const BRISTLE = 0.5, FERRULE = 0.22, CAP = 0.75;

/** A flat fan of bristles with a rounded tip, hanging down from y = 0. */
function fanGeometry() {
  const rows = 18, seg = 28, pos = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const v = (r / rows) ** 1.6, round = Math.sqrt(1 - (1 - Math.min(v / 0.2, 1)) ** 2);  // v = 0 at the tip
    const a = (0.2 + (0.095 - 0.2) * v) * round, y = -BRISTLE * (1 - v);
    for (let s = 0; s < seg; s++) { const q = s / seg * Math.PI * 2; pos.push(Math.cos(q) * a, y, Math.sin(q) * a * 0.34); }
  }
  for (let r = 0; r < rows; r++) for (let s = 0; s < seg; s++) {
    const a = r * seg + s, b = r * seg + (s + 1) % seg, c = a + seg, d = b + seg;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** The cap: slim, a little waisted, with a rounded top. Starts at y = 0. */
function capGeometry() {
  const pts = [[0.104, 0], [0.11, 0.05], [0.125, CAP * 0.55], [0.128, CAP - 0.08], [0.11, CAP - 0.02], [0.07, CAP], [0, CAP + 0.005]];
  return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 32);
}

export class BrushModel {
  /** @param {any} tuning data/tuning.json "brushModel" @param {THREE.Object3D} parent the nail's paint frame */
  constructor(tuning, parent) {
    this.t = tuning;
    this.lastSeen = -Infinity;
    this.touching = false;
    this.pos = new THREE.Vector3();                // contact point, paint coords
    this.surfaceZ = 0;
    this.axis = new THREE.Vector3(0, 0, 1);        // tip → tail, paint coords
    this.bend = new THREE.Vector2();               // bristle drag, smoothed
    this._prev = new THREE.Vector2(); this._hasPrev = false;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion();

    this.root = new THREE.Group(); this.root.visible = false;
    this.bristleColor = new THREE.MeshPhysicalMaterial({ color: 0xc22222, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.2 });
    this.capMat = new THREE.MeshStandardMaterial({ color: 0xe9b9a0, metalness: 1, roughness: 0.22 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xd8d4d0, metalness: 1, roughness: 0.3 });

    // The bristles hang from their root so that splaying and dragging pivot there.
    this.bristles = new THREE.Mesh(fanGeometry(), this.bristleColor); this.bristles.position.y = BRISTLE;
    const fg = new THREE.CylinderGeometry(0.1, 0.095, FERRULE, 28); fg.translate(0, BRISTLE + FERRULE / 2, 0);
    const cg = capGeometry(); cg.translate(0, BRISTLE + FERRULE, 0);
    this.root.add(this.bristles, new THREE.Mesh(fg, metal), new THREE.Mesh(cg, this.capMat));
    parent.add(this.root);

    const size = 64, px = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const r = Math.hypot(i - size / 2 + 0.5, j - size / 2 + 0.5) / (size / 2), k = (j * size + i) * 4;
      px[k + 3] = Math.round(255 * Math.max(0, 1 - r) ** 2);
    }
    const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, color: 0x2a1410, transparent: true, depthWrite: false, depthTest: false }));
    this.shadow.visible = false;
    parent.add(this.shadow);
  }

  setPolish(color) { this.bristleColor.color.set(color); }
  setCap(cap) { this.capMat.color.set(cap.color); this.capMat.metalness = cap.metalness; this.capMat.roughness = cap.roughness; }

  /**
   * Move to where the Pencil is.
   * @param {number} x @param {number} y contact, paint coords
   * @param {number} z the surface height there
   * @param {number} tailX @param {number} tailY which way the tail leans, in paint coords (any length)
   * @param {number} altitude radians, π/2 = upright
   * @param {boolean} touching
   * @param {number} now ms
   */
  place(x, y, z, tailX, tailY, altitude, touching, now) {
    const t = this.t, lean = Math.max(t.minLeanDeg * Math.PI / 180, Math.PI / 2 - altitude), len = Math.hypot(tailX, tailY) || 1;
    this.axis.set(tailX / len * Math.sin(lean), tailY / len * Math.sin(lean), Math.cos(lean));
    this.pos.set(x, y, z); this.surfaceZ = z; this.touching = touching; this.lastSeen = now;
    if (touching && this._hasPrev) {                         // bristles trail the stroke
      const dx = x - this._prev.x, dy = y - this._prev.y, d = Math.hypot(dx, dy);
      if (d > 1e-4) this.bend.lerp(this._v.set(-dx / d, -dy / d, 0), t.bendSmooth);
    } else if (!touching) this.bend.multiplyScalar(0.8);
    this._prev.set(x, y); this._hasPrev = touching;
  }

  /** Once per frame. `active` is false when the brush must not show (hand view, mid-turn). */
  update(now, down, active) {
    const t = this.t, show = active && (down || now - this.lastSeen < t.keepMs);
    this.root.visible = this.shadow.visible = show;
    if (!show) { this._hasPrev = false; return; }
    this.touching = down;
    const squash = down ? t.squash : 1, gap = down ? 0 : t.hoverGap;
    this.root.quaternion.setFromUnitVectors(UP, this.axis);
    this.root.scale.setScalar(t.scale);
    this.root.position.copy(this.pos).addScaledVector(this.axis, gap - BRISTLE * t.scale * (1 - squash));
    this.bristles.scale.set(down ? t.splay : 1, squash, down ? t.splay : 1);

    // Drag: the stroke direction brought into the brush's own axes, then a small tilt at the root.
    this._q.copy(this.root.quaternion).invert();
    this._v.set(this.bend.x, this.bend.y, 0).applyQuaternion(this._q);
    const b = (down ? t.bendDeg : 0) * Math.PI / 180;
    this.bristles.rotation.set(-this._v.z * b, 0, this._v.x * b);

    const lift = this.root.position.z - this.surfaceZ, spread = t.shadowSize * (1 + lift * 1.5);
    this.shadow.position.set(this.pos.x + t.shadowOffset[0], this.pos.y + t.shadowOffset[1], this.surfaceZ + 0.02);
    this.shadow.scale.set(spread, spread, 1);
    /** @type {THREE.MeshBasicMaterial} */ (this.shadow.material).opacity = t.shadowAlpha / (1 + lift * 3);
  }

  /** For tests: where it is, in paint coords. */
  state() {
    const tail = this.pos.clone().addScaledVector(this.axis, BRISTLE + FERRULE + CAP);
    return { visible: this.root.visible, touching: this.touching, x: this.pos.x, y: this.pos.y, tipZ: this.root.position.z, surfaceZ: this.surfaceZ, axisZ: this.axis.z, tail: tail.toArray(), splay: this.bristles.scale.x };
  }
}
