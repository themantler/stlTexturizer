/**
 * exclusion.js — per-face exclusion masking
 *
 * Provides three capabilities:
 *  1. buildAdjacency   – builds an inter-triangle adjacency list with dihedral
 *                        angles and precomputes per-triangle centroids.
 *  2. bucketFill       – BFS flood fill that respects a max dihedral-angle
 *                        threshold (stops at "sharp" edges).
 *  3. buildExclusionOverlayGeo – compact geometry for the orange preview overlay.
 *  4. buildFaceWeights – per-vertex exclusion weights for the subdivision pass.
 */

import * as THREE from 'three';

const QUANT = 1e4;
const quantKey = (x, y, z) =>
  `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

// ── Adjacency & centroids ─────────────────────────────────────────────────────

/**
 * Build inter-triangle adjacency data for a non-indexed BufferGeometry.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed
 * @returns {{
 *   adjacency:   Array<Array<{neighbor:number, angle:number}>>,
 *   centroids:   Float32Array   (triCount × 3, geometry-local centroid per triangle),
 *   boundRadii:  Float32Array   (triCount, max vertex-to-centroid distance per triangle),
 *   faceNormals: Float32Array   (triCount × 3, geometry-local unit face normal per triangle)
 * }}
 */
export function buildAdjacency(geometry) {
  const posAttr  = geometry.attributes.position;
  const triCount = posAttr.count / 3;

  // Pre-allocate face normals, centroids, and per-triangle bounding radii
  const faceNormals = new Float32Array(triCount * 3);
  const centroids   = new Float32Array(triCount * 3);
  const boundRadii  = new Float32Array(triCount);
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    vA.fromBufferAttribute(posAttr, i);
    vB.fromBufferAttribute(posAttr, i + 1);
    vC.fromBufferAttribute(posAttr, i + 2);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2).normalize();
    faceNormals[i]     = fn.x;
    faceNormals[i + 1] = fn.y;
    faceNormals[i + 2] = fn.z;
    const cx = (vA.x + vB.x + vC.x) / 3;
    const cy = (vA.y + vB.y + vC.y) / 3;
    const cz = (vA.z + vB.z + vC.z) / 3;
    centroids[i]     = cx;
    centroids[i + 1] = cy;
    centroids[i + 2] = cz;
    const dA = (vA.x-cx)**2 + (vA.y-cy)**2 + (vA.z-cz)**2;
    const dB = (vB.x-cx)**2 + (vB.y-cy)**2 + (vB.z-cz)**2;
    const dC = (vC.x-cx)**2 + (vC.y-cy)**2 + (vC.z-cz)**2;
    boundRadii[t] = Math.sqrt(Math.max(dA, dB, dC));
  }

  // Vertex dedup using numeric spatial hash instead of string-keyed Map.
  // This avoids Map size limits and string allocation overhead for large meshes.
  const vertCount = triCount * 3;
  const HASH_SIZE = Math.max(1 << 16, 1 << Math.ceil(Math.log2(vertCount * 2)));
  const hashTable = new Int32Array(HASH_SIZE).fill(-1);
  const hashNext  = new Int32Array(vertCount).fill(-1);
  const vertId    = new Uint32Array(vertCount);
  // Cache quantized coords to avoid repeated attribute lookups in probe chain
  const qxArr = new Int32Array(vertCount);
  const qyArr = new Int32Array(vertCount);
  const qzArr = new Int32Array(vertCount);
  let nextId = 0;

  for (let i = 0; i < vertCount; i++) {
    const qx = Math.round(posAttr.getX(i) * QUANT);
    const qy = Math.round(posAttr.getY(i) * QUANT);
    const qz = Math.round(posAttr.getZ(i) * QUANT);
    qxArr[i] = qx; qyArr[i] = qy; qzArr[i] = qz;
    const h = (((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) >>> 0) & (HASH_SIZE - 1);
    let found = -1;
    let probe = hashTable[h];
    while (probe !== -1) {
      if (qxArr[probe] === qx && qyArr[probe] === qy && qzArr[probe] === qz) {
        found = probe; break;
      }
      probe = hashNext[probe];
    }
    if (found === -1) {
      hashNext[i] = hashTable[h];
      hashTable[h] = i;
      vertId[i] = nextId++;
    } else {
      vertId[i] = vertId[found];
    }
  }
  
  // Build edge map using numeric keys — no string allocations
  // numEdgeKey produces a unique number for each undirected edge
  const numEdgeKey = (a, b) => a < b ? a * nextId + b : b * nextId + a;
  // Build edge map using typed array hash to avoid Map size limits
  const EDGE_HASH_SIZE = Math.max(1 << 16, 1 << Math.ceil(Math.log2(triCount * 3 * 2)));
  const edgeHashTable = new Int32Array(EDGE_HASH_SIZE).fill(-1);
  const edgeHashNext  = new Int32Array(triCount * 3).fill(-1);
  const edgeHashKey   = new Float64Array(triCount * 3);
  const edgeHashTriA  = new Int32Array(triCount * 3).fill(-1);
  const edgeHashTriB  = new Int32Array(triCount * 3).fill(-1);
  let edgeSlot = 0;
  const edgePairs = [0, 1, 0, 2, 1, 2];

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let e = 0; e < 6; e += 2) {
      const a = vertId[base + edgePairs[e]];
      const b = vertId[base + edgePairs[e + 1]];
      const ek = a < b ? a * nextId + b : b * nextId + a;
      const h = (Math.abs(Math.round(ek)) * 2654435761) >>> 0 & (EDGE_HASH_SIZE - 1);
      let found = -1;
      let probe = edgeHashTable[h];
      while (probe !== -1) {
        if (edgeHashKey[probe] === ek) { found = probe; break; }
        probe = edgeHashNext[probe];
      }
      if (found === -1) {
        edgeHashKey[edgeSlot]  = ek;
        edgeHashTriA[edgeSlot] = t;
        edgeHashTriB[edgeSlot] = -1;
        edgeHashNext[edgeSlot] = edgeHashTable[h];
        edgeHashTable[h]       = edgeSlot;
        edgeSlot++;
      } else if (edgeHashTriB[found] === -1) {
        edgeHashTriB[found] = t;
      }
      // more than 2 triangles sharing an edge = non-manifold, ignore extras
    }
  }

  // Convert to adjacency list
  const adjacency = new Array(triCount);
  for (let t = 0; t < triCount; t++) adjacency[t] = [];
  let openEdgeCount = 0;
  let nonManifoldEdgeCount = 0;

  for (let s = 0; s < edgeSlot; s++) {
    const a = edgeHashTriA[s];
    const b = edgeHashTriB[s];
    if (b === -1) { openEdgeCount++; continue; }
    const nAx = faceNormals[a * 3], nAy = faceNormals[a * 3 + 1], nAz = faceNormals[a * 3 + 2];
    const nBx = faceNormals[b * 3], nBy = faceNormals[b * 3 + 1], nBz = faceNormals[b * 3 + 2];
    const dot      = Math.max(-1, Math.min(1, nAx * nBx + nAy * nBy + nAz * nBz));
    const angleDeg = Math.acos(dot) * (180 / Math.PI);
    adjacency[a].push({ neighbor: b, angle: angleDeg });
    adjacency[b].push({ neighbor: a, angle: angleDeg });
  }

  return { adjacency, centroids, boundRadii, faceNormals, openEdgeCount, nonManifoldEdgeCount };
}

// ── Bucket fill ───────────────────────────────────────────────────────────────

/**
 * BFS flood fill starting from seedTriIdx.
 * Spreads across edges whose dihedral angle ≤ thresholdDeg.
 *
 * @param {number} seedTriIdx
 * @param {Array<Array<{neighbor:number, angle:number}>>} adjacency
 * @param {number} thresholdDeg
 * @returns {Set<number>}  set of triangle indices in the filled region
 */
export function bucketFill(seedTriIdx, adjacency, thresholdDeg) {
  const visited = new Set([seedTriIdx]);
  const queue   = [seedTriIdx];
  let head = 0;
  while (head < queue.length) {
    const cur       = queue[head++];
    const neighbors = adjacency[cur];
    if (!neighbors) continue;
    for (const { neighbor, angle } of neighbors) {
      if (!visited.has(neighbor) && angle <= thresholdDeg) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited;
}

// ── Overlay geometry ──────────────────────────────────────────────────────────

/**
 * Build a compact non-indexed BufferGeometry for an overlay.
 *
 * @param {THREE.BufferGeometry} geometry   – non-indexed source geometry
 * @param {Set<number>}          faceSet
 * @param {boolean}              [invert=false]  when true, include faces NOT in faceSet
 * @returns {THREE.BufferGeometry}
 */
export function buildExclusionOverlayGeo(geometry, faceSet, invert = false) {
  const srcPos   = geometry.attributes.position.array;
  const srcNrm   = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  const total    = srcPos.length / 9; // total triangle count
  const isArr    = faceSet instanceof Uint8Array;

  // Count included faces
  let setSize;
  if (isArr) {
    setSize = 0;
    for (let i = 0; i < faceSet.length; i++) if (faceSet[i]) setSize++;
  } else {
    setSize = faceSet.size;
  }
  const count    = invert ? total - setSize : setSize;
  const outPos   = new Float32Array(count * 9);
  const outNrm   = srcNrm ? new Float32Array(count * 9) : null;
  let dst = 0;
  if (invert) {
    for (let t = 0; t < total; t++) {
      if (isArr ? faceSet[t] : faceSet.has(t)) continue;
      const src = t * 9;
      outPos.set(srcPos.subarray(src, src + 9), dst);
      if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
      dst += 9;
    }
  } else {
    if (isArr) {
      for (let t = 0; t < faceSet.length; t++) {
        if (!faceSet[t]) continue;
        const src = t * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
    } else {
      for (const t of faceSet) {
        const src = t * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  return geo;
}

// ── Face-weight array for subdivision ────────────────────────────────────────

/**
 * Build a per-non-indexed-vertex exclusion weight array.
 * Vertex i (in the non-indexed buffer) belongs to triangle floor(i/3).
 * Excluded triangles get weight 1.0, all others 0.0.
 * subdivision.js threads these through edge splits via linear interpolation,
 * producing smooth 0→1 transitions at exclusion boundaries.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Set<number>}          excludedFaces
 * @returns {Float32Array}  length = geometry.attributes.position.count
 */
export function buildFaceWeights(geometry, excludedFaces, invert = false) {
  const count   = geometry.attributes.position.count;
  const weights = new Float32Array(count); // default 0.0 (included)
  if (invert) {
    // Include-only mode: all faces start excluded (1.0); painted faces are included (0.0)
    weights.fill(1.0);
    for (const t of excludedFaces) {
      weights[t * 3]     = 0.0;
      weights[t * 3 + 1] = 0.0;
      weights[t * 3 + 2] = 0.0;
    }
  } else {
    for (const t of excludedFaces) {
      weights[t * 3]     = 1.0;
      weights[t * 3 + 1] = 1.0;
      weights[t * 3 + 2] = 1.0;
    }
  }
  return weights;
}
