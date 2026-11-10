// @ts-check
import * as THREE from 'three';

/**
 * A nail frame (PLAN §3.3): where one nail sits, as data from data/hand.json.
 * Paint-frame coordinates are in nail widths: x across, y toward the tip, z out of the nail,
 * origin at the centre of the cuticle edge. `group` carries paint coords into the parent's
 * space (a fingertip bone, or the scene for the stand-in), so anything parented to it can be
 * built directly in paint coords.
 */
export class NailFrame {
  constructor(cfg, maxFree) {
    this.cfg = cfg;
    this.finger = cfg.finger;
    this.width = cfg.width;
    this.bed = cfg.bedLength / cfg.width;
    this.maxFree = maxFree;
    this.maxLength = this.bed + maxFree;
    /** The paint frame: a flat rectangle around the nail, in nail widths. */
    this.rect = { x0: -0.9, y0: -0.45, w: 1.8, h: 0.45 + this.maxLength + 0.35 };

    const t = new THREE.Vector3(...cfg.tipDir).normalize();
    const n = new THREE.Vector3(...cfg.normal);
    n.addScaledVector(t, -n.dot(t)).normalize();
    const s = new THREE.Vector3().crossVectors(t, n);
    this.group = new THREE.Group();
    this.group.name = `nail-frame-${cfg.finger}`;
    this.group.matrixAutoUpdate = false;
    this.group.matrix.makeBasis(s, t, n).scale(new THREE.Vector3(cfg.width, cfg.width, cfg.width));
    this.group.matrix.setPosition(cfg.origin[0], cfg.origin[1], cfg.origin[2]);
    /** World → paint coords. Call update() after the hand moves. */
    this.worldToPaint = new THREE.Matrix4();
  }

  /** Total nail length in widths for a free-edge setting of 0–1. */
  lengthFor(free) { return this.bed + free * this.maxFree; }

  update() {
    this.group.updateWorldMatrix(true, false);
    this.worldToPaint.copy(this.group.matrixWorld).invert();
  }

  /** Paint coords → world, in place. */
  toWorld(v) { return v.applyMatrix4(this.group.matrixWorld); }
}
