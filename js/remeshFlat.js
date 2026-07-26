/**
 * remeshFlat.js — isotropic re-meshing of flat textured faces.
 *
 * WHY: edge-flipping only re-connects the vertices that are already there. CAD
 * tessellators fan triangles out from hole/cutout corners, so the vertices
 * themselves are distributed along those fan rays; the Delaunay triangulation of
 * that point set is still elongated along the fan, and the texture tears. The
 * only cure is to change the POINTS: throw away each flat face's interior fan
 * vertices, keep its exact boundary (outer rim + every hole / cutout loop, so it
 * stays watertight against the walls and neighbouring faces), and refill the
 * interior with a uniform triangle lattice at the resolution target. Boundary
 * vertices never move; interior points are new and belong only to that face.
 *
 * Runs on the flat (undisplaced) mesh, before displacement, in the export
 * worker. Non-flat and masked triangles pass through untouched.
 *
 * The heavy lifting is a constrained Delaunay triangulation (CDT) per face:
 * Bowyer-Watson over boundary+interior points, boundary-segment recovery by
 * flipping, then even-odd domain classification to drop hole / exterior
 * triangles.
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

const QUANT = 1e5;

// ───────────────────────── geometry predicates ──────────────────────────────
const orient2d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

// >0 when p is strictly inside the circumcircle of CCW triangle (a,b,c).
function inCircle(ax, ay, bx, by, cx, cy, px, py) {
  const adx = ax - px, ady = ay - py, bdx = bx - px, bdy = by - py, cdx = cx - px, cdy = cy - py;
  const ad = adx * adx + ady * ady, bd = bdx * bdx + bdy * bdy, cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx) > 0;
}

// Point-in-polygon (even-odd) over multiple loops; loops is [[x,y],...][].
function pointInLoops(x, y, loops) {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}

/**
 * Constrained Delaunay triangulation of 2D points.
 * @param {Array<[number,number]>} pts        all points (constraint verts first)
 * @param {Array<Array<number>>}   segs       constraint segments as [i,j] index pairs
 * @param {function}               inDomain   (cx,cy)=>bool centroid test (holes/exterior)
 * @returns {Array<[number,number,number]>} triangles (indices into pts), inside only
 */
export function cdt2d(pts, segs, inDomain) {
  const n = pts.length;
  if (n < 3) return [];

  // Super-triangle enclosing all points.
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
  const dx = maxx - minx || 1, dy = maxy - miny || 1, d = Math.max(dx, dy) * 1000;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const P = pts.slice();
  const s0 = P.length; P.push([cx - d, cy - d]);
  const s1 = P.length; P.push([cx + d, cy - d]);
  const s2 = P.length; P.push([cx, cy + d]);

  // Triangle store: flat arrays of vertex ids (CCW) + neighbour tri ids per edge.
  // edge e of a tri is opposite vertex e (edge e = verts (e+1)%3,(e+2)%3).
  const TV = [];   // [t*3+e] vertex id
  const TN = [];   // [t*3+e] neighbour tri across edge e (-1 = none)
  const dead = [];
  const px = (i) => P[i][0], py = (i) => P[i][1];
  const addTri = (a, b, c) => {
    if (orient2d(px(a), py(a), px(b), py(b), px(c), py(c)) < 0) { const t = b; b = c; c = t; }
    const id = TV.length / 3; TV.push(a, b, c); TN.push(-1, -1, -1); dead.push(0); return id;
  };
  const t0 = addTri(s0, s1, s2);
  TN[t0*3] = -1; TN[t0*3+1] = -1; TN[t0*3+2] = -1;

  const setNbr = (t, e, nt) => { if (t >= 0) TN[t*3+e] = nt; };
  const edgeIn = (t, a, b) => { // local edge index in t whose two verts are {a,b}
    for (let e = 0; e < 3; e++) { const u = TV[t*3+(e+1)%3], v = TV[t*3+(e+2)%3]; if ((u===a&&v===b)||(u===b&&v===a)) return e; }
    return -1;
  };
  const inTri = (t, x, y) => {
    const a = TV[t*3], b = TV[t*3+1], c = TV[t*3+2];
    const d0 = orient2d(px(a),py(a),px(b),py(b),x,y);
    const d1 = orient2d(px(b),py(b),px(c),py(c),x,y);
    const d2 = orient2d(px(c),py(c),px(a),py(a),x,y);
    return d0 >= -1e-9 && d1 >= -1e-9 && d2 >= -1e-9;
  };

  const inCirc = (t, x, y) => {
    const a = TV[t*3], b = TV[t*3+1], c = TV[t*3+2];
    return inCircle(px(a),py(a),px(b),py(b),px(c),py(c), x, y);
  };
  // Walk to the triangle containing (x,y), starting from a hint; falls back to
  // a linear scan if the walk stalls (e.g. after cavity churn).
  let hint = t0;
  const locate = (x, y) => {
    let t = (!dead[hint] ? hint : -1);
    if (t < 0) { for (let k = TV.length/3 - 1; k >= 0; k--) if (!dead[k]) { t = k; break; } }
    for (let steps = 0; t >= 0 && steps < TV.length; steps++) {
      let moved = false;
      for (let e = 0; e < 3; e++) {
        const u = TV[t*3+(e+1)%3], v = TV[t*3+(e+2)%3];
        if (orient2d(px(u),py(u),px(v),py(v), x, y) < -1e-9) { const nt = TN[t*3+e]; if (nt >= 0 && !dead[nt]) { t = nt; moved = true; break; } }
      }
      if (!moved) return t;
    }
    for (let k = 0; k < TV.length/3; k++) if (!dead[k] && inTri(k, x, y)) return k;
    return -1;
  };

  // Bowyer-Watson insertion, cavity found by BFS from the containing triangle.
  for (let ip = 0; ip < n; ip++) {
    const x = px(ip), y = py(ip);
    const start = locate(x, y);
    if (start < 0) continue;
    hint = start;
    const bad = [];
    const seen = new Set([start]); const q = [start];
    while (q.length) {
      const t = q.pop();
      if (!inCirc(t, x, y) && t !== start) continue;
      bad.push(t);
      for (let e = 0; e < 3; e++) { const nt = TN[t*3+e]; if (nt >= 0 && !dead[nt] && !seen.has(nt)) { seen.add(nt); q.push(nt); } }
    }
    // Cavity boundary = edges of bad tris not shared with another bad tri.
    const badSet = new Set(bad);
    const poly = []; // {a,b, nbr}
    for (const t of bad) {
      for (let e = 0; e < 3; e++) {
        const nt = TN[t*3+e];
        if (nt === -1 || !badSet.has(nt)) {
          const a = TV[t*3+(e+1)%3], b = TV[t*3+(e+2)%3];
          poly.push({ a, b, nbr: nt });
        }
      }
    }
    for (const t of bad) dead[t] = 1;
    // Re-triangulate cavity fanning from p; record new tris and fix adjacency.
    const created = [];
    for (const { a, b, nbr } of poly) {
      const nt = addTri(ip, a, b);
      created.push({ t: nt, a, b, nbr });
    }
    // neighbour across (a,b) is the outside tri `nbr`; also link created tris to each other.
    for (const c of created) {
      const e = edgeIn(c.t, c.a, c.b); setNbr(c.t, e, c.nbr);
      if (c.nbr >= 0) { const en = edgeIn(c.nbr, c.a, c.b); setNbr(c.nbr, en, c.t); }
    }
    for (let i = 0; i < created.length; i++) {
      for (let j = i + 1; j < created.length; j++) {
        // share an edge if they have two verts in common (ip + one other)
        const A = created[i], B = created[j];
        let shared = -1;
        for (const v of [A.a, A.b]) if (v === B.a || v === B.b) shared = v;
        if (shared >= 0) {
          const eA = edgeIn(A.t, ip, shared), eB = edgeIn(B.t, ip, shared);
          if (eA >= 0 && eB >= 0) { setNbr(A.t, eA, B.t); setNbr(B.t, eB, A.t); }
        }
      }
    }
    if (created.length) hint = created[0].t; // keep the walk hint on a live triangle
  }

  // Constraint recovery: ensure each segment is an edge; flip crossing edges.
  const hasEdge = (a, b) => {
    for (let t = 0; t < TV.length/3; t++) { if (dead[t]) continue; if (edgeIn(t, a, b) >= 0) { const e = edgeIn(t,a,b); const u=TV[t*3+(e+1)%3], v=TV[t*3+(e+2)%3]; if((u===a&&v===b)||(u===b&&v===a)) return true; } }
    return false;
  };
  for (const [a, b] of segs) {
    if (hasEdge(a, b)) continue;
    // Flip edges crossing segment a-b (bounded iterations).
    for (let iter = 0; iter < 1000 && !hasEdge(a, b); iter++) {
      let flipped = false;
      for (let t = 0; t < TV.length/3 && !flipped; t++) {
        if (dead[t]) continue;
        for (let e = 0; e < 3; e++) {
          const u = TV[t*3+(e+1)%3], v = TV[t*3+(e+2)%3];
          const nt = TN[t*3+e];
          if (nt < 0) continue;
          // does edge (u,v) properly cross segment (a,b)?
          if (u === a || u === b || v === a || v === b) continue;
          const o1 = orient2d(px(a),py(a),px(b),py(b),px(u),py(u));
          const o2 = orient2d(px(a),py(a),px(b),py(b),px(v),py(v));
          const o3 = orient2d(px(u),py(u),px(v),py(v),px(a),py(a));
          const o4 = orient2d(px(u),py(u),px(v),py(v),px(b),py(b));
          if (o1*o2 < 0 && o3*o4 < 0) {
            if (flipEdge(t, e)) { flipped = true; break; }
          }
        }
      }
      if (!flipped) break;
    }
  }

  function flipEdge(t, e) {
    const nt = TN[t*3+e]; if (nt < 0) return false;
    const u = TV[t*3+(e+1)%3], v = TV[t*3+(e+2)%3], p = TV[t*3+e];
    const en = edgeIn(nt, u, v); if (en < 0) return false;
    const q = TV[nt*3+en];
    // convex quad (p,u,q,v)? need p,q on opposite sides of u-v (given) and u,v opposite sides of p-q
    if (orient2d(px(p),py(p),px(q),py(q),px(u),py(u)) * orient2d(px(p),py(p),px(q),py(q),px(v),py(v)) >= 0) return false;
    // neighbours around the quad
    const nUp = TN[t*3+edgeIn(t, p, u)], nPv = TN[t*3+edgeIn(t, p, v)];
    const nUq = TN[nt*3+edgeIn(nt, q, u)], nQv = TN[nt*3+edgeIn(nt, q, v)];
    // rebuild the two triangles along diagonal p-q
    dead[t] = 1; dead[nt] = 1;
    const a1 = addTri(p, u, q), a2 = addTri(p, q, v);
    const link = (tt, x, y, nb) => { const ee = edgeIn(tt, x, y); if (ee>=0){ setNbr(tt, ee, nb); if (nb>=0){ const e2=edgeIn(nb,x,y); if(e2>=0) setNbr(nb,e2,tt);} } };
    link(a1, p, u, nUp); link(a1, u, q, nUq); link(a1, p, q, a2);
    link(a2, p, q, a1); link(a2, q, v, nQv); link(a2, p, v, nPv);
    return true;
  }

  // Collect live triangles inside the domain, excluding any touching super verts.
  const out = [];
  for (let t = 0; t < TV.length/3; t++) {
    if (dead[t]) continue;
    const a = TV[t*3], b = TV[t*3+1], c = TV[t*3+2];
    if (a >= s0 || b >= s0 || c >= s0) continue;
    const gx = (px(a)+px(b)+px(c))/3, gy = (py(a)+py(b)+py(c))/3;
    if (inDomain(gx, gy)) out.push([a, b, c]);
  }
  return out;
}

// ───────────────────────── per-face isotropic remesh ────────────────────────
/**
 * Re-mesh flat textured faces with a uniform triangle lattice.
 *
 * Lattice spacing is targetLen × LATTICE_FACTOR. The factor exists because
 * subdivision splits any edge LONGER than the resolution target, leaving edges
 * distributed in [0.5, 1.0] × target (mean ≈ 0.75), whereas a lattice at
 * spacing h has edges of exactly h. Using h = target directly therefore
 * produced a visibly coarser face (~2× fewer triangles, lower texture detail)
 * than the flip path at the same slider value, and its boundary-fan edges could
 * even exceed the target. 0.7 matches subdivision's effective density and keeps
 * every edge under the target.
 *
 * @param {THREE.BufferGeometry} geometry  non-indexed; position (+ excludeWeight)
 * @param {object} [opts]
 *   targetLen     resolution target (default 1 = refineLength)
 *   flatAngleDeg  max dihedral to join a flat region (default 1)
 *   faceParentId  Int32Array per input triangle → original face id. When given,
 *                 each new lattice triangle inherits the parent of whichever
 *                 original region triangle contains its centroid, so bake's
 *                 parent map (exclusions, per-body mapping, painting adjacency)
 *                 survives the rebuild.
 * @returns {{geometry: THREE.BufferGeometry, faceParentId: Int32Array|null}}
 *   Flat faces re-meshed uniformly; everything else passed through unchanged.
 */
const LATTICE_FACTOR = 0.7;
// Backs off the density derived from the input region (see hEquiv below).
// Larger = coarser; 1.0 = reproduce the input region's triangle density exactly.
// Kept at 1.0: a 1.5 temper was calibrated on a synthetic fan and came out ~2×
// coarser than the flip path on real CAD parts (356k vs 1.46M triangles), which
// read as a "smudged"/over-blurred texture. Parity with the mesh the remesh
// receives is the right target — same sampling density, uniform orientation.
const DENSITY_TEMPER = 1.0;

export function remeshFlatRegions(geometry, opts = {}) {
  const targetLen    = opts.targetLen ?? 1;
  const flatAngleDeg = opts.flatAngleDeg ?? 1;
  const sinFlat      = Math.sin(flatAngleDeg * Math.PI / 180);
  const parentIn     = opts.faceParentId || null;

  const posAttr  = geometry.attributes.position;
  const ewAttr   = geometry.attributes.excludeWeight || null;
  const triCount = (posAttr.count / 3) | 0;
  if (triCount < 2) return { geometry, faceParentId: parentIn };

  // Weld corners → unique vertices.
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

  const triMasked = new Uint8Array(triCount);
  if (ewv) for (let t = 0; t < triCount; t++) {
    const b = t*3;
    if (ewv[triV[b]] >= 0.5 || ewv[triV[b+1]] >= 0.5 || ewv[triV[b+2]] >= 0.5) triMasked[t] = 1;
  }

  const rnX = new Float64Array(triCount), rnY = new Float64Array(triCount), rnZ = new Float64Array(triCount);
  const tArea = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const b=t*3, a=triV[b], bb=triV[b+1], c=triV[b+2];
    const e1x=vx[bb]-vx[a], e1y=vy[bb]-vy[a], e1z=vz[bb]-vz[a];
    const e2x=vx[c]-vx[a],  e2y=vy[c]-vy[a],  e2z=vz[c]-vz[a];
    const nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
    tArea[t]=Math.hypot(nx,ny,nz)*0.5; rnX[t]=nx; rnY[t]=ny; rnZ[t]=nz;
  }

  // Edge → up to two triangles (welded vertex pair) for adjacency + boundaries.
  const em = new QuantizedPointMap(1, Math.min(nCorner, 1 << 22));
  const eT0 = [], eT1 = [];
  const edgeSlot = (a, b) => { const lo=a<b?a:b, hi=a<b?b:a; return em.get(lo, hi, 0); };
  for (let t = 0; t < triCount; t++) {
    const b=t*3, vv=[triV[b],triV[b+1],triV[b+2]];
    for (let e=0;e<3;e++){ const a=vv[e], c=vv[(e+1)%3], lo=a<c?a:c, hi=a<c?c:a;
      const slot=em.getOrSet(lo,hi,0,eT0.length);
      if (em.inserted){eT0.push(t);eT1.push(-1);} else if(eT1[slot]===-1)eT1[slot]=t; else eT1[slot]=-2; }
  }
  const otherTri = (t, a, b) => { const s=edgeSlot(a,b); if(s<0)return -1; const x=eT0[s],y=eT1[s]; if(y===-2)return -2; return x===t?y:x; };

  // Flood-fill flat regions (area-weighted plane; robust apex-tilt test).
  const apexOf = (t,u,v)=>{const b=t*3,a=triV[b],bb=triV[b+1],c=triV[b+2]; if(a!==u&&a!==v)return a; if(bb!==u&&bb!==v)return bb; return c;};
  const regionId = new Int32Array(triCount).fill(-1);
  const regionNX=[], regionNY=[], regionNZ=[];
  const order = Array.from({length:triCount},(_,t)=>t).filter(t=>!triMasked[t]&&tArea[t]>0).sort((a,b)=>tArea[b]-tArea[a]);
  const stack=[];
  for (const seed of order) {
    if (regionId[seed]!==-1) continue;
    const r=regionNX.length;
    let ax=rnX[seed],ay=rnY[seed],az=rnZ[seed]; let al=Math.hypot(ax,ay,az)||1;
    let Nx=ax/al,Ny=ay/al,Nz=az/al;
    const sb=seed*3;
    const Ox=(vx[triV[sb]]+vx[triV[sb+1]]+vx[triV[sb+2]])/3, Oy=(vy[triV[sb]]+vy[triV[sb+1]]+vy[triV[sb+2]])/3, Oz=(vz[triV[sb]]+vz[triV[sb+1]]+vz[triV[sb+2]])/3;
    regionId[seed]=r; stack.length=0; stack.push(seed);
    while(stack.length){ const t=stack.pop(); const b=t*3; const vv=[triV[b],triV[b+1],triV[b+2]];
      for(let e=0;e<3;e++){ const a=vv[e], c=vv[(e+1)%3]; const nb=otherTri(t,a,c);
        if(nb<0||regionId[nb]!==-1||triMasked[nb]) continue;
        if(rnX[nb]*Nx+rnY[nb]*Ny+rnZ[nb]*Nz<=0) continue;
        const w=apexOf(nb,a,c);
        const dz=(vx[w]-Ox)*Nx+(vy[w]-Oy)*Ny+(vz[w]-Oz)*Nz;
        let ex=vx[c]-vx[a],ey=vy[c]-vy[a],ez=vz[c]-vz[a]; const eL2=ex*ex+ey*ey+ez*ez||1;
        const wux=vx[w]-vx[a],wuy=vy[w]-vy[a],wuz=vz[w]-vz[a]; const tt=(wux*ex+wuy*ey+wuz*ez)/eL2;
        const pxx=wux-tt*ex,pyy=wuy-tt*ey,pzz=wuz-tt*ez; const d3=Math.hypot(pxx,pyy,pzz);
        const tilt=d3>1e-9?Math.abs(dz)/d3:0;
        if(tilt>sinFlat) continue;
        regionId[nb]=r; ax+=rnX[nb];ay+=rnY[nb];az+=rnZ[nb]; al=Math.hypot(ax,ay,az)||1; Nx=ax/al;Ny=ay/al;Nz=az/al; stack.push(nb);
      }
    }
    regionNX.push(Nx);regionNY.push(Ny);regionNZ.push(Nz);
  }

  // Triangle lists per region (avoids O(triCount·regions) re-scans below).
  const regionTris = Array.from({ length: regionNX.length }, () => []);
  for (let t = 0; t < triCount; t++) if (regionId[t] >= 0) regionTris[regionId[t]].push(t);

  // Output accumulators.
  const outP=[], outN=[], outW=[], outParent=[];
  const remeshed = new Uint8Array(regionNX.length);
  const pushTri=(p0,p1,p2,w0,w1,w2,par)=>{
    const e1x=p1[0]-p0[0],e1y=p1[1]-p0[1],e1z=p1[2]-p0[2], e2x=p2[0]-p0[0],e2y=p2[1]-p0[1],e2z=p2[2]-p0[2];
    let nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x; const l=Math.hypot(nx,ny,nz)||1; nx/=l;ny/=l;nz/=l;
    outP.push(p0[0],p0[1],p0[2],p1[0],p1[1],p1[2],p2[0],p2[1],p2[2]);
    outN.push(nx,ny,nz,nx,ny,nz,nx,ny,nz);
    if(ewv) outW.push(w0,w1,w2);
    if(parentIn) outParent.push(par|0);
  };

  for (let r = 0; r < regionNX.length; r++) {
    const Nx=regionNX[r],Ny=regionNY[r],Nz=regionNZ[r];
    // Directed boundary edges (region on the left).
    const nextV = new Map(); let ok = true; let count = 0;
    for (const t of regionTris[r]){ if(!ok) break;
      const b=t*3, vv=[triV[b],triV[b+1],triV[b+2]];
      for(let e=0;e<3;e++){ const a=vv[e], c=vv[(e+1)%3]; const nb=otherTri(t,a,c);
        if(nb>=0 && regionId[nb]===r) continue;
        if(nextV.has(a)){ ok=false; break; }
        nextV.set(a,c); count++;
      }
    }
    if(!ok || count<3) continue;
    const loops=[]; const visited=new Set();
    for(const startV of nextV.keys()){
      if(visited.has(startV)) continue;
      const loop=[]; let v=startV; let guard=0; let closed=false;
      while(guard++<count+2){ if(visited.has(v)){ closed=(v===startV); break; } visited.add(v); loop.push(v); const nx=nextV.get(v); if(nx===undefined) break; v=nx; }
      if(closed && loop.length>=3) loops.push(loop);
    }
    if(loops.length===0) continue;

    let axv=1,ayv=0,azv=0; if(Math.abs(Nx)>0.9){axv=0;ayv=1;azv=0;}
    const adot=axv*Nx+ayv*Ny+azv*Nz; let e1x=axv-adot*Nx,e1y=ayv-adot*Ny,e1z=azv-adot*Nz;
    const e1l=Math.hypot(e1x,e1y,e1z)||1; e1x/=e1l;e1y/=e1l;e1z/=e1l;
    const e2x=Ny*e1z-Nz*e1y, e2y=Nz*e1x-Nx*e1z, e2z=Nx*e1y-Ny*e1x;
    const O0=loops[0][0]; const Ox=vx[O0],Oy=vy[O0],Oz=vz[O0];
    const proj=(vid)=>[ (vx[vid]-Ox)*e1x+(vy[vid]-Oy)*e1y+(vz[vid]-Oz)*e1z, (vx[vid]-Ox)*e2x+(vy[vid]-Oy)*e2y+(vz[vid]-Oz)*e2z ];

    // ptW = per-point exclusion weight. Boundary points KEEP their original
    // weight so a mask falloff gradient that runs into this face survives the
    // rebuild (hardcoding 0 flattened the gradient and hardened the perimeter
    // into a visible jagged seam); new interior points are fully textured (0).
    const pts2d=[]; const pt3d=[]; const ptW=[]; const vidToIdx=new Map();
    const loops2d=[]; const segs=[];
    for(const loop of loops){
      const lp=[]; const idxs=[];
      for(const vid of loop){ let idx=vidToIdx.get(vid);
        if(idx===undefined){ idx=pts2d.length; vidToIdx.set(vid,idx); const p=proj(vid); pts2d.push(p); pt3d.push([vx[vid],vy[vid],vz[vid]]); ptW.push(ewv?ewv[vid]:0); }
        idxs.push(idx); lp.push(pts2d[idx]); }
      loops2d.push(lp);
      for(let i=0;i<idxs.length;i++) segs.push([idxs[i], idxs[(i+1)%idxs.length]]);
    }
    const inDom=(x,y)=>pointInLoops(x,y,loops2d);
    let mnx=Infinity,mny=Infinity,mxx=-Infinity,mxy=-Infinity;
    for(const [x,y] of pts2d){ if(x<mnx)mnx=x; if(y<mny)mny=y; if(x>mxx)mxx=x; if(y>mxy)mxy=y; }
    // Lattice spacing. Matching the RESOLUTION TARGET alone is not enough:
    // subdivision is adaptive, so in CAD fan regions it splits far below the
    // target (each sliver bisected repeatedly), leaving a much denser mesh than
    // target-sized triangles would give. A lattice at the target therefore
    // sampled the texture far more coarsely than the flip path (measured ~8×
    // fewer triangles on real parts) and looked visibly lower-resolution.
    //
    // So derive the spacing from this region's ACTUAL input density — the
    // equivalent lattice spacing for its mean triangle area — and use the
    // resolution target only as an upper bound. Over-refined fan regions keep
    // their sample density (same detail, now uniformly oriented); coarse regions
    // are still refined to the target.
    let regArea = 0;
    for (const t of regionTris[r]) regArea += tArea[t];
    const nReg = regionTris[r].length || 1;
    // hEquiv = lattice spacing that reproduces this region's input triangle
    // COUNT. Used raw it overshoots (~3× the flip path's final density, since
    // flip's regularize pass collapses slivers before its second subdivide), so
    // DENSITY_TEMPER backs it off to land just above parity with flip — the
    // density the user judged near-perfect — instead of tripling memory.
    const hEquiv = Math.sqrt(4 * (regArea / nReg) / Math.sqrt(3)) * DENSITY_TEMPER;
    const h=Math.max(Math.min(hEquiv, targetLen * LATTICE_FACTOR), 1e-6);
    const rowH=h*Math.sqrt(3)/2; const minGap=0.5*h;
    const distToBoundary=(x,y)=>{ let best=Infinity;
      for(const lp of loops2d){ for(let i=0,j=lp.length-1;i<lp.length;j=i++){
        const ax=lp[j][0],ay=lp[j][1],bx=lp[i][0],by=lp[i][1]; const dx=bx-ax,dy=by-ay; const L2=dx*dx+dy*dy||1;
        let tt=((x-ax)*dx+(y-ay)*dy)/L2; tt=tt<0?0:tt>1?1:tt; const px=ax+tt*dx,py=ay+tt*dy;
        const d=Math.hypot(x-px,y-py); if(d<best)best=d; } }
      return best; };
    let rowi=0;
    for(let y=mny+rowH; y<mxy; y+=rowH, rowi++){ const xoff=(rowi%2)*h/2;
      for(let x=mnx+xoff; x<mxx; x+=h){
        if(!inDom(x,y)) continue; if(distToBoundary(x,y)<minGap) continue;
        const jx=x+(Math.sin(x*12.9+y*78.2)*1e-6), jy=y+(Math.cos(x*39.3+y*11.1)*1e-6);
        pts2d.push([jx,jy]);
        pt3d.push([Ox+jx*e1x+jy*e2x, Oy+jx*e1y+jy*e2y, Oz+jx*e1z+jy*e2z]);
        ptW.push(0);
      }
    }

    let tris;
    try { tris = cdt2d(pts2d, segs, inDom); } catch(e) { tris=null; }
    if(!tris || tris.length===0) continue;

    // Parent inheritance: locate each new triangle's centroid among the region's
    // ORIGINAL triangles (projected to the same 2D basis) so bake keeps a valid
    // parent map. Bucketed on a uniform grid for speed; nearest-centroid
    // fallback covers points that miss every cell (numerical edge cases).
    let locate = null;
    if (parentIn) {
      const rTris = regionTris[r];
      const A = new Float64Array(rTris.length * 6);
      const cxs = new Float64Array(rTris.length), cys = new Float64Array(rTris.length);
      for (let k = 0; k < rTris.length; k++) {
        const b = rTris[k]*3;
        const P0=proj(triV[b]), P1=proj(triV[b+1]), P2=proj(triV[b+2]);
        A[k*6]=P0[0]; A[k*6+1]=P0[1]; A[k*6+2]=P1[0]; A[k*6+3]=P1[1]; A[k*6+4]=P2[0]; A[k*6+5]=P2[1];
        cxs[k]=(P0[0]+P1[0]+P2[0])/3; cys[k]=(P0[1]+P1[1]+P2[1])/3;
      }
      const cell = Math.max(h, (mxx-mnx+mxy-mny) / 128 || h);
      const gw = Math.max(1, Math.ceil((mxx-mnx)/cell)+1), gh = Math.max(1, Math.ceil((mxy-mny)/cell)+1);
      const buckets = new Map();
      const cellKey = (ix,iy) => iy*gw+ix;
      for (let k = 0; k < rTris.length; k++) {
        let x0=Math.min(A[k*6],A[k*6+2],A[k*6+4]), x1=Math.max(A[k*6],A[k*6+2],A[k*6+4]);
        let y0=Math.min(A[k*6+1],A[k*6+3],A[k*6+5]), y1=Math.max(A[k*6+1],A[k*6+3],A[k*6+5]);
        const ix0=Math.max(0,Math.floor((x0-mnx)/cell)), ix1=Math.min(gw-1,Math.floor((x1-mnx)/cell));
        const iy0=Math.max(0,Math.floor((y0-mny)/cell)), iy1=Math.min(gh-1,Math.floor((y1-mny)/cell));
        for(let iy=iy0;iy<=iy1;iy++) for(let ix=ix0;ix<=ix1;ix++){
          const kk=cellKey(ix,iy); let arr=buckets.get(kk); if(!arr){arr=[];buckets.set(kk,arr);} arr.push(k); }
      }
      const inTri2 = (k,x,y) => {
        const ax=A[k*6],ay=A[k*6+1],bx=A[k*6+2],by=A[k*6+3],cx2=A[k*6+4],cy2=A[k*6+5];
        const d1=orient2d(ax,ay,bx,by,x,y), d2=orient2d(bx,by,cx2,cy2,x,y), d3=orient2d(cx2,cy2,ax,ay,x,y);
        return (d1>=-1e-9&&d2>=-1e-9&&d3>=-1e-9) || (d1<=1e-9&&d2<=1e-9&&d3<=1e-9);
      };
      locate = (x,y) => {
        const ix=Math.max(0,Math.min(gw-1,Math.floor((x-mnx)/cell))), iy=Math.max(0,Math.min(gh-1,Math.floor((y-mny)/cell)));
        const arr=buckets.get(cellKey(ix,iy));
        if(arr) for(const k of arr) if(inTri2(k,x,y)) return parentIn[rTris[k]];
        let best=-1,bd=Infinity;
        for(let k=0;k<rTris.length;k++){ const dd=(cxs[k]-x)**2+(cys[k]-y)**2; if(dd<bd){bd=dd;best=k;} }
        return best>=0 ? parentIn[rTris[best]] : 0;
      };
    }

    for(const [a,b,c] of tris) {
      let par = 0;
      if (locate) {
        const gx=(pts2d[a][0]+pts2d[b][0]+pts2d[c][0])/3, gy=(pts2d[a][1]+pts2d[b][1]+pts2d[c][1])/3;
        par = locate(gx, gy);
      }
      pushTri(pt3d[a], pt3d[b], pt3d[c], ptW[a], ptW[b], ptW[c], par);
    }
    remeshed[r]=1;
  }

  // Pass through everything not remeshed (masked, curved, failed regions).
  for (let t=0;t<triCount;t++){
    const r=regionId[t];
    if(r>=0 && remeshed[r]) continue;
    const b=t*3;
    const P=[]; const W=[];
    for(let k=0;k<3;k++){ const id=triV[b+k]; P.push([vx[id],vy[id],vz[id]]); W.push(ewv?ewv[id]:0); }
    pushTri(P[0],P[1],P[2],W[0],W[1],W[2], parentIn ? parentIn[t] : 0);
  }

  const nOut = outP.length / 9;

  // ── Restore parent-ordered output ──────────────────────────────────────────
  // Emission above is grouped by region (remeshed regions first, then
  // pass-through), which scrambles the input triangle order. The bake then
  // assigns each body a CONTIGUOUS post-bake range (startTri/triCount from
  // triToBody), so scrambled order made those ranges span the wrong triangles:
  // consecutive bakes sliced across body boundaries, producing non-manifold
  // edges, jagged face perimeters and mixed-up body colours. Parent ids index
  // the input triangles, which ARE grouped by body, so a stable counting sort by
  // parent restores body contiguity. Only needed when parents are tracked.
  let order2 = null;
  if (parentIn && nOut > 0) {
    const counts = new Uint32Array(triCount + 1);
    for (let i = 0; i < nOut; i++) counts[outParent[i]]++;
    let run = 0;
    for (let p = 0; p <= triCount; p++) { const c = counts[p]; counts[p] = run; run += c; }
    order2 = new Uint32Array(nOut);
    for (let i = 0; i < nOut; i++) order2[counts[outParent[i]]++] = i;
  }

  const fPos = new Float32Array(nOut * 9);
  const fNrm = new Float32Array(nOut * 9);
  const fW   = ewv ? new Float32Array(nOut * 3) : null;
  const fPar = parentIn ? new Int32Array(nOut) : null;
  for (let o = 0; o < nOut; o++) {
    const src = order2 ? order2[o] : o;
    for (let k = 0; k < 9; k++) { fPos[o*9+k] = outP[src*9+k]; fNrm[o*9+k] = outN[src*9+k]; }
    if (fW) for (let k = 0; k < 3; k++) fW[o*3+k] = outW[src*3+k];
    if (fPar) fPar[o] = outParent[src];
  }

  const out=new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(fPos,3));
  out.setAttribute('normal',   new THREE.BufferAttribute(fNrm,3));
  if(fW) out.setAttribute('excludeWeight', new THREE.BufferAttribute(fW,1));
  return { geometry: out, faceParentId: fPar };
}
