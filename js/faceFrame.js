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
 * Output is per CORNER, matching the non-indexed position layout: 8 floats
 * (Ux,Uy,Uz, Vx,Vy,Vz, u0,v0). BOTH axes are carried. V used to be recomputed by
 * consumers as (per-vertex normal × U), which made the two texture axes
 * structurally different — u from a constant per-face axis, v inheriting every
 * per-vertex normal wobble — so the pattern could be stable in one direction and
 * not the other.
 *
 * Subdivision only ever adds vertices INSIDE a face, so a coarse mesh and a
 * subdivided one yield identical frames — the attribute does not need threading
 * through subdivision.
 */

import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5;

/** Floats per corner in the frame attribute: Ux,Uy,Uz, Vx,Vy,Vz, u0,v0. */
export const FRAME_STRIDE = 8;

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
 * Direction of the face's aligning edge, chosen from its boundary segments.
 *
 * Segments are first merged into straight LINES. This matters because the frame
 * is computed on the SUBDIVIDED mesh, where a single real CAD edge arrives as
 * many short fragments of unequal length. Scoring fragments individually let
 * whichever fragment happened to come out longest anywhere on the boundary set U
 * for the whole face, so the face's entire UV map rotated to an arbitrary line —
 * and it looked correct only when that fragment happened to lie on the right
 * edge. Merging first means a real edge is scored by its FULL length, and a
 * curved boundary (many short, mutually non-collinear fragments) correctly loses
 * to any genuine straight edge.
 *
 * @param {ArrayLike<number>} segs flat world coords, 6 per segment: ax,ay,az,cx,cy,cz
 * @param {object} R reference frame from referenceFrame()
 * @param {'bottom'|'top'|'left'|'right'} side
 * @returns {{x:number,y:number,z:number}|null} unit direction, or null if none
 */
export function chooseAlignedDir(segs, R, side) {
  const nSeg = (segs.length / 6) | 0;
  if (nSeg === 0) return null;
  const useUp = (side === 'bottom' || side === 'top');
  const wantMax = (side === 'top' || side === 'right');
  // In-plane 2D basis: p along "right", q along "up".
  const pX = R.rtX, pY = R.rtY, pZ = R.rtZ;
  const qX = R.upX, qY = R.upY, qZ = R.upZ;

  const m = nSeg * 2;
  const P = new Float64Array(m), Q = new Float64Array(m);
  let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
  for (let j = 0; j < m; j++) {
    const o = j * 3, x = segs[o], y = segs[o+1], z = segs[o+2];
    const p = x*pX + y*pY + z*pZ, q = x*qX + y*qY + z*qZ;
    P[j] = p; Q[j] = q;
    if (p < pMin) pMin = p; if (p > pMax) pMax = p;
    if (q < qMin) qMin = q; if (q > qMax) qMax = q;
  }
  const axisMin = useUp ? qMin : pMin, axisMax = useUp ? qMax : pMax;
  const span = Math.max(axisMax - axisMin, 1e-9);
  const diag = Math.hypot(pMax - pMin, qMax - qMin) || 1;
  const offTol = Math.max(diag * 2e-3, 1e-7);
  const COS_TOL = Math.cos(1.5 * Math.PI / 180);
  const MAX_CLUSTERS = 4096;

  // Cluster by (direction, perpendicular offset). Matching on |dot| makes this
  // orientation-free, so a fragment pointing the other way along the same edge
  // still joins it — folding directions into a half-plane instead would split
  // exactly the edges that straddle the fold angle.
  const cDx = [], cDy = [], cOff = [], cLen = [], cAxis = [];
  for (let s = 0; s < nSeg; s++) {
    const j0 = s*2, j1 = s*2 + 1;
    let dx = P[j1] - P[j0], dy = Q[j1] - Q[j0];
    const len = Math.hypot(dx, dy);
    if (len <= 1e-12) continue;
    dx /= len; dy /= len;
    const axisMid = useUp ? (Q[j0] + Q[j1]) * 0.5 : (P[j0] + P[j1]) * 0.5;
    let found = -1;
    for (let c = 0; c < cLen.length; c++) {
      if (Math.abs(cDx[c]*dx + cDy[c]*dy) < COS_TOL) continue;
      if (Math.abs((cDx[c]*Q[j0] - cDy[c]*P[j0]) - cOff[c]) > offTol) continue;
      found = c; break;
    }
    if (found < 0) {
      if (cLen.length >= MAX_CLUSTERS) continue;
      cDx.push(dx); cDy.push(dy); cOff.push(dx*Q[j0] - dy*P[j0]);
      cLen.push(0); cAxis.push(0);
      found = cLen.length - 1;
    }
    cLen[found] += len; cAxis[found] += axisMid * len;
  }
  if (cLen.length === 0) return null;

  // Score = position + orientation - length.
  //
  // Position alone cannot find a slanted bottom edge (it necessarily spans a
  // wide range along the axis), and length alone picks the same globally longest
  // edge for all four sides. But position-vs-length ALONE fails on any face
  // taller than it is wide: on a 2-triangle strip the vertical side really is
  // the longest cluster, so it wins 'bottom' outright and the face's whole UV
  // map turns 90 degrees. On a real part that was 49% of wall area.
  //
  // The orientation term is what separates them: an edge that qualifies as the
  // "bottom" runs ACROSS the axis, so its direction has little component ALONG
  // it — 0 for a horizontal edge, 0.42 for one slanted 25 degrees, 1.0 for a
  // vertical one. Position is weighted double so a long edge higher up cannot
  // outbid a shorter edge actually at the bottom.
  let maxLen = 1e-9;
  for (const L of cLen) if (L > maxLen) maxLen = L;
  let best = Infinity, bDx = 0, bDy = 0, bLen = -1;
  for (let c = 0; c < cLen.length; c++) {
    const mean = cAxis[c] / cLen[c];
    const dist = wantMax ? (axisMax - mean) : (mean - axisMin);
    const alongAxis = useUp ? Math.abs(cDy[c]) : Math.abs(cDx[c]);
    const sc = 2 * (dist / span) + alongAxis - (cLen[c] / maxLen);
    if (sc < best) { best = sc; bDx = cDx[c]; bDy = cDy[c]; bLen = cLen[c]; }
  }
  if (bLen <= 1e-9) return null;

  // Back to 3D. rt/up are orthonormal and in-plane, so U needs no re-projection.
  let Ux = bDx*pX + bDy*qX, Uy = bDx*pY + bDy*qY, Uz = bDx*pZ + bDy*qZ;
  const l = Math.hypot(Ux, Uy, Uz) || 1; Ux /= l; Uy /= l; Uz /= l;
  // Keep U consistent with the reference axis so the texture is not mirrored
  // between neighbouring faces.
  const refX = useUp ? R.rtX : R.upX, refY = useUp ? R.rtY : R.upY, refZ = useUp ? R.rtZ : R.upZ;
  if (Ux*refX + Uy*refY + Uz*refZ < 0) { Ux = -Ux; Uy = -Uy; Uz = -Uz; }
  return { x: Ux, y: Uy, z: Uz };
}

/**
 * @param {THREE.BufferGeometry} geometry non-indexed
 * @param {number} flatAngleDeg max dihedral to join a flat region
 * @param {{x,y,z}} originMin bounds.min — UVs are measured relative to it
 * @param {'bottom'|'top'|'left'|'right'} side edge to align to
 * @returns {Float32Array} 6 floats per corner: Ux,Uy,Uz,u0,v0,0
 */
export function computeFaceFrames(geometry, flatAngleDeg, originMin, side = 'bottom', diagOut = null) {
  const posAttr  = geometry.attributes.position;
  const nCorner  = posAttr.count;
  const triCount = (nCorner / 3) | 0;
  const out = new Float32Array(nCorner * FRAME_STRIDE);
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

  // Slivers left over from CAD tessellation form their own MICRO-REGIONS inside
  // an otherwise flat face — their normals differ just enough to fail the
  // flatness test. Each would then get its own frame, and above all its own
  // ORIGIN, so the texture jumps across that one triangle and displacement
  // spikes there. It shows as speckled tears scattered over a face.
  //
  // The remeshed path never shows it because it replaces a face's interior
  // outright, leaving one region. The Delaunay flip path only RECONNECTS the
  // existing vertices, so every CAD sliver survives and keeps its micro-region —
  // which is why the spikes appeared there and not under remesh.
  //
  // A sliver has no meaningful edge to align to anyway, so give it its
  // neighbour's frame: reassign any small region to its largest near-coplanar
  // neighbour. Genuine small faces (a chamfer, a step) have normals far from
  // their neighbours' and are left alone.
  if (!(typeof process !== 'undefined' && process.env && process.env.NO_SLIVER_MERGE)) {
    const rArea = new Float64Array(rNX.length);
    for (let t = 0; t < triCount; t++) if (regionId[t] >= 0) rArea[regionId[t]] += tArea[t];
    // adjacency: for each region, the largest near-coplanar neighbour
    const bestNb = new Int32Array(rNX.length).fill(-1);
    const bestA  = new Float64Array(rNX.length);
    const COS_MERGE = Math.cos(20 * Math.PI / 180);
    for (let t = 0; t < triCount; t++) {
      const r = regionId[t]; if (r < 0) continue;
      const b = t*3, vv = [triV[b], triV[b+1], triV[b+2]];
      for (let e = 0; e < 3; e++) {
        const nb = otherTri(t, vv[e], vv[(e+1)%3]);
        if (nb < 0) continue;
        const r2 = regionId[nb];
        if (r2 < 0 || r2 === r) continue;
        if (rNX[r]*rNX[r2] + rNY[r]*rNY[r2] + rNZ[r]*rNZ[r2] < COS_MERGE) continue;
        if (rArea[r2] > bestA[r]) { bestA[r] = rArea[r2]; bestNb[r] = r2; }
      }
    }
    const remap = new Int32Array(rNX.length);
    for (let r = 0; r < rNX.length; r++) remap[r] = r;
    const order2 = Array.from({length: rNX.length}, (_, r) => r)
      .sort((a, b) => rArea[a] - rArea[b]);
    for (const r of order2) {
      const nb = bestNb[r];
      if (nb < 0) continue;
      if (rArea[nb] < rArea[r] * 20) continue;    // only absorb into a much larger face
      let root = nb, guard = 0;
      while (remap[root] !== root && guard++ < 64) root = remap[root];
      if (root !== r) remap[r] = root;
    }
    let merged = 0;
    for (let t = 0; t < triCount; t++) {
      const r = regionId[t]; if (r < 0) continue;
      let root = r, guard = 0;
      while (remap[root] !== root && guard++ < 64) root = remap[root];
      if (root !== r) { regionId[t] = root; merged++; }
    }
    if (typeof process !== 'undefined' && process.env && process.env.REMESH_DEBUG) {
      console.log(`[faceFrame] merged ${merged} sliver triangles into larger coplanar faces`);
    }
  }

  if (typeof process !== 'undefined' && process.env && process.env.REMESH_DEBUG) {
    let un = 0; for (let t = 0; t < triCount; t++) if (regionId[t] < 0) un++;
    const ra = new Float64Array(rNX.length);
    for (let t = 0; t < triCount; t++) if (regionId[t] >= 0) ra[regionId[t]] += tArea[t];
    const sorted = [...ra].sort((a,b)=>b-a);
    const tiny = sorted.filter(a=>a<0.01).length, small = sorted.filter(a=>a<0.5).length;
    console.log(`[faceFrame] ${triCount} tris, ${rNX.length} regions, ${un} unassigned; ` +
      `areas: largest ${sorted[0].toFixed(1)}, <0.5mm2 ${small}, <0.01mm2 ${tiny}`);
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

  const _rArea = new Float64Array(nR), _rTris = new Int32Array(nR);
  if (diagOut) for (let t = 0; t < triCount; t++) {
    const r = regionId[t]; if (r >= 0) { _rArea[r] += tArea[t]; _rTris[r]++; }
  }

  // Per region: pick the aligning edge, build the frame, record the origin.
  const fUx = new Float64Array(nR), fUy = new Float64Array(nR), fUz = new Float64Array(nR);
  const fu0 = new Float64Array(nR), fv0 = new Float64Array(nR);
  for (let r = 0; r < nR; r++) {
    const R = referenceFrame(rNX[r], rNY[r], rNZ[r]);
    const useUp = (side === 'bottom' || side === 'top');
    const E = bEdges[r];
    const segs = new Float64Array(E.length * 3);
    for (let i = 0, o = 0; i < E.length; i += 2, o += 6) {
      const a = E[i], c = E[i+1];
      segs[o]   = vx[a]; segs[o+1] = vy[a]; segs[o+2] = vz[a];
      segs[o+3] = vx[c]; segs[o+4] = vy[c]; segs[o+5] = vz[c];
    }
    // U = the aligning edge's direction, so grid rows and texture run parallel
    // to it. Falls back to the reference frame's own axis when the face has no
    // usable edge there.
    const dir = chooseAlignedDir(segs, R, side);
    const Ux = dir ? dir.x : (useUp ? R.rtX : R.upX);
    const Uy = dir ? dir.y : (useUp ? R.rtY : R.upY);
    const Uz = dir ? dir.z : (useUp ? R.rtZ : R.upZ);
    fUx[r] = Ux; fUy[r] = Uy; fUz[r] = Uz;
    if (diagOut) diagOut.push({ region: r, normal: [rNX[r], rNY[r], rNZ[r]],
                                tris: _rTris[r], area: _rArea[r],
                                boundarySegs: E.length / 2,
                                U: [Ux, Uy, Uz], usedFallback: !dir });
  }

  // Origin: the face's minimum along its own U and V.
  const minU = new Float64Array(nR).fill(Infinity);
  const minV = new Float64Array(nR).fill(Infinity);
  const rPx = new Float64Array(nR), rPy = new Float64Array(nR), rPz = new Float64Array(nR);
  const rHasP = new Uint8Array(nR);
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t]; if (r < 0) continue;
    if (!rHasP[r]) { const id0 = triV[t*3];
      rPx[r] = vx[id0]; rPy[r] = vy[id0]; rPz[r] = vz[id0]; rHasP[r] = 1; }
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

  // Regions on the SAME plane sharing the same axis are pieces of ONE face,
  // split by a window, a recess or a run of the flatness test. They have to
  // share an origin: measured per region, a wall broken by openings handed each
  // piece its own u0,v0, so the pattern restarted at every piece instead of
  // continuing across the wall — and since the remesh lattice takes its phase
  // from u0,v0, the pieces' grids were offset from each other too. On the test
  // part the outermost front plane alone carried four different origins.
  {
    const gk = new Array(nR), gmin = new Map();
    for (let r = 0; r < nR; r++) {
      const off = rPx[r]*rNX[r] + rPy[r]*rNY[r] + rPz[r]*rNZ[r];
      const k = [rNX[r], rNY[r], rNZ[r], fUx[r], fUy[r], fUz[r], off]
        .map(x => Math.round(x * 1e3)).join(',');
      gk[r] = k;
      const g = gmin.get(k);
      if (!g) gmin.set(k, { u: fu0[r], v: fv0[r] });
      else { if (fu0[r] < g.u) g.u = fu0[r]; if (fv0[r] < g.v) g.v = fv0[r]; }
    }
    for (let r = 0; r < nR; r++) { const g = gmin.get(gk[r]); fu0[r] = g.u; fv0[r] = g.v; }
  }
  if (diagOut) for (const d of diagOut) { d.u0 = fu0[d.region]; d.v0 = fv0[d.region]; }

  // V is emitted alongside U rather than left to the consumer. Recomputing it as
  // (per-vertex normal x U) made the two texture axes structurally different: u
  // came from a CONSTANT per-face axis while v inherited every wobble of the
  // per-vertex normal, so one direction of the pattern could be stable while the
  // other was not — for no reason the face itself can explain. Both axes now come
  // from the same per-face frame.
  for (let t = 0; t < triCount; t++) {
    const r = regionId[t];
    const Ux = r >= 0 ? fUx[r] : 1, Uy = r >= 0 ? fUy[r] : 0, Uz = r >= 0 ? fUz[r] : 0;
    const u0 = r >= 0 ? fu0[r] : 0, v0 = r >= 0 ? fv0[r] : 0;
    const nx = r >= 0 ? rNX[r] : 0, ny = r >= 0 ? rNY[r] : 0, nz = r >= 0 ? rNZ[r] : 1;
    let Vx = ny*Uz - nz*Uy, Vy = nz*Ux - nx*Uz, Vz = nx*Uy - ny*Ux;
    const vl = Math.hypot(Vx, Vy, Vz) || 1; Vx /= vl; Vy /= vl; Vz /= vl;
    for (let k = 0; k < 3; k++) {
      const o = (t*3+k)*FRAME_STRIDE;
      out[o]   = Ux; out[o+1] = Uy; out[o+2] = Uz;
      out[o+3] = Vx; out[o+4] = Vy; out[o+5] = Vz;
      out[o+6] = u0; out[o+7] = v0;
    }
  }
  return out;
}
