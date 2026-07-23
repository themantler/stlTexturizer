/**
 * coplanarFlip.js — Delaunay edge-flipping restricted to coplanar (flat)
 * regions of the textured surface.
 *
 * THE PROBLEM: CAD tessellators (Fusion 360) triangulate flat faces as
 * "fans" of long thin slivers. Edge-length subdivision only BISECTS long
 * edges — it never re-orients triangles — so a flat face stays anisotropic no
 * matter how dense the mesh is: every child triangle inherits the sliver's
 * long-axis direction. Displacement then samples the texture along those
 * strips, producing visible tear lines that follow the original slivers
 * instead of the face.
 *
 * THE FIX: on a flat patch, any interior edge shared by two triangles can be
 * flipped to the quad's other diagonal WITHOUT changing the surface — the four
 * vertices are coplanar, so both diagonals span the exact same plane. Flipping
 * toward the Delaunay criterion (Lawson's angle-sum test) maximises the minimum
 * angle, yielding well-shaped, uniformly-oriented triangles that follow the
 * face. Vertices never move, so geometry and watertightness are preserved
 * exactly; this must run on the flat mesh BEFORE displacement.
 *
 * Scope guards (all required for a flip):
 *   • both triangles textured        (excludeWeight < 0.5) — masked / untextured
 *                                     faces are left byte-identical
 *   • coplanar                       (dihedral ≤ flatAngleDeg, default ~1°) —
 *                                     fillets, chamfers and curved surfaces are
 *                                     never touched
 *   • convex quad                    (the two diagonals actually cross) — a
 *                                     non-convex flip would overlap/invert
 *   • non-Delaunay                   (angle-sum > 180°) — guarantees the flip
 *                                     strictly improves quality, so passes
 *                                     converge and never oscillate
 *
 * @param {THREE.BufferGeometry} geometry  non-indexed; position (+ optional
 *                                          excludeWeight) attributes
 * @param {object} [opts]
 *   flatAngleDeg  max dihedral for "coplanar" (default 1)
 *   maxPasses     Lawson sweep cap (default 8)
 * @returns {THREE.BufferGeometry} new non-indexed geometry (position, normal,
 *   and excludeWeight if the input had it). Same vertex set, re-triangulated.
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5; // 10 µm weld — matches subdivision.js / displacement.js

export function flipCoplanarToDelaunay(geometry, opts = {}) {
  const flatAngleDeg = opts.flatAngleDeg ?? 1;
  const maxPasses    = opts.maxPasses ?? 8;
  const cosFlat      = Math.cos(flatAngleDeg * Math.PI / 180);
  // Grain control. 'even' = classic Delaunay (fattest triangles, no preferred
  // direction). 'along'/'across' = bias the kept diagonal to run parallel /
  // perpendicular to a world reference direction projected onto each face, so
  // the triangle "grain" follows (or crosses) that axis. axisDir defaults to
  // world −Z ("toward the lowest point on Z" → grain runs downhill).
  const grain    = opts.grain || 'even';
  const axisDir  = opts.axisDir || [0, 0, -1];
  const ALIGN_EPS = 1e-3;   // min alignment gain to accept a directional flip

  const posAttr  = geometry.attributes.position;
  const ewAttr   = geometry.attributes.excludeWeight || null;
  const triCount = (posAttr.count / 3) | 0;
  if (triCount < 2) return geometry;

  // ── Weld corners → unique vertices (positions are the ONLY thing flips must
  // preserve; normals are re-derived, excludeWeight carried per vertex) ───────
  const nCorner = triCount * 3;
  const weld = new QuantizedPointMap(QUANT, Math.min(nCorner, 1 << 22));
  const triV = new Int32Array(nCorner);      // corner → unique vertex id
  let nV = 0;
  for (let i = 0; i < nCorner; i++) {
    const id = weld.getOrSet(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), nV);
    if (weld.inserted) nV++;
    triV[i] = id;
  }
  const vx = new Float64Array(nV), vy = new Float64Array(nV), vz = new Float64Array(nV);
  const ewv = ewAttr ? new Float32Array(nV) : null; // max weight per vertex
  for (let i = 0; i < nCorner; i++) {
    const id = triV[i];
    vx[id] = posAttr.getX(i); vy[id] = posAttr.getY(i); vz[id] = posAttr.getZ(i);
    if (ewv) { const w = ewAttr.getX(i); if (w > ewv[id]) ewv[id] = w; }
  }

  // A triangle is "textured" (flippable) only if none of its verts are masked.
  const triMasked = new Uint8Array(triCount);
  if (ewv) {
    for (let t = 0; t < triCount; t++) {
      const b = t * 3;
      if (ewv[triV[b]] >= 0.5 || ewv[triV[b+1]] >= 0.5 || ewv[triV[b+2]] >= 0.5) triMasked[t] = 1;
    }
  }

  // Per-triangle unit normal (recomputed each pass — connectivity changes).
  const nX = new Float64Array(triCount), nY = new Float64Array(triCount), nZ = new Float64Array(triCount);
  const computeNormal = (t) => {
    const b = t * 3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    const e1x = vx[bb]-vx[a], e1y = vy[bb]-vy[a], e1z = vz[bb]-vz[a];
    const e2x = vx[c]-vx[a],  e2y = vy[c]-vy[a],  e2z = vz[c]-vz[a];
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nX[t] = nx/len; nY[t] = ny/len; nZ[t] = nz/len;
  };

  const apexOf = (t, u, v) => {          // the triangle vertex that is not u or v
    const b = t * 3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    if (a !== u && a !== v) return a;
    if (bb !== u && bb !== v) return bb;
    return c;
  };
  const angleAt = (o, i, j) => {         // angle ∠ i-o-j at vertex o
    const ax = vx[i]-vx[o], ay = vy[i]-vy[o], az = vz[i]-vz[o];
    const bx = vx[j]-vx[o], by = vy[j]-vy[o], bz = vz[j]-vz[o];
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
    if (la < 1e-12 || lb < 1e-12) return 0;
    let c = (ax*bx + ay*by + az*bz) / (la*lb);
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    return Math.acos(c);
  };

  // Set the connectivity of triangle t to (i,j,k), fixing winding so its normal
  // matches the reference plane normal (nrx,nry,nrz).
  const setTri = (t, i, j, k, nrx, nry, nrz) => {
    const e1x = vx[j]-vx[i], e1y = vy[j]-vy[i], e1z = vz[j]-vz[i];
    const e2x = vx[k]-vx[i], e2y = vy[k]-vy[i], e2z = vz[k]-vz[i];
    const cx = e1y*e2z - e1z*e2y, cy = e1z*e2x - e1x*e2z, cz = e1x*e2y - e1y*e2x;
    const b = t * 3;
    if (cx*nrx + cy*nry + cz*nrz < 0) { const tmp = j; j = k; k = tmp; }
    triV[b] = i; triV[b+1] = j; triV[b+2] = k;
  };

  // ── Lawson sweeps ──────────────────────────────────────────────────────────
  for (let t = 0; t < triCount; t++) if (!triMasked[t]) computeNormal(t);

  let totalFlips = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    // Edge → up-to-two incident triangle slots, keyed by (loVert, hiVert).
    const edgeMap = new QuantizedPointMap(1, Math.min(nCorner, 1 << 22));
    const edgeT0 = []; const edgeT1 = [];
    const addEdge = (a, b, t) => {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const slot = edgeMap.getOrSet(lo, hi, 0, edgeT0.length);
      if (edgeMap.inserted) { edgeT0.push(t); edgeT1.push(-1); }
      else if (edgeT1[slot] === -1) edgeT1[slot] = t;
      else edgeT1[slot] = -2; // non-manifold (>2 tris) → never flip
    };
    for (let t = 0; t < triCount; t++) {
      if (triMasked[t]) continue;
      const b = t*3, a = triV[b], bb = triV[b+1], c = triV[b+2];
      addEdge(a, bb, t); addEdge(bb, c, t); addEdge(c, a, t);
    }

    const touched = new Uint8Array(triCount);
    let flips = 0;
    for (let s = 0; s < edgeT0.length; s++) {
      const t0 = edgeT0[s], t1 = edgeT1[s];
      if (t1 < 0) continue;                              // boundary or non-manifold
      if (triMasked[t0] || triMasked[t1]) continue;      // one side untextured
      if (touched[t0] || touched[t1]) continue;          // already flipped this pass
      if (nX[t0]*nX[t1] + nY[t0]*nY[t1] + nZ[t0]*nZ[t1] < cosFlat) continue; // not coplanar

      // Shared edge (u,v) = the two vertices t0 and t1 have in common; the
      // apexes pv (in t0) and qv (in t1) are the remaining vertices.
      const A0 = triV[t0*3], B0 = triV[t0*3+1], C0 = triV[t0*3+2];
      const A1 = triV[t1*3], B1 = triV[t1*3+1], C1 = triV[t1*3+2];
      const shared = [];
      for (const x of [A0, B0, C0]) if (x === A1 || x === B1 || x === C1) shared.push(x);
      if (shared.length !== 2) continue;                 // defensive
      const u = shared[0], v = shared[1];
      const pv = apexOf(t0, u, v), qv = apexOf(t1, u, v);
      if (pv === qv) continue;

      const nrx = nX[t0], nry = nY[t0], nrz = nZ[t0];

      // Decide whether this edge should flip, per grain mode. The two candidate
      // shared diagonals are the current edge (u,v) and the alternative (pv,qv);
      // flipping keeps whichever this mode prefers.
      let want;
      if (grain === 'even') {
        // Delaunay (Lawson): flip iff the two apex angles sum to > 180°
        // (i.e. the current diagonal is non-Delaunay).
        want = angleAt(pv, u, v) + angleAt(qv, u, v) > Math.PI + 1e-6;
      } else {
        // Directional: project the world reference direction onto this face,
        // then keep the diagonal most parallel ('along') / perpendicular
        // ('across') to it, so the triangle grain follows / crosses the axis.
        const an = axisDir[0]*nrx + axisDir[1]*nry + axisDir[2]*nrz;
        let dx = axisDir[0]-an*nrx, dy = axisDir[1]-an*nry, dz = axisDir[2]-an*nrz;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-6) {
          // Face ≈ perpendicular to the axis → no in-plane direction; keep the
          // mesh well-shaped via Delaunay instead.
          want = angleAt(pv, u, v) + angleAt(qv, u, v) > Math.PI + 1e-6;
        } else {
          dx/=dl; dy/=dl; dz/=dl;
          const align = (i, j) => {                    // |cos| of diagonal vs d, 0..1
            const ex=vx[j]-vx[i], ey=vy[j]-vy[i], ez=vz[j]-vz[i];
            const l = Math.hypot(ex, ey, ez) || 1;
            return Math.abs(ex*dx + ey*dy + ez*dz) / l;
          };
          const alCur = align(u, v), alAlt = align(pv, qv);
          want = grain === 'across' ? (alAlt < alCur - ALIGN_EPS)
                                    : (alAlt > alCur + ALIGN_EPS);
        }
      }
      if (!want) continue;

      // Convex quad check: segments (u,v) and (pv,qv) must actually cross, i.e.
      // u,v lie on opposite sides of line pv-qv and vice-versa. Work in the
      // triangle plane via a 2D basis (e1 along u→v, e2 = n × e1).
      let e1x = vx[v]-vx[u], e1y = vy[v]-vy[u], e1z = vz[v]-vz[u];
      const el = Math.hypot(e1x, e1y, e1z) || 1; e1x/=el; e1y/=el; e1z/=el;
      const e2x = nry*e1z - nrz*e1y, e2y = nrz*e1x - nrx*e1z, e2z = nrx*e1y - nry*e1x;
      const px = (i) => (vx[i]-vx[u])*e1x + (vy[i]-vy[u])*e1y + (vz[i]-vz[u])*e1z;
      const py = (i) => (vx[i]-vx[u])*e2x + (vy[i]-vy[u])*e2y + (vz[i]-vz[u])*e2z;
      const ux=0, uy=0, vx2=px(v), vy2=py(v), pX=px(pv), pY=py(pv), qX=px(qv), qY=py(qv);
      const side = (ax,ay,bx,by,cx,cy) => (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
      const s1 = side(pX,pY,qX,qY, ux,uy),  s2 = side(pX,pY,qX,qY, vx2,vy2);
      const s3 = side(ux,uy,vx2,vy2, pX,pY), s4 = side(ux,uy,vx2,vy2, qX,qY);
      if (!(s1*s2 < 0 && s3*s4 < 0)) continue;           // not a convex crossing

      // Apply: retriangulate quad [u,pv,v,qv] along the (pv,qv) diagonal.
      setTri(t0, u, pv, qv, nrx, nry, nrz);
      setTri(t1, v, pv, qv, nrx, nry, nrz);
      computeNormal(t0); computeNormal(t1);
      touched[t0] = 1; touched[t1] = 1;
      flips++;
    }
    totalFlips += flips;
    if (flips === 0) break;
  }

  if (totalFlips === 0) return geometry; // nothing to do — hand back the input

  // ── Emit non-indexed geometry (positions unchanged; normals re-derived) ─────
  const outPos = new Float32Array(nCorner * 3);
  const outNrm = new Float32Array(nCorner * 3);
  const outEw  = ewv ? new Float32Array(nCorner) : null;
  for (let t = 0; t < triCount; t++) {
    const b = t*3, i = triV[b], j = triV[b+1], k = triV[b+2];
    const e1x = vx[j]-vx[i], e1y = vy[j]-vy[i], e1z = vz[j]-vz[i];
    const e2x = vx[k]-vx[i], e2y = vy[k]-vy[i], e2z = vz[k]-vz[i];
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.hypot(nx, ny, nz) || 1; nx/=len; ny/=len; nz/=len;
    const ids = [i, j, k];
    for (let c = 0; c < 3; c++) {
      const o = (b + c) * 3, id = ids[c];
      outPos[o] = vx[id]; outPos[o+1] = vy[id]; outPos[o+2] = vz[id];
      outNrm[o] = nx; outNrm[o+1] = ny; outNrm[o+2] = nz;
      if (outEw) outEw[b + c] = ewv[id];
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(outNrm, 3));
  if (outEw) out.setAttribute('excludeWeight', new THREE.BufferAttribute(outEw, 1));
  return out;
}
