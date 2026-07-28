/**
 * faceUVOrigin.js — per-face UV origins for Face-aligned projection.
 *
 * Face-aligned mode projects each flat face along its own normal, which fixes the
 * SCALE on angled faces. The remaining inconsistency is PHASE: the UV origin is
 * the model's bounding-box corner projected into each face's basis, so every face
 * starts the texture at an arbitrary point and a patterned texture looks randomly
 * offset from face to face.
 *
 * This computes, for each coplanar face (region), the minimum extent along that
 * face's own in-plane axes. Subtracting it makes u,v = 0 at the face's
 * bottom-left corner, so every face gets an identical offset relative to itself —
 * e.g. a brick course starts flush at the bottom edge of every face.
 *
 * Output is one (u0, v0) pair per CORNER, matching the non-indexed position
 * attribute layout, so it can be handed to the shader as a vertex attribute and
 * read per-vertex by the CPU displacement path — both then agree.
 *
 * The values are world-space millimetres along the face basis (NOT divided by the
 * reference extent), so the caller applies the same /md the rest of the mapping
 * uses.
 *
 * Region grouping matches coplanarFlip/remeshFlat: an area-weighted plane fit
 * (robust to sliver noise) flood-filled across edges whose apex tilt stays within
 * flatAngleDeg. Because subdivision only ever adds vertices INSIDE a face, the
 * extents are identical on a coarse or a subdivided mesh — which is why the
 * preview (coarse) and the export (subdivided) arrive at the same origins without
 * having to thread the attribute through subdivision.
 */

import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5;

/** In-plane basis for a face normal — must match mapping.js / previewMaterial.js. */
export function faceBasis(nx, ny, nz) {
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ux = nx / nl, uy = ny / nl, uz = nz / nl;
  let upx = 0, upy = 0, upz = 1;
  if (Math.abs(uz) > 0.99) { upx = 0; upy = 1; upz = 0; }
  const d = upx * ux + upy * uy + upz * uz;
  let e2x = upx - ux * d, e2y = upy - uy * d, e2z = upz - uz * d;
  const e2l = Math.hypot(e2x, e2y, e2z) || 1;
  e2x /= e2l; e2y /= e2l; e2z /= e2l;
  return {
    e1x: e2y * uz - e2z * uy, e1y: e2z * ux - e2x * uz, e1z: e2x * uy - e2y * ux,
    e2x, e2y, e2z,
  };
}

/**
 * @param {THREE.BufferGeometry} geometry non-indexed
 * @param {number} flatAngleDeg  max dihedral to join a flat region
 * @param {{x:number,y:number,z:number}} originMin  bounds.min (UVs are measured
 *        relative to it, same as the rest of the mapping)
 * @returns {Float32Array} 2 floats per corner: (u0, v0) in world mm
 */
export function computeFaceUVOrigins(geometry, flatAngleDeg, originMin) {
  const posAttr  = geometry.attributes.position;
  const nCorner  = posAttr.count;
  const triCount = (nCorner / 3) | 0;
  const out = new Float32Array(nCorner * 2);
  if (triCount === 0) return out;
  const sinFlat = Math.sin((flatAngleDeg || 1) * Math.PI / 180);
  const ox = originMin.x, oy = originMin.y, oz = originMin.z;

  // Weld corners -> unique vertices.
  const weld = new QuantizedPointMap(QUANT, Math.min(nCorner, 1 << 22));
  const triV = new Int32Array(nCorner);
  let nV = 0;
  for (let i = 0; i < nCorner; i++) {
    const id = weld.getOrSet(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), nV);
    if (weld.inserted) nV++;
    triV[i] = id;
  }
  const vx = new Float64Array(nV), vy = new Float64Array(nV), vz = new Float64Array(nV);
  for (let i = 0; i < nCorner; i++) {
    const id = triV[i];
    vx[id] = posAttr.getX(i); vy[id] = posAttr.getY(i); vz[id] = posAttr.getZ(i);
  }

  // Area-scaled face normals.
  const rnX = new Float64Array(triCount), rnY = new Float64Array(triCount), rnZ = new Float64Array(triCount);
  const tArea = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const b = t*3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    const e1x = vx[bb]-vx[a], e1y = vy[bb]-vy[a], e1z = vz[bb]-vz[a];
    const e2x = vx[c]-vx[a],  e2y = vy[c]-vy[a],  e2z = vz[c]-vz[a];
    const nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x;
    tArea[t] = Math.hypot(nx, ny, nz) * 0.5;
    rnX[t] = nx; rnY[t] = ny; rnZ[t] = nz;
  }

  // Edge -> up to two triangles.
  const em = new QuantizedPointMap(1, Math.min(nCorner, 1 << 22));
  const eT0 = [], eT1 = [];
  const slotOf = (a, b) => { const lo=a<b?a:b, hi=a<b?b:a; return em.get(lo, hi, 0); };
  for (let t = 0; t < triCount; t++) {
    const b = t*3, vv = [triV[b], triV[b+1], triV[b+2]];
    for (let e = 0; e < 3; e++) {
      const a = vv[e], c = vv[(e+1)%3], lo = a<c?a:c, hi = a<c?c:a;
      const slot = em.getOrSet(lo, hi, 0, eT0.length);
      if (em.inserted) { eT0.push(t); eT1.push(-1); }
      else if (eT1[slot] === -1) eT1[slot] = t; else eT1[slot] = -2;
    }
  }
  const otherTri = (t, a, b) => { const s = slotOf(a, b); if (s < 0) return -1;
    const x = eT0[s], y = eT1[s]; if (y === -2) return -2; return x === t ? y : x; };
  const apexOf = (t, u, v) => { const b = t*3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    if (a !== u && a !== v) return a; if (bb !== u && bb !== v) return bb; return c; };

  // Flood-fill flat regions, largest triangle first for a stable seed plane.
  const regionId = new Int32Array(triCount).fill(-1);
  const regionNX = [], regionNY = [], regionNZ = [];
  const order = Array.from({ length: triCount }, (_, t) => t)
    .filter(t => tArea[t] > 0).sort((a, b) => tArea[b] - tArea[a]);
  const stack = [];
  for (const seed of order) {
    if (regionId[seed] !== -1) continue;
    const r = regionNX.length;
    let ax = rnX[seed], ay = rnY[seed], az = rnZ[seed];
    let al = Math.hypot(ax, ay, az) || 1;
    let Nx = ax/al, Ny = ay/al, Nz = az/al;
    const sb = seed*3;
    const Ox = (vx[triV[sb]]+vx[triV[sb+1]]+vx[triV[sb+2]])/3;
    const Oy = (vy[triV[sb]]+vy[triV[sb+1]]+vy[triV[sb+2]])/3;
    const Oz = (vz[triV[sb]]+vz[triV[sb+1]]+vz[triV[sb+2]])/3;
    regionId[seed] = r; stack.length = 0; stack.push(seed);
    while (stack.length) {
      const t = stack.pop(), b = t*3;
      const vv = [triV[b], triV[b+1], triV[b+2]];
      for (let e = 0; e < 3; e++) {
        const a = vv[e], c = vv[(e+1)%3];
        const nb = otherTri(t, a, c);
        if (nb < 0 || regionId[nb] !== -1) continue;
        if (rnX[nb]*Nx + rnY[nb]*Ny + rnZ[nb]*Nz <= 0) continue;
        const w = apexOf(nb, a, c);
        const dz = (vx[w]-Ox)*Nx + (vy[w]-Oy)*Ny + (vz[w]-Oz)*Nz;
        let ex = vx[c]-vx[a], ey = vy[c]-vy[a], ez = vz[c]-vz[a];
        const eL2 = ex*ex+ey*ey+ez*ez || 1;
        const wux = vx[w]-vx[a], wuy = vy[w]-vy[a], wuz = vz[w]-vz[a];
        const tt = (wux*ex+wuy*ey+wuz*ez)/eL2;
        const pxx = wux-tt*ex, pyy = wuy-tt*ey, pzz = wuz-tt*ez;
        const d3 = Math.hypot(pxx, pyy, pzz);
        if ((d3 > 1e-9 ? Math.abs(dz)/d3 : 0) > sinFlat) continue;
        regionId[nb] = r;
        ax += rnX[nb]; ay += rnY[nb]; az += rnZ[nb];
        al = Math.hypot(ax, ay, az) || 1; Nx = ax/al; Ny = ay/al; Nz = az/al;
        stack.push(nb);
      }
    }
    regionNX.push(Nx); regionNY.push(Ny); regionNZ.push(Nz);
  }

  // Per-region minimum along its own in-plane axes = that face's bottom-left.
  const nR = regionNX.length;
  const minU = new Float64Array(nR).fill(Infinity);
  const minV = new Float64Array(nR).fill(Infinity);
  const basis = new Array(nR);
  for (let r = 0; r < nR; r++) basis[r] = faceBasis(regionNX[r], regionNY[r], regionNZ[r]);
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t];
    if (r < 0) continue;
    const B = basis[r], b = t*3;
    for (let k = 0; k < 3; k++) {
      const id = triV[b+k];
      const rx = vx[id]-ox, ry = vy[id]-oy, rz = vz[id]-oz;
      const u = rx*B.e1x + ry*B.e1y + rz*B.e1z;
      const v = rx*B.e2x + ry*B.e2y + rz*B.e2z;
      if (u < minU[r]) minU[r] = u;
      if (v < minV[r]) minV[r] = v;
    }
  }
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t];
    const u0 = (r >= 0 && Number.isFinite(minU[r])) ? minU[r] : 0;
    const v0 = (r >= 0 && Number.isFinite(minV[r])) ? minV[r] : 0;
    for (let k = 0; k < 3; k++) { const o = (t*3+k)*2; out[o] = u0; out[o+1] = v0; }
  }
  return out;
}
