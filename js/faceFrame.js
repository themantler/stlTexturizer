/**
 * faceFrame.js — per-face texture/grid frame for Face-aligned projection.
 *
 * Two things have to agree on every flat face or the texture stair-steps:
 *   • the remesh lattice's row direction, and
 *   • the texture's own U/V axes.
 * They are both derived here, from ONE frame per coplanar face, so they cannot
 * drift apart.
 *
 * The frame is anchored to a chosen EDGE of the face rather than to a world
 * axis. Deriving "up" from world +Z works only while a face's chosen edge is
 * perpendicular to it; on a face whose bottom edge is slanted, the grid rotates
 * away from that edge and the stair-stepping returns. Which edge is the
 * meaningful one is a property of the part, not something that can be inferred,
 * so it is the user's choice: bottom / top / left / right.
 *
 * Per face:
 *   1. Build a reference frame (world +Z projected into the face = up, falling
 *      back to +Y on near-horizontal faces) purely to define what
 *      bottom/top/left/right MEAN on this face.
 *   2. Find the longest boundary edge sitting in the extreme band for the chosen
 *      side. Its direction becomes the frame's U axis, so grid rows and texture
 *      run parallel to that edge.
 *   3. V = N × U, flipped if needed to point into the face interior.
 *   4. Record the face's minimum extent along U and V — the origin, so the
 *      texture starts at that face's own corner.
 *
 * Output is per CORNER, matching the non-indexed position layout: 6 floats
 * (Ux,Uy,Uz, u0,v0, pad). V is recomputed as N × U by consumers, which keeps the
 * attribute small and guarantees they use the same V.
 *
 * Subdivision only ever adds vertices INSIDE a face, so a coarse mesh and a
 * subdivided one yield identical frames — the attribute does not need threading
 * through subdivision.
 */

import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5;

/** Reference frame used only to define which side is bottom/top/left/right. */
export function referenceFrame(nx, ny, nz) {
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ux = nx / nl, uy = ny / nl, uz = nz / nl;
  let upx = 0, upy = 0, upz = 1;
  if (Math.abs(uz) > 0.99) { upx = 0; upy = 1; upz = 0; }
  const d = upx * ux + upy * uy + upz * uz;
  let e2x = upx - ux * d, e2y = upy - uy * d, e2z = upz - uz * d;
  const l = Math.hypot(e2x, e2y, e2z) || 1;
  e2x /= l; e2y /= l; e2z /= l;
  return {
    upX: e2x, upY: e2y, upZ: e2z,                      // "up" in the face
    rtX: e2y * uz - e2z * uy,                          // "right" = up × n
    rtY: e2z * ux - e2x * uz,
    rtZ: e2x * uy - e2y * ux,
    nX: ux, nY: uy, nZ: uz,
  };
}

/**
 * @param {THREE.BufferGeometry} geometry non-indexed
 * @param {number} flatAngleDeg max dihedral to join a flat region
 * @param {{x,y,z}} originMin bounds.min — UVs are measured relative to it
 * @param {'bottom'|'top'|'left'|'right'} side edge to align to
 * @returns {Float32Array} 6 floats per corner: Ux,Uy,Uz,u0,v0,0
 */
export function computeFaceFrames(geometry, flatAngleDeg, originMin, side = 'bottom') {
  const posAttr  = geometry.attributes.position;
  const nCorner  = posAttr.count;
  const triCount = (nCorner / 3) | 0;
  const out = new Float32Array(nCorner * 6);
  if (triCount === 0) return out;
  const sinFlat = Math.sin((flatAngleDeg || 1) * Math.PI / 180);
  const ox = originMin.x, oy = originMin.y, oz = originMin.z;

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

  // Flat-region flood fill (area-weighted plane; robust to sliver noise).
  const regionId = new Int32Array(triCount).fill(-1);
  const rNX = [], rNY = [], rNZ = [];
  const order = Array.from({ length: triCount }, (_, t) => t)
    .filter(t => tArea[t] > 0).sort((a, b) => tArea[b] - tArea[a]);
  const stack = [];
  for (const seed of order) {
    if (regionId[seed] !== -1) continue;
    const r = rNX.length;
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
    rNX.push(Nx); rNY.push(Ny); rNZ.push(Nz);
  }

  // Degenerate triangles never join a region (they cannot seed one and their
  // null normal fails the hemisphere test). Adopt a neighbouring region via a
  // shared vertex, else the closest region plane — otherwise they would fall
  // back to a default frame and tear the UVs around slivers.
  const vertRegion = new Int32Array(nV).fill(-1);
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t]; if (r < 0) continue;
    const b = t*3;
    for (let k = 0; k < 3; k++) if (vertRegion[triV[b+k]] < 0) vertRegion[triV[b+k]] = r;
  }
  for (let t = 0; t < triCount; t++) {
    if (regionId[t] >= 0) continue;
    const b = t*3;
    for (let k = 0; k < 3; k++) { const r = vertRegion[triV[b+k]]; if (r >= 0) { regionId[t] = r; break; } }
  }

  const nR = rNX.length;
  if (nR === 0) return out;

  // Boundary edges per region (an edge whose two triangles disagree on region).
  const bEdges = Array.from({ length: nR }, () => []);
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t]; if (r < 0) continue;
    const b = t*3, vv = [triV[b], triV[b+1], triV[b+2]];
    for (let e = 0; e < 3; e++) {
      const a = vv[e], c = vv[(e+1)%3];
      const nb = otherTri(t, a, c);
      if (nb >= 0 && regionId[nb] === r) continue;
      bEdges[r].push(a, c);
    }
  }

  // Per region: pick the aligning edge, build the frame, record the origin.
  const fUx = new Float64Array(nR), fUy = new Float64Array(nR), fUz = new Float64Array(nR);
  const fu0 = new Float64Array(nR), fv0 = new Float64Array(nR);
  for (let r = 0; r < nR; r++) {
    const R = referenceFrame(rNX[r], rNY[r], rNZ[r]);
    // Axis the chosen side is extreme along, and its sign.
    const useUp = (side === 'bottom' || side === 'top');
    const aX = useUp ? R.upX : R.rtX, aY = useUp ? R.upY : R.rtY, aZ = useUp ? R.upZ : R.rtZ;
    const wantMax = (side === 'top' || side === 'right');
    const E = bEdges[r];
    // Extent along the chosen axis, so the "extreme band" scales with the face
    // rather than with edge length — a band derived from the longest edge spans
    // most of a face, which made every side select the same globally longest
    // edge and collapsed top/bottom/left/right onto one answer.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < E.length; i += 2) {
      for (const id of [E[i], E[i+1]]) {
        const s = (vx[id]-ox)*aX + (vy[id]-oy)*aY + (vz[id]-oz)*aZ;
        if (s < lo) lo = s; if (s > hi) hi = s;
      }
    }
    const ext = wantMax ? hi : lo;
    const span = Math.max(hi - lo, 1e-9);
    // Score each boundary edge: how far its midpoint sits from the chosen side,
    // minus how long it is. A pure "within a band of the extreme" test cannot
    // work for both cases — a slanted bottom edge necessarily spans a wide range
    // along the axis and falls outside a tight band, while a loose band lets the
    // globally longest edge win for every side. Trading position against length
    // picks the slanted bottom edge for 'bottom' AND the vertical edge for
    // 'left' on the same face.
    let maxLen = 1e-9;
    for (let i = 0; i < E.length; i += 2) {
      const a = E[i], c = E[i+1];
      maxLen = Math.max(maxLen, Math.hypot(vx[c]-vx[a], vy[c]-vy[a], vz[c]-vz[a]));
    }
    let bx = 0, by = 0, bz = 0, bestScore = Infinity, bestLen = -1;
    for (let i = 0; i < E.length; i += 2) {
      const a = E[i], c = E[i+1];
      const sa = (vx[a]-ox)*aX + (vy[a]-oy)*aY + (vz[a]-oz)*aZ;
      const sc = (vx[c]-ox)*aX + (vy[c]-oy)*aY + (vz[c]-oz)*aZ;
      const mid = (sa + sc) * 0.5;
      const dist = wantMax ? (hi - mid) : (mid - lo);
      const dx = vx[c]-vx[a], dy = vy[c]-vy[a], dz = vz[c]-vz[a];
      const len = Math.hypot(dx, dy, dz);
      const sc2 = (dist / span) - (len / maxLen);
      if (sc2 < bestScore) { bestScore = sc2; bestLen = len; bx = dx; by = dy; bz = dz; }
    }
    // U = that edge's direction, projected into the plane. Falls back to the
    // reference frame's own axis when the face has no usable edge there.
    let Ux, Uy, Uz;
    if (bestLen > 1e-9) {
      const d = bx*rNX[r] + by*rNY[r] + bz*rNZ[r];
      Ux = bx - rNX[r]*d; Uy = by - rNY[r]*d; Uz = bz - rNZ[r]*d;
      const l = Math.hypot(Ux, Uy, Uz) || 1; Ux/=l; Uy/=l; Uz/=l;
    } else { Ux = useUp ? R.rtX : R.upX; Uy = useUp ? R.rtY : R.upY; Uz = useUp ? R.rtZ : R.upZ; }
    // Keep U pointing the same way as the reference "right"/"up" so the texture
    // does not appear mirrored between neighbouring faces.
    const refX = useUp ? R.rtX : R.upX, refY = useUp ? R.rtY : R.upY, refZ = useUp ? R.rtZ : R.upZ;
    if (Ux*refX + Uy*refY + Uz*refZ < 0) { Ux = -Ux; Uy = -Uy; Uz = -Uz; }
    fUx[r] = Ux; fUy[r] = Uy; fUz[r] = Uz;
  }

  // Origin: the face's minimum along its own U and V.
  const minU = new Float64Array(nR).fill(Infinity);
  const minV = new Float64Array(nR).fill(Infinity);
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t]; if (r < 0) continue;
    const Ux = fUx[r], Uy = fUy[r], Uz = fUz[r];
    const Vx = rNY[r]*Uz - rNZ[r]*Uy, Vy = rNZ[r]*Ux - rNX[r]*Uz, Vz = rNX[r]*Uy - rNY[r]*Ux;
    const b = t*3;
    for (let k = 0; k < 3; k++) {
      const id = triV[b+k];
      const rx = vx[id]-ox, ry = vy[id]-oy, rz = vz[id]-oz;
      const u = rx*Ux + ry*Uy + rz*Uz;
      const v = rx*Vx + ry*Vy + rz*Vz;
      if (u < minU[r]) minU[r] = u;
      if (v < minV[r]) minV[r] = v;
    }
  }
  for (let r = 0; r < nR; r++) {
    fu0[r] = Number.isFinite(minU[r]) ? minU[r] : 0;
    fv0[r] = Number.isFinite(minV[r]) ? minV[r] : 0;
  }

  for (let t = 0; t < triCount; t++) {
    const r = regionId[t];
    const Ux = r >= 0 ? fUx[r] : 1, Uy = r >= 0 ? fUy[r] : 0, Uz = r >= 0 ? fUz[r] : 0;
    const u0 = r >= 0 ? fu0[r] : 0, v0 = r >= 0 ? fv0[r] : 0;
    for (let k = 0; k < 3; k++) {
      const o = (t*3+k)*6;
      out[o] = Ux; out[o+1] = Uy; out[o+2] = Uz; out[o+3] = u0; out[o+4] = v0; out[o+5] = 0;
    }
  }
  return out;
}
