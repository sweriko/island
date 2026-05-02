// @ts-nocheck
// Painterly post-processing pass: Kuwahara-style edge-preserving filter +
// Sobel ink outline + procedural canvas grain + saturation lift.
// Loosely modeled on the look of EllyKher's UE5 PainterlyShaderMaterial.

import { Vector4, TempNode, NodeUpdateType, PassNode } from "three/webgpu";
import {
  Fn,
  If,
  add,
  convertToTexture,
  dot,
  float,
  luminance,
  mix,
  nodeObject,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

class PainterlyNode extends TempNode {
  static get type() {
    return "PainterlyNode";
  }

  constructor(textureNode, brushSize, edgeStrength, paperStrength, saturation) {
    super("vec4");

    this.textureNode = textureNode;
    this.brushSize = brushSize;
    this.edgeStrength = edgeStrength;
    this.paperStrength = paperStrength;
    this.saturation = saturation;

    this._resolution = uniform(new Vector4());
    this.updateType = NodeUpdateType.FRAME;
  }

  update() {
    const map = this.textureNode.value;
    if (!map || !map.image) return;
    const w = map.image.width;
    const h = map.image.height;
    this._resolution.value.set(w, h, 1 / w, 1 / h);
  }

  setup() {
    const { textureNode, brushSize, edgeStrength, paperStrength, saturation } = this;
    const uvNode = textureNode.uvNode || uv();
    const texelSize = this._resolution.zw;

    const sampleAt = (dx, dy) =>
      textureNode.sample(uvNode.add(vec2(dx, dy).mul(texelSize))).rgb;

    const painterly = Fn(() => {
      const r = brushSize;
      const nr = r.negate();
      const z = float(0);

      // Shared 3x3 sample grid in pixel-space (offsets scaled by brushSize).
      // Four overlapping 2x2 quadrants are derived from these nine taps,
      // so the Kuwahara filter only costs nine texture reads.
      const c00 = sampleAt(nr, nr).toVar();
      const c10 = sampleAt(z, nr).toVar();
      const c20 = sampleAt(r, nr).toVar();
      const c01 = sampleAt(nr, z).toVar();
      const c11 = sampleAt(z, z).toVar();
      const c21 = sampleAt(r, z).toVar();
      const c02 = sampleAt(nr, r).toVar();
      const c12 = sampleAt(z, r).toVar();
      const c22 = sampleAt(r, r).toVar();

      const quadrant = (a, b, c, d) => {
        const mean = a.add(b).add(c).add(d).mul(0.25);
        const da = a.sub(mean);
        const db = b.sub(mean);
        const dc = c.sub(mean);
        const dd = d.sub(mean);
        const variance = dot(da, da).add(dot(db, db)).add(dot(dc, dc)).add(dot(dd, dd));
        return { mean, variance };
      };

      const qNW = quadrant(c00, c10, c01, c11);
      const qNE = quadrant(c10, c20, c11, c21);
      const qSW = quadrant(c01, c11, c02, c12);
      const qSE = quadrant(c11, c21, c12, c22);

      const best = qNW.mean.toVar();
      const bestVar = qNW.variance.toVar();

      If(qNE.variance.lessThan(bestVar), () => {
        best.assign(qNE.mean);
        bestVar.assign(qNE.variance);
      });
      If(qSW.variance.lessThan(bestVar), () => {
        best.assign(qSW.mean);
        bestVar.assign(qSW.variance);
      });
      If(qSE.variance.lessThan(bestVar), () => {
        best.assign(qSE.mean);
        bestVar.assign(qSE.variance);
      });

      // Sobel on luminance, reusing the nine taps.
      const l00 = luminance(c00);
      const l10 = luminance(c10);
      const l20 = luminance(c20);
      const l01 = luminance(c01);
      const l21 = luminance(c21);
      const l02 = luminance(c02);
      const l12 = luminance(c12);
      const l22 = luminance(c22);

      const gx = add(l20, l22, l21.mul(2)).sub(add(l00, l02, l01.mul(2)));
      const gy = add(l02, l22, l12.mul(2)).sub(add(l00, l20, l10.mul(2)));
      const edge = gx.mul(gx).add(gy.mul(gy)).sqrt();
      const edgeMask = smoothstep(float(0.15), float(0.7), edge.mul(edgeStrength));

      const painted = best.toVar();

      // Saturation lift around the painted luminance.
      const lumPainted = luminance(painted);
      const saturated = mix(vec3(lumPainted, lumPainted, lumPainted), painted, saturation);

      // Procedural canvas grain using two sin-lattices in pixel space.
      const fragCoord = uvNode.mul(this._resolution.xy);
      const g1 = sin(fragCoord.x.mul(0.73).add(fragCoord.y.mul(1.21))).mul(0.5).add(0.5);
      const g2 = sin(fragCoord.x.mul(1.31).sub(fragCoord.y.mul(0.47))).mul(0.5).add(0.5);
      const grain = g1.mul(0.6).add(g2.mul(0.4));
      const paper = mix(float(1.0), grain.mul(0.45).add(0.6), paperStrength);

      const withPaper = saturated.mul(paper);

      // Soft ink outline blended in by the edge mask.
      const inkColor = vec3(0.06, 0.05, 0.08);
      const final = mix(withPaper, inkColor, edgeMask);

      return vec4(final, 1.0);
    });

    return painterly();
  }
}

const painterly = (textureNode, brushSize, edgeStrength, paperStrength, saturation) =>
  nodeObject(
    new PainterlyNode(
      convertToTexture(textureNode),
      nodeObject(brushSize),
      nodeObject(edgeStrength),
      nodeObject(paperStrength),
      nodeObject(saturation),
    ),
  );

class PainterlyPassNode extends PassNode {
  static get type() {
    return "PainterlyPassNode";
  }

  constructor(scene, camera, brushSize = 2, edgeStrength = 1.2, paperStrength = 0.45, saturation = 1.25) {
    super(PassNode.COLOR, scene, camera);

    this.brushSize = brushSize;
    this.edgeStrength = edgeStrength;
    this.paperStrength = paperStrength;
    this.saturation = saturation;
    this.isPainterlyPassNode = true;
  }

  setup() {
    const color = super.getTextureNode("output");
    return painterly(color, this.brushSize, this.edgeStrength, this.paperStrength, this.saturation);
  }
}

export const painterlyPass = (
  scene,
  camera,
  brushSize,
  edgeStrength,
  paperStrength,
  saturation,
) => new PainterlyPassNode(scene, camera, brushSize, edgeStrength, paperStrength, saturation);

export default PainterlyPassNode;
