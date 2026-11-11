// @ts-check
import * as THREE from 'three';
import { NailFrame } from './frame.js';
import { outline, sdPolygon } from './outline.js';
import { OutlineSdf } from './sdf.js';
import { SkinHeight, makePlateZ, buildPlate, buildPlateNormals } from './plate.js';
import { makeFingerUniforms, makeNailMaterial } from './materials.js';
import { PaintTargets } from '../paint/targets.js';
import { NailStats } from '../paint/stats.js';

/**
 * One finger (PLAN §4.1, M1.1): its nail frame, plate, skin heightfield, outline and its own
 * small paint targets. While it is the one being painted, the game binds the shared 1024² set
 * instead (`bind`) and copies back when it leaves.
 */
export class Finger {
  /**
   * @param {any} cfg one entry of data/hand.json "fingers"
   * @param {object} o
   * @param {THREE.Scene} o.scene @param {THREE.Mesh} o.skinMesh @param {THREE.WebGLRenderer} o.renderer
   * @param {any} o.handData @param {any} o.tuning @param {any} o.caps
   */
  constructor(cfg, { scene, skinMesh, renderer, handData, tuning, caps }) {
    this.cfg = cfg;
    this.id = cfg.finger;
    this.fold = handData.fold;
    this.frame = new NailFrame(cfg, handData.maxFree);
    scene.add(this.frame.group);
    this.frame.group.updateMatrixWorld(true);
    this.frame.update();
    this.uniforms = makeFingerUniforms(this.frame, this.fold, tuning);
    this.skin = new SkinHeight(this.frame, [skinMesh]);
    this.skinMask = this.skin.maskTexture();
    this.sdf = new OutlineSdf(this.frame.rect);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), makeNailMaterial(this.uniforms));
    this.frame.group.add(this.mesh);
    this.targets = new PaintTargets(tuning.paint.restSize, caps);
    this.targets.clear(renderer);
    this.info = outline('round', 1);
    this.plateZ = /** @type {any} */ ((x, y) => 0);
    this.shape = 'round'; this.free = 0;
    /** Seconds of wetness left (shine), of fresh polish left (levelling), and the drying pass's
     *  fractional steps. A clear coat sets only `left`. */
    this.wet = { left: 0, level: 0, debt: 0 };
    /** Painted (or leveled) since it was last copied down from the shared set. */
    this.dirty = false;
    /** Its own stats reader, so each nail's numbers are read from whichever set holds its paint. */
    this.nstats = new NailStats(tuning);
    this.bound = this.targets;
    this.bind(this.targets);
  }

  /** Point the nail's material at a paint set (its own, or the shared 1024² one). */
  bind(targets) {
    const u = this.uniforms;
    this.bound = targets;
    u.tSdf.value = this.sdf.texture;
    u.tPig.value = targets.pigment.texture; u.tMat.value = targets.material.texture; u.tDet.value = targets.detail.texture;
    this.nstats.setFinger(this.sdf.texture, targets, this.frame.rect);
  }

  /** The latest stats read for this nail. */
  get stats() { return this.nstats.last; }

  /** Signed distance to the outline, nail widths, negative inside. */
  sd(x, y) { return sdPolygon(this.info.points, x, y); }

  /** The surface a brush touches: the plate inside the outline, the skin outside. */
  surface(x, y) { return this.sd(x, y) <= 0 ? this.plateZ(x, y) : this.skin.at(x, y); }

  /** Rebuild the outline, SDF, plate and plate normals for a shape and free-edge length. */
  setShape(renderer, shape, free) {
    this.shape = shape; this.free = free;
    this.info = outline(shape, this.frame.lengthFor(free));
    this.sdf.update(renderer, this.info.points);
    this.plateZ = makePlateZ(this.frame, this.info.points, this.skin, this.fold, this.cfg);
    this.mesh.geometry.dispose();
    this.mesh.geometry = buildPlate(this.info, this.plateZ, this.fold, this.frame.bed);
    const u = this.uniforms;
    u.tSdf.value = this.sdf.texture;
    u.tNrm.value = buildPlateNormals(this.plateZ, this.info.points, this.info.length, this.frame.rect, u.tNrm.value);
    u.uCuticleDepth.value = this.info.cuticleDepth;
    this.bind(this.bound);
    this.nstats.refreshGeometry(renderer);       // waits on the GPU: only when the shape changes
  }

  /** Is there hand here (this nail or any skin seen from above it), not table or air? */
  onHand(x, y) {
    if (this.sd(x, y) <= 0) return true;
    const r = this.frame.rect, sh = this.skin;
    const i = Math.round((x - r.x0) / r.w * (sh.nx - 1)), j = Math.round((y - r.y0) / r.h * (sh.ny - 1));
    if (i < 0 || j < 0 || i >= sh.nx || j >= sh.ny) return false;
    return sh.valid[j * sh.nx + i] === 1;
  }

  /** Where the nail's middle is, in world space (for picking it in hand view). */
  centre(out = new THREE.Vector3()) {
    return out.set(0, this.info.length * 0.5, this.plateZ(0, this.info.length * 0.5)).applyMatrix4(this.frame.group.matrixWorld);
  }
}
