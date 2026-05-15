import { zipSync, strToU8 } from 'fflate';

async function triggerDownload(buffer, filename, mime = 'application/octet-stream') {
  if (window.electronAPI) {
    const result = await window.electronAPI.showSaveDialog({
      defaultPath: filename,
      filters: [
        { name: '3MF Files', extensions: ['3mf'] },
        { name: 'STL Files', extensions: ['stl'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (!result.canceled && result.filePath) {
      await window.electronAPI.writeFile(result.filePath, buffer)
    }
    return
  }
  // Fall back to browser download
  const blob = new Blob([buffer], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href=url; a.download=filename; a.style.display='none'
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// ── STL exporter ─────────────────────────────────────────────────────────────

export async function exportSTL(geometry, filename = 'textured.stl') {
  const posArr = geometry.attributes.position.array;
  const norArr = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  const triCount = (posArr.length / 9) | 0;
  const buffer = new ArrayBuffer(84 + 50 * triCount);
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);
  view.setUint32(80, triCount, true);
  const posSrc = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const norSrc = norArr ? new Uint8Array(norArr.buffer, norArr.byteOffset, norArr.byteLength) : null;
  for (let i=0; i<triCount; i++) {
    const dst=84+i*50, srcOff=i*36;
    if (norSrc) {
      bytes.set(norSrc.subarray(srcOff, srcOff+12), dst);
    } else {
      const b=i*9;
      const ux=posArr[b+3]-posArr[b], uy=posArr[b+4]-posArr[b+1], uz=posArr[b+5]-posArr[b+2];
      const vx=posArr[b+6]-posArr[b], vy=posArr[b+7]-posArr[b+1], vz=posArr[b+8]-posArr[b+2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      const len=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      view.setFloat32(dst,   nx/len, true);
      view.setFloat32(dst+4, ny/len, true);
      view.setFloat32(dst+8, nz/len, true);
    }
    bytes.set(posSrc.subarray(srcOff, srcOff+36), dst+12);
  }
  await triggerDownload(buffer, filename);
}

// ── 3MF body metadata ─────────────────────────────────────────────────────────

let _3mfBodies       = null;
let _3mfCenterOffset = null;

export function set3mfBodies(bodies, centerOffset) {
  _3mfBodies       = (bodies && bodies.length > 0) ? bodies : null;
  _3mfCenterOffset = centerOffset || null;
}

export function clear3mfBodies() {
  _3mfBodies       = null;
  _3mfCenterOffset = null;
}

export function get3mfBodies() {
  return _3mfBodies;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt4(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  let s = n.toFixed(4);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function makeEmitter() {
  const enc=new TextEncoder(), chunks=[];
  let total=0, pending='';
  const FLUSH=1<<20;
  const flush=()=>{ if(!pending)return; const b=enc.encode(pending); chunks.push(b); total+=b.length; pending=''; };
  const emit=(s)=>{ pending+=s; if(pending.length>=FLUSH)flush(); };
  const finish=()=>{ flush(); const out=new Uint8Array(total); let off=0; for(const b of chunks){out.set(b,off);off+=b.length;} return out; };
  return {emit,finish};
}

function emitObjectXml(emitter, geometry, objectId, name) {
  const { emit } = emitter;
  const posArr   = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;
  if (triCount === 0) return;

  const vertCount_max = triCount * 3;
  const HASH_SIZE = Math.max(1 << 16, 1 << Math.ceil(Math.log2(triCount * 3 * 2)));
  const hashTable  = new Int32Array(HASH_SIZE).fill(-1);
  const hashNext   = new Int32Array(vertCount_max).fill(-1);
  const hashX      = new Float32Array(vertCount_max);
  const hashY      = new Float32Array(vertCount_max);
  const hashZ      = new Float32Array(vertCount_max);
  const hashIdx    = new Int32Array(vertCount_max);
  let   slotCount  = 0;
  let   vertCount  = 0;
  const QUANT_LOCAL = 1e4;
  const triIdx = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b], y = posArr[b+1], z = posArr[b+2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z))
        throw new Error(`Non-finite vertex in body ${objectId} tri ${i} vert ${j}: (${x},${y},${z})`);
      const qx = Math.round(x * QUANT_LOCAL);
      const qy = Math.round(y * QUANT_LOCAL);
      const qz = Math.round(z * QUANT_LOCAL);
      const h  = (((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) >>> 0) & (HASH_SIZE - 1);
      let found = -1;
      let probe = hashTable[h];
      while (probe !== -1) {
        if (Math.round(hashX[probe] * QUANT_LOCAL) === qx &&
            Math.round(hashY[probe] * QUANT_LOCAL) === qy &&
            Math.round(hashZ[probe] * QUANT_LOCAL) === qz) {
          found = probe; break;
        }
        probe = hashNext[probe];
      }
      if (found === -1) {
        hashX[slotCount]    = x;
        hashY[slotCount]    = y;
        hashZ[slotCount]    = z;
        hashIdx[slotCount]  = vertCount;
        hashNext[slotCount] = hashTable[h];
        hashTable[h]        = slotCount;
        triIdx[i * 3 + j]   = vertCount;
        slotCount++;
        vertCount++;
      } else {
        triIdx[i * 3 + j] = hashIdx[found];
      }
    }
  }

  const vx = new Float32Array(vertCount);
  const vy = new Float32Array(vertCount);
  const vz = new Float32Array(vertCount);
  for (let s = 0; s < slotCount; s++) {
    const idx = hashIdx[s];
    vx[idx] = hashX[s];
    vy[idx] = hashY[s];
    vz[idx] = hashZ[s];
  }

  const namePart = name ? ` name="${escapeXml(name)}"` : '';
  emit(`<object id="${objectId}"${namePart} type="model">\n<mesh>\n<vertices>\n`);
  for (let i = 0; i < vertCount; i++) {
    emit('<vertex x="' + fmt4(vx[i]) + '" y="' + fmt4(vy[i]) + '" z="' + fmt4(vz[i]) + '"/>\n');
  }
  emit('</vertices>\n<triangles>\n');
  for (let i = 0; i < triCount; i++) {
    const b = i * 3;
    emit('<triangle v1="' + triIdx[b] + '" v2="' + triIdx[b+1] + '" v3="' + triIdx[b+2] + '"/>\n');
  }
  emit('</triangles>\n</mesh>\n</object>\n');
}

function buildTransformAttr(matrix, centerOffset) {
  if (!matrix || !matrix.isMatrix4 || !matrix.elements || matrix.elements.length < 16) return null;
  const e=matrix.elements;
  const m00=e[0],m10=e[1],m20=e[2];
  const m01=e[4],m11=e[5],m21=e[6];
  const m02=e[8],m12=e[9],m22=e[10];
  let tx=e[12],ty=e[13],tz=e[14];
  if (centerOffset) {
    tx+=isFinite(centerOffset.x)?centerOffset.x:0;
    ty+=isFinite(centerOffset.y)?centerOffset.y:0;
    tz+=isFinite(centerOffset.z)?centerOffset.z:0;
  }
  const eps=1e-5;
  if (Math.abs(m00-1)<eps&&Math.abs(m10)<eps&&Math.abs(m20)<eps&&
      Math.abs(m01)<eps&&Math.abs(m11-1)<eps&&Math.abs(m21)<eps&&
      Math.abs(m02)<eps&&Math.abs(m12)<eps&&Math.abs(m22-1)<eps&&
      Math.abs(tx)<eps&&Math.abs(ty)<eps&&Math.abs(tz)<eps) return null;
  return [m00,m01,m02,m10,m11,m12,m20,m21,m22,tx,ty,tz]
    .map(v=>parseFloat((isFinite(v)?v:0).toFixed(6))).join(' ');
}

// ── 3MF XML builder ───────────────────────────────────────────────────────────

function buildModelXmlBytes(bodyResultsOrGeometry) {
  const emitter = makeEmitter();
  const { emit, finish } = emitter;
  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<model unit="millimeter" xml:lang="en-US" '+
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'+
    '<resources>\n'
  );
  const isMultiBody = Array.isArray(bodyResultsOrGeometry) && bodyResultsOrGeometry.length > 0;
  if (isMultiBody) {
    const bodyResults = bodyResultsOrGeometry;
    const nonEmpty = bodyResults.filter(b => (b.geometry.attributes.position.array.length/9|0) > 0);
    for (let i=0; i<nonEmpty.length; i++) {
      emitObjectXml(emitter, nonEmpty[i].geometry, i+1, nonEmpty[i].name||'');
    }
    emit('</resources>\n<build>\n');
    for (let i=0; i<nonEmpty.length; i++) {
      const txAttr = buildTransformAttr(nonEmpty[i].matrix, _3mfCenterOffset);
      emit(txAttr
        ? `<item objectid="${i+1}" transform="${txAttr}"/>\n`
        : `<item objectid="${i+1}"/>\n`);
    }
    emit('</build>\n</model>\n');
  } else {
    const geometry = bodyResultsOrGeometry;
    const name   = (_3mfBodies && _3mfBodies.length===1) ? (_3mfBodies[0].name||'') : '';
    const matrix = (_3mfBodies && _3mfBodies.length===1) ? _3mfBodies[0].matrix : null;
    emitObjectXml(emitter, geometry, 1, name);
    emit('</resources>\n<build>\n');
    const txAttr = buildTransformAttr(matrix, _3mfCenterOffset);
    emit(txAttr ? `<item objectid="1" transform="${txAttr}"/>\n` : '<item objectid="1"/>\n');
    emit('</build>\n</model>\n');
  }
  return finish();
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n'+
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'+
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'+
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'+
  '</Types>\n';

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n'+
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'+
  '<Relationship Id="rel-1" Target="/3D/3dmodel.model" '+
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'+
  '</Relationships>\n';

// Returns zipped 3MF bytes — used by project save
export function build3MFBytes(bodyResultsOrGeometry) {
  const modelBytes = buildModelXmlBytes(bodyResultsOrGeometry);
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
    '_rels/.rels':         strToU8(RELS_XML),
    '3D/3dmodel.model':    modelBytes,
  }, { level: 0 });
}

// Async export — doesn't block the thread
export async function export3MF(bodyResultsOrGeometry, filename = 'textured.3mf') {
  const modelBytes = buildModelXmlBytes(bodyResultsOrGeometry);
  
  // Use zipSync but defer to next tick to avoid blocking
  const zipped = await new Promise((resolve) => {
    setTimeout(() => {
      resolve(zipSync({
        '[Content_Types].xml': [strToU8(CONTENT_TYPES_XML), { level: 0 }],
        '_rels/.rels':         [strToU8(RELS_XML),           { level: 0 }],
        '3D/3dmodel.model':    [modelBytes,                  { level: 0 }],
      }));
    }, 0);
  });
  
  await triggerDownload(zipped, filename, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
}