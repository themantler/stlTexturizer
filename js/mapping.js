/**
 * CPU-side UV mapping — exact JavaScript mirror of the GLSL in previewMaterial.js.
 * All functions take Three.js Vector3 objects for position/normal and
 * a bounds object { min, max, center, size } (all THREE.Vector3).
 */

export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;
export const MODE_FACE_ALIGNED = 7;

const TWO_PI = Math.PI * 2;

/**
 * Millimetres used to normalize planar / triplanar / cubic UV coordinates.
 * Default (fixed off): each mesh's largest bounding-box edge — pattern scales with part size.
 * Fixed world scale: user `referenceExtentMm` — same profile yields similar physical pattern size on any mesh.
 */
export function getReferenceExtent(settings, bounds) {
  const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  const md = Math.max(maxDim, 1e-6);
  if (settings.fixedWorldTextureScale) {
    const ref = Number(settings.referenceExtentMm);
    if (Number.isFinite(ref) && ref > 0) return ref;
  }
  return md;
}
const CUBIC_AXIS_EPSILON = 1e-4;

export function getDominantCubicAxis(normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  // Treat near-ties as an intentional tie so 45° faces pick one stable axis
  // instead of flipping projection due to tiny normal jitter between triangles.
  if (ax >= ay - CUBIC_AXIS_EPSILON && ax >= az - CUBIC_AXIS_EPSILON) return 'x';
  if (ay >= az - CUBIC_AXIS_EPSILON) return 'y';
  return 'z';
}

export function getCubicBlendWeights(normal, blend, seamBandWidth = 0.35) {
  const axis = getDominantCubicAxis(normal);
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const primary = axis === 'x' ? ax : axis === 'y' ? ay : az;
  const secondary = axis === 'x' ? Math.max(ay, az) : axis === 'y' ? Math.max(ax, az) : Math.max(ax, ay);

  // blend=0: hard one-hot for sharp seams. Do NOT also short-circuit at the
  // primary≈secondary tie when blend>0 — the smooth weight branch handles
  // an exact 45° normal correctly (it produces 0.5/0.5), and short-circuiting
  // to one-hot there creates a single-vertex spike on fillets where the
  // smooth normal sweeps continuously across the cube-face boundary.
  if (blend <= 0.001) {
    return {
      x: axis === 'x' ? 1 : 0,
      y: axis === 'y' ? 1 : 0,
      z: axis === 'z' ? 1 : 0,
    };
  }

  const oneHot = {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0,
  };

  // Only blend inside a seam band around the cube-face boundary. This keeps
  // strongly dominant faces fully textured even when the slider is barely on.
  const seamWidth = Math.max(seamBandWidth, CUBIC_AXIS_EPSILON * 2);
  const seamMixRaw = 1 - Math.min(1, Math.max(0, (primary - secondary) / seamWidth));
  const seamMix = blend * seamMixRaw * seamMixRaw * (3 - 2 * seamMixRaw);
  if (seamMix <= 0.001) return oneHot;

  // blend=1 should produce a genuinely soft triplanar-style transition.
  // Lower blend values progressively sharpen the weights back toward a single
  // dominant axis without snapping until the slider reaches zero.
  const power = 1 + (1 - seamMix) * 11;
  const sx = Math.pow(ax, power);
  const sy = Math.pow(ay, power);
  const sz = Math.pow(az, power);
  const smoothSum = sx + sy + sz + 1e-6;
  const smooth = {
    x: sx / smoothSum,
    y: sy / smoothSum,
    z: sz / smoothSum,
  };

  const mx = oneHot.x * (1 - seamMix) + smooth.x * seamMix;
  const my = oneHot.y * (1 - seamMix) + smooth.y * seamMix;
  const mz = oneHot.z * (1 - seamMix) + smooth.z * seamMix;
  const sum = mx + my + mz;

  return {
    x: mx / sum,
    y: my / sum,
    z: mz / sum,
  };
}

/**
 * Compute normalised UV coordinates [0, 1) (tiling) for a vertex.
 *
 * @param {{ x:number, y:number, z:number }} pos      vertex position
 * @param {{ x:number, y:number, z:number }} normal   vertex normal (unit)
 * @param {number}  mode    one of the MODE_* constants
 * @param {{ scaleU:number, scaleV:number, offsetU:number, offsetV:number }} settings
 * @param {{ min, max, center, size }} bounds           THREE.Vector3 fields
 * @returns {{ u:number, v:number }}                    tiled UV after scale+offset
 */
export function computeUV(pos, normal, mode, settings, bounds) {
  const { min, size, center } = bounds;
  // Compensate for non-square textures: divide scale by aspect correction
  // so equal world-space distances produce equal physical texture distances.
  const aU = settings.textureAspectU ?? 1;
  const aV = settings.textureAspectV ?? 1;
  const scaleU = (settings.scaleU) / aU;
  const scaleV = (settings.scaleV) / aV;
  const { offsetU, offsetV } = settings;
  const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const md = getReferenceExtent(settings, bounds);

  let u = 0, v = 0;

  switch (mode) {

    case MODE_PLANAR_XY: {
      u = (pos.x - min.x) / md;
      v = (pos.y - min.y) / md;
      break;
    }

    case MODE_PLANAR_XZ: {
      u = (pos.x - min.x) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_PLANAR_YZ: {
      u = (pos.y - min.y) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_FACE_ALIGNED: {
      // Project each face along ITS OWN normal, so a flat face lands at true
      // 1:1 scale no matter how it is angled in space. The axis-aligned modes
      // (planar / triplanar / cubic) foreshorten any face that is not square to
      // the projection axis — a 60 deg face reads ~4x larger, an 80 deg face
      // ~11x — which is why a fixed world scale still looked face-dependent.
      //
      // In-plane basis: world +Z projected onto the face gives "up" (v), so a
      // directional texture runs uphill consistently across angled faces; the
      // horizontal in-plane axis gives u. Faces that are nearly horizontal have
      // no in-plane +Z, so they fall back to +Y.
      const nx = normal.x, ny = normal.y, nz = normal.z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const ux = nx / nl, uy = ny / nl, uz = nz / nl;
      let upx = 0, upy = 0, upz = 1;
      if (Math.abs(uz) > 0.99) { upx = 0; upy = 1; upz = 0; }
      const d = upx * ux + upy * uy + upz * uz;
      let e2x = upx - ux * d, e2y = upy - uy * d, e2z = upz - uz * d;
      const e2l = Math.hypot(e2x, e2y, e2z) || 1;
      e2x /= e2l; e2y /= e2l; e2z /= e2l;
      // e1 = e2 x n  (the other in-plane axis)
      const e1x = e2y * uz - e2z * uy;
      const e1y = e2z * ux - e2x * uz;
      const e1z = e2x * uy - e2y * ux;
      // Anchor at a fixed world point so the texture does not swim between
      // faces or move when the model changes size.
      const rx = pos.x - min.x, ry = pos.y - min.y, rz = pos.z - min.z;
      // When a per-face frame is supplied (faceFrame.js, via the faceFrame
      // attribute) use it instead of the world-+Z-derived axes: U runs along the
      // face's chosen edge and the origin sits at that face's own corner, so the
      // texture and the remesh grid share one frame and cannot stair-step
      // against each other. Falls back to the world-derived basis when absent.
      const F = settings._faceFrame;
      if (F) {
        // Both axes come from the face frame. V is NOT rebuilt from the
        // per-vertex normal here: doing so left u on a constant per-face axis
        // while v tracked every wobble of that normal, so the two directions of
        // the pattern behaved differently on the same flat face.
        const Fx = F[0], Fy = F[1], Fz = F[2];
        const Vx = F[3], Vy = F[4], Vz = F[5];
        u = ((rx * Fx + ry * Fy + rz * Fz) - F[6]) / md;
        v = ((rx * Vx + ry * Vy + rz * Vz) - F[7]) / md;
      } else {
        u = (rx * e1x + ry * e1y + rz * e1z) / md;
        v = (rx * e2x + ry * e2y + rz * e2z) / md;
      }
      break;
    }

    case MODE_CYLINDRICAL: {
      // mappingBlend=0 → pure side projection for all faces (original behaviour, no cap seam).
      // mappingBlend>0 → smooth side↔cap blend.
      // Cylinder axis is +Z. Center XY and radius default to the AABB but can
      // be overridden so partial cylinders (pie slices) project undistorted.
      const cx = settings.cylinderCenterX ?? center.x;
      const cy = settings.cylinderCenterY ?? center.y;
      const r  = Math.max(settings.cylinderRadius ?? Math.max(size.x, size.y) * 0.5, 1e-6);
      const C  = TWO_PI * r;
      const rx = pos.x - cx;
      const ry = pos.y - cy;
      const blend = settings.mappingBlend ?? 0.0;
      const theta = Math.atan2(ry, rx);
      const uRaw = (theta / TWO_PI) + 0.5;
      const vSide = (pos.z - min.z) / C;

      // Seam smoothing: cross-fade between left-side and right-side texture
      // continuations at the atan2 wrap. Both sides use smoothly varying UVs
      // (shifted by ±1.0 in raw space), preserving full texture detail.
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      const inSeamZone = seamBand > 0.001 && seamDist < seamBand;

      let sideSamples;
      if (inSeamZone) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [
          { u: tRight.u, v: tRight.v, w: t },
          { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
        ];
      } else {
        const tSide = applyTransform(uRaw, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [{ u: tSide.u, v: tSide.v, w: 1 }];
      }

      if (blend <= 0.001) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const capThreshold = Math.cos((settings.capAngle ?? 20) * Math.PI / 180);
      const blendHalf = (settings.seamBandWidth ?? 0.5) * 0.5;
      const absnz = Math.abs(normal.z);
      const capW = Math.max(0, Math.min(1, (absnz - (capThreshold - blendHalf)) / (2 * blendHalf + 1e-6)));

      if (capW <= 0) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const uCap  = rx / C + 0.5;
      const vCap  = ry / C + 0.5;
      const tCap = applyTransform(uCap, vCap, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (capW >= 1) {
        return tCap;
      }

      // Combine seam-blended side samples with cap sample
      const samples = sideSamples.map(s => ({ u: s.u, v: s.v, w: s.w * (1 - capW) }));
      samples.push({ u: tCap.u, v: tCap.v, w: capW });
      return { triplanar: true, samples };
    }

    case MODE_SPHERICAL: {
      const rx = pos.x - center.x;
      const ry = pos.y - center.y;
      const rz = pos.z - center.z;
      const r  = Math.sqrt(rx*rx + ry*ry + rz*rz);
      const phi   = Math.acos(Math.max(-1, Math.min(1, rz / Math.max(r, 1e-6)))); // [0, PI], Z is up
      const theta = Math.atan2(ry, rx);              // [-PI, PI]
      const uRaw = (theta / TWO_PI) + 0.5;
      const vRaw = phi / Math.PI;

      // Seam smoothing: cross-fade at the atan2 wrap
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      if (seamBand > 0.001 && seamDist < seamBand) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        return {
          triplanar: true,
          samples: [
            { u: tRight.u, v: tRight.v, w: t },
            { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
          ],
        };
      }

      u = uRaw;
      v = vRaw;
      break;
    }

    case MODE_CUBIC: {
      const weights = getCubicBlendWeights(normal, settings.mappingBlend ?? 0.0, settings.seamBandWidth ?? 0.35);
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      // Derived from camera right = view_dir × up_dir for each face orientation (Z-up).
      let yzU = (pos.y - min.y) / md;
      if (normal.x < 0) yzU = -yzU;
      let xzU = (pos.x - min.x) / md;
      if (normal.y > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const tYZ = applyTransform(yzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
      const tXZ = applyTransform(xzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
      const tXY = applyTransform(xyU, (pos.y - min.y) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (weights.x > 0.999) return tYZ;
      if (weights.y > 0.999) return tXZ;
      if (weights.z > 0.999) return tXY;

      return {
        triplanar: true,
        samples: [
          { u: tXY.u, v: tXY.v, w: weights.z },
          { u: tXZ.u, v: tXZ.v, w: weights.y },
          { u: tYZ.u, v: tYZ.v, w: weights.x },
        ],
      };
    }

    case MODE_TRIPLANAR:
    default: {
      // World-space normal blending
      const ax = Math.abs(normal.x);
      const ay = Math.abs(normal.y);
      const az = Math.abs(normal.z);
      const ax2 = ax * ax, ay2 = ay * ay, az2 = az * az;
      const bx = ax2 * ax2;
      const by = ay2 * ay2;
      const bz = az2 * az2;
      const sum = bx + by + bz + 1e-6;
      const wx = bx / sum;
      const wy = by / sum;
      const wz = bz / sum;

      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      let yzU = (pos.y - min.y) / md;
      if (normal.x < 0) yzU = -yzU;
      let xzU = (pos.x - min.x) / md;
      if (normal.y > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const uvXY = {
        u: xyU,
        v: (pos.y - min.y) / md,
        w: wz,
      };
      const uvXZ = {
        u: xzU,
        v: (pos.z - min.z) / md,
        w: wy,
      };
      const uvYZ = {
        u: yzU,
        v: (pos.z - min.z) / md,
        w: wx,
      };

      // Apply scale+offset+rotation and tile each independently
      return {
        triplanar: true,
        samples: [
          { ...applyTransform(uvXY.u, uvXY.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvXY.w },
          { ...applyTransform(uvXZ.u, uvXZ.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvXZ.w },
          { ...applyTransform(uvYZ.u, uvYZ.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvYZ.w },
        ],
      };
    }
  }

  return applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
}

function applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR) {
  let uu = u / scaleU + offsetU;
  let vv = v / scaleV + offsetV;
  if (cosR !== 1 || sinR !== 0) {
    uu -= 0.5; vv -= 0.5;
    const ru = cosR * uu - sinR * vv;
    const rv = sinR * uu + cosR * vv;
    uu = ru + 0.5; vv = rv + 0.5;
  }
  return { triplanar: false, u: fract(uu), v: fract(vv) };
}

/** Fractional part, always positive (mirrors GLSL fract) */
function fract(x) { return x - Math.floor(x); }
