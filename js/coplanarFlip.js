/**
 * coplanarFlip.js — per-face Delaunay re-triangulation of flat textured
 * regions, via Lawson edge-flipping run to convergence inside each region.
 *
 * THE PROBLEM: CAD tessellators (Fusion 360) triangulate flat faces as fans of
 * long thin slivers. Edge-length subdivision only BISECTS long edges — it never
 * re-orients triangles — so a flat face stays anisotropic at any density: every
 * child inherits the sliver's long-axis direction. Displacement then samples
 * the texture along those strips, producing creases / jagged tear lines that
 * follow the original slivers instead of the face.
 *
 * THE FIX: on a flat patch, any interior edge shared by two triangles can be
 * flipped to the quad's other diagonal WITHOUT changing the surface — the four
 * vertices are coplanar, so both diagonals span the exact same plane. Flipping
 * every non-Delaunay edge to convergence yields the (constrained) Delaunay
 * triangulation of that face's vertices — provably identical to discarding the
 * CAD triangulation and re-meshing the same points from scratch — which
 * maximises the minimum angle and removes the sliver grain. Vertices never
 * move, so geometry and watertightness are preserved exactly. Must run on the
 * flat (undisplaced) mesh, before displacement.
 *
 * WHY REGIONS (not per-edge normals): a single sliver triangle has a
 * numerically unstable normal, so a per-edge "are these two triangles within 1°"
 * test wrongly rejects flips between two slivers on a genuinely flat face,
 * leaving jagged strips behind. Instead we flood-fill flat regions using an
 * AREA-WEIGHTED plane (slivers contribute ~nothing, big triangles dominate →
 * stable), then flip freely inside each region. Region boundaries — edges shared
 * with a different plane, a masked/untextured face, or an open edge — are never
 * flipped, so each face stays watertight against its neighbours.
 *
 * Grain (opts.grain): 'even' = Delaunay (well-shaped, no preferred direction).
 * 'along' / 'across' bias the kept diagonal parallel / perpendicular to a world
 * reference direction (opts.axisDir, default −Z) projected onto the face, so the
 * triangle grain follows / crosses that axis. Region planes (stable) drive the
 * projection. NOTE: directional modes trade away Delaunay quality and can
 * reintroduce thin triangles; 'even' is the recommended default.
 *
 * @param {THREE.BufferGeometry} geometry  non-indexed; position (+ optional
 *                                          excludeWeight) attributes
 * @param {object} [opts]
 *   flatAngleDeg  max dihedral (vs the region plane) to join a region (default 1)
 *   maxPasses     per-region Lawson sweep cap (default 50; converges early)
 *   grain         'even' | 'along' | 'across'   (default 'even')
 *   axisDir       world reference direction for directional grain (default [0,0,-1])
 * @returns {THREE.BufferGeometry} new non-indexed geometry (position, normal,
 *   and excludeWeight if the input had it). Same vertex set, re-triangulated.
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5; // 10 µm weld — matches subdivision.js / displacement.js

export function flipCoplanarToDelaunay(geometry, opts = {}) {
  const flatAngleDeg = opts.flatAngleDeg ?? 1;
  const maxPasses    = opts.maxPasses ?? 50;
  const sinFlat      = Math.sin(flatAngleDeg * Math.PI / 180);
  const grain        = opts.grain || 'even';
  const axisDir      = opts.axisDir || [0, 0, -1];
  const ALIGN_EPS    = 1e-3;

  const posAttr  = geometry.attributes.position;
  const ewAttr   = geometry.attributes.excludeWeight || null;
  const triCount = (posAttr.count / 3) | 0;
  if (triCount < 2) return geometry;

  // ── Weld corners → unique vertices ─────────────────────────────────────────
  const nCorner = triCount * 3;
  const weld = new QuantizedPointMap(QUANT, Math.min(nCorner, 1 << 22));
  const triV = new Int32Array(nCorner);
  let nV = 0;
  for (let i = 0; i < nCorner; i++) {
    const id = weld.getOrSet(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), nV);
    if (weld.inserted) nV++;
    triV[i] = id;
  }
  const vx = new Float64Array(nV), vy = new Float64Array(nV), vz = new Float64Array(nV);
  const ewv = ewAttr ? new Float32Array(nV) : null;
  for (let i = 0; i < nCorner; i++) {
    const id = triV[i];
    vx[id] = posAttr.getX(i); vy[id] = posAttr.getY(i); vz[id] = posAttr.getZ(i);
    if (ewv) { const w = ewAttr.getX(i); if (w > ewv[id]) ewv[id] = w; }
  }

  // Masked triangles (any vertex untextured) are never flipped and never join a
  // region — so they and their shared borders stay byte-identical.
  const triMasked = new Uint8Array(triCount);
  if (ewv) {
    for (let t = 0; t < triCount; t++) {
      const b = t * 3;
      if (ewv[triV[b]] >= 0.5 || ewv[triV[b+1]] >= 0.5 || ewv[triV[b+2]] >= 0.5) triMasked[t] = 1;
    }
  }

  // ── Per-triangle raw normal (× area) — used only for region plane fitting ───
  const rnX = new Float64Array(triCount), rnY = new Float64Array(triCount), rnZ = new Float64Array(triCount);
  const tArea = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const b = t*3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    const e1x = vx[bb]-vx[a], e1y = vy[bb]-vy[a], e1z = vz[bb]-vz[a];
    const e2x = vx[c]-vx[a],  e2y = vy[c]-vy[a],  e2z = vz[c]-vz[a];
    const nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const twoA = Math.hypot(nx, ny, nz);       // = 2 × area
    tArea[t] = twoA * 0.5;
    rnX[t] = nx; rnY[t] = ny; rnZ[t] = nz;      // area-scaled normal (for weighting)
  }

  const apexOf = (t, u, v) => {
    const b = t * 3, a = triV[b], bb = triV[b+1], c = triV[b+2];
    if (a !== u && a !== v) return a;
    if (bb !== u && bb !== v) return bb;
    return c;
  };

  // ── Build triangle adjacency on the INPUT connectivity (for flood fill) ─────
  // Region membership is fixed on the input mesh: flips stay inside a region and
  // never change a triangle's region, so this is computed once.
  const triNbr = new Int32Array(triCount * 3).fill(-1);
  {
    const em = new QuantizedPointMap(1, Math.min(nCorner, 1 << 22));
    const eT0 = [], eT1 = [];
    for (let t = 0; t < triCount; t++) {
      const b = t*3, vv = [triV[b], triV[b+1], triV[b+2]];
      for (let e = 0; e < 3; e++) {
        const a = vv[e], c = vv[(e+1)%3], lo = a<c?a:c, hi = a<c?c:a;
        const slot = em.getOrSet(lo, hi, 0, eT0.length);
        if (em.inserted) { eT0.push(t); eT1.push(-1); }
        else if (eT1[slot] === -1) eT1[slot] = t;
        else eT1[slot] = -2; // non-manifold
      }
    }
    const push = (t, n) => { const b=t*3; for (let k=0;k<3;k++) if (triNbr[b+k]===-1){triNbr[b+k]=n;return;} };
    for (let s = 0; s < eT0.length; s++) {
      const t0 = eT0[s], t1 = eT1[s];
      if (t1 >= 0) { push(t0, t1); push(t1, t0); }
    }
  }

  // ── Flood-fill flat regions (area-weighted plane; robust to sliver noise) ───
  // regionN[r] = unit plane normal; regionId[t] = region of triangle t (or -1).
  const regionId = new Int32Array(triCount).fill(-1);
  const regionNX = [], regionNY = [], regionNZ = [];
  // Seed from largest-area triangles first so the initial plane is well-defined.
  const order = Array.from({ length: triCount }, (_, t) => t)
    .filter(t => !triMasked[t] && tArea[t] > 0)
    .sort((a, b) => tArea[b] - tArea[a]);

  const stack = [];
  for (const seed of order) {
    if (regionId[seed] !== -1) continue;
    const r = regionNX.length;
    // Accumulate an area-weighted normal; anchor the plane at the seed centroid.
    let ax = rnX[seed], ay = rnY[seed], az = rnZ[seed];         // = 2A·n, area-weighted
    let al = Math.hypot(ax, ay, az) || 1;
    let Nx = ax/al, Ny = ay/al, Nz = az/al;
    const sb = seed*3;
    const Ox = (vx[triV[sb]]+vx[triV[sb+1]]+vx[triV[sb+2]])/3;
    const Oy = (vy[triV[sb]]+vy[triV[sb+1]]+vy[triV[sb+2]])/3;
    const Oz = (vz[triV[sb]]+vz[triV[sb+1]]+vz[triV[sb+2]])/3;
    regionId[seed] = r;
    stack.length = 0; stack.push(seed);
    while (stack.length) {
      const t = stack.pop();
      const b = t*3;
      for (let k = 0; k < 3; k++) {
        const nb = triNbr[b+k];
        if (nb < 0 || regionId[nb] !== -1 || triMasked[nb]) continue;
        // Same winding hemisphere as the region plane (guards folds).
        if (rnX[nb]*Nx + rnY[nb]*Ny + rnZ[nb]*Nz <= 0) continue;
        // Robust coplanarity: tilt of the neighbour's apex above the region
        // plane about their shared edge = asin(|perp| / |apex→edge line|).
        // Uses the neighbour's apex position (exact) against the STABLE region
        // normal — independent of the sliver's own noisy normal.
        // Find shared edge = the two verts nb has in common with t.
        const nbb = nb*3, N0 = triV[nbb], N1 = triV[nbb+1], N2 = triV[nbb+2];
        const T0 = triV[b], T1 = triV[b+1], T2 = triV[b+2];
        let su = -1, sv = -1;
        for (const x of [N0, N1, N2]) if (x===T0||x===T1||x===T2) { if (su<0) su = x; else sv = x; }
        if (sv < 0) continue;
        const w = apexOf(nb, su, sv);
        const dz = (vx[w]-Ox)*Nx + (vy[w]-Oy)*Ny + (vz[w]-Oz)*Nz; // perp dist to plane
        // distance from apex to the shared edge LINE (3D)
        let ex = vx[sv]-vx[su], ey = vy[sv]-vy[su], ez = vz[sv]-vz[su];
        const eL2 = ex*ex+ey*ey+ez*ez || 1;
        const wux = vx[w]-vx[su], wuy = vy[w]-vy[su], wuz = vz[w]-vz[su];
        const tt = (wux*ex+wuy*ey+wuz*ez)/eL2;
        const px = wux - tt*ex, py = wuy - tt*ey, pz = wuz - tt*ez;
        const d3 = Math.hypot(px, py, pz);
        const tilt = d3 > 1e-9 ? Math.abs(dz) / d3 : 0;         // = sin(dihedral)
        if (tilt > sinFlat) continue;
        // Join: assign, refine the area-weighted plane, recurse.
        regionId[nb] = r;
        ax += rnX[nb]; ay += rnY[nb]; az += rnZ[nb];
        al = Math.hypot(ax, ay, az) || 1;
        Nx = ax/al; Ny = ay/al; Nz = az/al;
        stack.push(nb);
      }
    }
    regionNX.push(Nx); regionNY.push(Ny); regionNZ.push(Nz);
  }

  // ── Lawson sweeps: flip non-Delaunay edges INSIDE each region to convergence ─
  const angleAt = (o, i, j) => {
    const ax=vx[i]-vx[o], ay=vy[i]-vy[o], az=vz[i]-vz[o];
    const bx=vx[j]-vx[o], by=vy[j]-vy[o], bz=vz[j]-vz[o];
    const la=Math.hypot(ax,ay,az), lb=Math.hypot(bx,by,bz);
    if (la<1e-12||lb<1e-12) return 0;
    let c=(ax*bx+ay*by+az*bz)/(la*lb); c=c<-1?-1:c>1?1:c;
    return Math.acos(c);
  };
  const setTri = (t, i, j, k, nrx, nry, nrz) => {
    const e1x=vx[j]-vx[i], e1y=vy[j]-vy[i], e1z=vz[j]-vz[i];
    const e2x=vx[k]-vx[i], e2y=vy[k]-vy[i], e2z=vz[k]-vz[i];
    const cx=e1y*e2z-e1z*e2y, cy=e1z*e2x-e1x*e2z, cz=e1x*e2y-e1y*e2x;
    const b=t*3;
    if (cx*nrx+cy*nry+cz*nrz < 0) { const tmp=j; j=k; k=tmp; }
    triV[b]=i; triV[b+1]=j; triV[b+2]=k;
  };

  let totalFlips = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    // Rebuild edge adjacency from the CURRENT connectivity (flips change it).
    const em = new QuantizedPointMap(1, Math.min(nCorner, 1 << 22));
    const eT0 = [], eT1 = [];
    for (let t = 0; t < triCount; t++) {
      if (regionId[t] < 0) continue;
      const b = t*3, vv = [triV[b], triV[b+1], triV[b+2]];
      for (let e = 0; e < 3; e++) {
        const a = vv[e], c = vv[(e+1)%3], lo=a<c?a:c, hi=a<c?c:a;
        const slot = em.getOrSet(lo, hi, 0, eT0.length);
        if (em.inserted) { eT0.push(t); eT1.push(-1); }
        else if (eT1[slot] === -1) eT1[slot] = t;
        else eT1[slot] = -2;
      }
    }

    const touched = new Uint8Array(triCount);
    let flips = 0;
    for (let s = 0; s < eT0.length; s++) {
      const t0 = eT0[s], t1 = eT1[s];
      if (t1 < 0) continue;
      const r = regionId[t0];
      if (r < 0 || regionId[t1] !== r) continue;   // boundary of a flat region
      if (touched[t0] || touched[t1]) continue;

      // Shared edge (u,v) and apexes pv (t0), qv (t1).
      const A0=triV[t0*3], B0=triV[t0*3+1], C0=triV[t0*3+2];
      const A1=triV[t1*3], B1=triV[t1*3+1], C1=triV[t1*3+2];
      let u=-1, v=-1;
      for (const x of [A0,B0,C0]) if (x===A1||x===B1||x===C1){ if(u<0)u=x; else v=x; }
      if (v < 0) continue;
      const pv = apexOf(t0, u, v), qv = apexOf(t1, u, v);
      if (pv === qv) continue;

      // Stable region plane normal drives winding + directional projection.
      const nrx = regionNX[r], nry = regionNY[r], nrz = regionNZ[r];

      let want;
      if (grain === 'even') {
        want = angleAt(pv, u, v) + angleAt(qv, u, v) > Math.PI + 1e-6; // non-Delaunay
      } else {
        const an = axisDir[0]*nrx + axisDir[1]*nry + axisDir[2]*nrz;
        let dx = axisDir[0]-an*nrx, dy = axisDir[1]-an*nry, dz = axisDir[2]-an*nrz;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-6) {
          want = angleAt(pv, u, v) + angleAt(qv, u, v) > Math.PI + 1e-6;
        } else {
          dx/=dl; dy/=dl; dz/=dl;
          const align = (i,j) => {
            const ex=vx[j]-vx[i], ey=vy[j]-vy[i], ez=vz[j]-vz[i];
            const l = Math.hypot(ex,ey,ez) || 1;
            return Math.abs(ex*dx+ey*dy+ez*dz)/l;
          };
          const alCur = align(u, v), alAlt = align(pv, qv);
          want = grain === 'across' ? (alAlt < alCur - ALIGN_EPS) : (alAlt > alCur + ALIGN_EPS);
        }
      }
      if (!want) continue;

      // Convex crossing check in the region plane (2D basis e1 = u→v, e2 = n×e1).
      let e1x=vx[v]-vx[u], e1y=vy[v]-vy[u], e1z=vz[v]-vz[u];
      const el = Math.hypot(e1x,e1y,e1z) || 1; e1x/=el; e1y/=el; e1z/=el;
      const e2x=nry*e1z-nrz*e1y, e2y=nrz*e1x-nrx*e1z, e2z=nrx*e1y-nry*e1x;
      const PX=(i)=>(vx[i]-vx[u])*e1x+(vy[i]-vy[u])*e1y+(vz[i]-vz[u])*e1z;
      const PY=(i)=>(vx[i]-vx[u])*e2x+(vy[i]-vy[u])*e2y+(vz[i]-vz[u])*e2z;
      const ux=0,uy=0, vX=PX(v),vY=PY(v), pX=PX(pv),pY=PY(pv), qX=PX(qv),qY=PY(qv);
      const side=(ax,ay,bx,by,cx,cy)=>(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
      const s1=side(pX,pY,qX,qY,ux,uy), s2=side(pX,pY,qX,qY,vX,vY);
      const s3=side(ux,uy,vX,vY,pX,pY), s4=side(ux,uy,vX,vY,qX,qY);
      if (!(s1*s2 < 0 && s3*s4 < 0)) continue;

      setTri(t0, u, pv, qv, nrx, nry, nrz);
      setTri(t1, v, pv, qv, nrx, nry, nrz);
      touched[t0] = 1; touched[t1] = 1;
      flips++;
    }
    totalFlips += flips;
    if (flips === 0) break;
  }

  if (totalFlips === 0) return geometry;

  // ── Emit non-indexed geometry (positions unchanged; normals re-derived) ─────
  const outPos = new Float32Array(nCorner * 3);
  const outNrm = new Float32Array(nCorner * 3);
  const outEw  = ewv ? new Float32Array(nCorner) : null;
  for (let t = 0; t < triCount; t++) {
    const b = t*3, i = triV[b], j = triV[b+1], k = triV[b+2];
    const e1x=vx[j]-vx[i], e1y=vy[j]-vy[i], e1z=vz[j]-vz[i];
    const e2x=vx[k]-vx[i], e2y=vy[k]-vy[i], e2z=vz[k]-vz[i];
    let nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
    const len = Math.hypot(nx,ny,nz) || 1; nx/=len; ny/=len; nz/=len;
    const ids = [i, j, k];
    for (let c = 0; c < 3; c++) {
      const o = (b + c) * 3, id = ids[c];
      outPos[o]=vx[id]; outPos[o+1]=vy[id]; outPos[o+2]=vz[id];
      outNrm[o]=nx; outNrm[o+1]=ny; outNrm[o+2]=nz;
      if (outEw) outEw[b + c] = ewv[id];
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(outNrm, 3));
  if (outEw) out.setAttribute('excludeWeight', new THREE.BufferAttribute(outEw, 1));
  return out;
}
