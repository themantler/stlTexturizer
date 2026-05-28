import * as THREE from 'three';

const SIZE  = 512; // texture resolution for both preview and sampling
const THUMB = 80;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width  = w;
  c.height = h;
  return c;
}

/** Return { w, h } capped at SIZE on the longest side, preserving aspect ratio. */
function fitDimensions(imgW, imgH) {
  const scale = Math.min(SIZE / imgW, SIZE / imgH, 1);
  return { w: Math.round(imgW * scale), h: Math.round(imgH * scale) };
}

// ── Image-based presets ───────────────────────────────────────────────────────

const IMAGE_PRESETS = [
  { name: 'Basket',       url: 'textures/basket.png',       thumb: 'textures/thumbs/basket.webp',       defaultScale: 0.5, group: 'Built-in' },
  { name: 'Brick',        url: 'textures/brick.png',        thumb: 'textures/thumbs/brick.webp',        defaultScale: 0.5, group: 'Built-in' },
  { name: 'Bubble',       url: 'textures/bubble.png',       thumb: 'textures/thumbs/bubble.webp',       defaultScale: 0.5, group: 'Built-in' },
  { name: 'Carbon Fiber', url: 'textures/carbonFiber.jpg',  thumb: 'textures/thumbs/carbonFiber.webp',  defaultScale: 0.5, group: 'Built-in' },
  { name: 'Crystal',      url: 'textures/crystal.png',      thumb: 'textures/thumbs/crystal.webp',      defaultScale: 0.5, group: 'Built-in' },
  { name: 'Dots',         url: 'textures/dots.png',         thumb: 'textures/thumbs/dots.webp',         defaultScale: 0.1, group: 'Built-in' },
  { name: 'Grid',         url: 'textures/grid.png',         thumb: 'textures/thumbs/grid.webp',         defaultScale: 1.0, group: 'Built-in' },
  { name: 'Grip Surface', url: 'textures/gripSurface.jpg',  thumb: 'textures/thumbs/gripSurface.webp',  defaultScale: 0.5, group: 'Built-in' },
  { name: 'Hexagon',      url: 'textures/hexagon.jpg',      thumb: 'textures/thumbs/hexagon.webp',      defaultScale: 0.5, group: 'Built-in' },
  { name: 'Hexagons',     url: 'textures/hexagons.jpg',     thumb: 'textures/thumbs/hexagons.webp',     defaultScale: 1.0, group: 'Built-in' },
  { name: 'Isogrid',      url: 'textures/isogrid.png',      thumb: 'textures/thumbs/isogrid.webp',      defaultScale: 0.5, group: 'Built-in' },
  { name: 'Knitting',     url: 'textures/knitting.png',     thumb: 'textures/thumbs/knitting.webp',     defaultScale: 0.25, group: 'Built-in' },
  { name: 'Knurling',     url: 'textures/knurling.jpg',     thumb: 'textures/thumbs/knurling.webp',     defaultScale: 0.15, group: 'Built-in' },
  { name: 'Leather 2',    url: 'textures/leather2.png',     thumb: 'textures/thumbs/leather2.webp',     defaultScale: 0.5, group: 'Built-in' },
  { name: 'Noise',        url: 'textures/noise.jpg',        thumb: 'textures/thumbs/noise.webp',        defaultScale: 0.3, group: 'Built-in' },
  { name: 'Stripes 1',    url: 'textures/stripes.png',      thumb: 'textures/thumbs/stripes.webp',      defaultScale: 0.5, group: 'Built-in' },
  { name: 'Stripes 2',    url: 'textures/stripes_02.png',   thumb: 'textures/thumbs/stripes_02.webp',   defaultScale: 1.0, group: 'Built-in' },
  { name: 'Voronoi',      url: 'textures/voronoi.jpg',      thumb: 'textures/thumbs/voronoi.webp',      defaultScale: 0.5, group: 'Built-in' },
  { name: 'Weave 1',      url: 'textures/weave.png',        thumb: 'textures/thumbs/weave.webp',        defaultScale: 0.5, group: 'Built-in' },
  { name: 'Weave 2',      url: 'textures/weave_02.jpg',     thumb: 'textures/thumbs/weave_02.webp',     defaultScale: 0.5, group: 'Built-in' },
  { name: 'Weave 3',      url: 'textures/weave_03.jpg',     thumb: 'textures/thumbs/weave_03.webp',     defaultScale: 0.5, group: 'Built-in' },
  { name: 'Wood 1',       url: 'textures/wood.jpg',         thumb: 'textures/thumbs/wood.webp',         defaultScale: 0.5, group: 'Built-in' },
  { name: 'Wood 2',       url: 'textures/woodgrain_02.jpg', thumb: 'textures/thumbs/woodgrain_02.webp', defaultScale: 1.0, group: 'Built-in' },
  { name: 'Wood 3',       url: 'textures/woodgrain_03.jpg', thumb: 'textures/thumbs/woodgrain_03.webp', defaultScale: 1.0, group: 'Built-in' },


  {
    name:  'Brick 1',
    url:   'textures/Brick_Brick-1.png',
    thumb: 'textures/thumbs/Brick_Brick-1.webp',
    group: 'Brick',
  },
  {
    name:  'Brick 2',
    url:   'textures/Brick_Brick-2.jpg',
    thumb: 'textures/thumbs/Brick_Brick-2.webp',
    group: 'Brick',
  },
  {
    name:  'Wood1',
    url:   'textures/Flooring_Wood1.png',
    thumb: 'textures/thumbs/Flooring_Wood1.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood2',
    url:   'textures/Flooring_Wood2.png',
    thumb: 'textures/thumbs/Flooring_Wood2.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood3',
    url:   'textures/Flooring_Wood3.png',
    thumb: 'textures/thumbs/Flooring_Wood3.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood4',
    url:   'textures/Flooring_Wood4.png',
    thumb: 'textures/thumbs/Flooring_Wood4.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood5',
    url:   'textures/Flooring_Wood5.png',
    thumb: 'textures/thumbs/Flooring_Wood5.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood6',
    url:   'textures/Flooring_Wood6.jpg',
    thumb: 'textures/thumbs/Flooring_Wood6.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood7',
    url:   'textures/Flooring_Wood7.jpg',
    thumb: 'textures/thumbs/Flooring_Wood7.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood7',
    url:   'textures/Flooring_Wood7.png',
    thumb: 'textures/thumbs/Flooring_Wood7.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood8',
    url:   'textures/Flooring_Wood8.png',
    thumb: 'textures/thumbs/Flooring_Wood8.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood9',
    url:   'textures/Flooring_Wood9.png',
    thumb: 'textures/thumbs/Flooring_Wood9.webp',
    group: 'Flooring',
  },
  {
    name:  'Wood',
    url:   'textures/Shingles_Wood.png',
    thumb: 'textures/thumbs/Shingles_Wood.webp',
    group: 'Shingles',
  },
  {
    name:  'Stone1',
    url:   'textures/Stone_Stone1.png',
    thumb: 'textures/thumbs/Stone_Stone1.webp',
    group: 'Stone',
  },
  {
    name:  'Stone10',
    url:   'textures/Stone_Stone10.png',
    thumb: 'textures/thumbs/Stone_Stone10.webp',
    group: 'Stone',
  },
  {
    name:  'Stone11',
    url:   'textures/Stone_Stone11.png',
    thumb: 'textures/thumbs/Stone_Stone11.webp',
    group: 'Stone',
  },
  {
    name:  'Stone12',
    url:   'textures/Stone_Stone12.png',
    thumb: 'textures/thumbs/Stone_Stone12.webp',
    group: 'Stone',
  },
  {
    name:  'Stone13',
    url:   'textures/Stone_Stone13.png',
    thumb: 'textures/thumbs/Stone_Stone13.webp',
    group: 'Stone',
  },
  {
    name:  'Stone14',
    url:   'textures/Stone_Stone14.png',
    thumb: 'textures/thumbs/Stone_Stone14.webp',
    group: 'Stone',
  },
  {
    name:  'Stone15',
    url:   'textures/Stone_Stone15.png',
    thumb: 'textures/thumbs/Stone_Stone15.webp',
    group: 'Stone',
  },
  {
    name:  'Stone16',
    url:   'textures/Stone_Stone16.png',
    thumb: 'textures/thumbs/Stone_Stone16.webp',
    group: 'Stone',
  },
  {
    name:  'Stone17',
    url:   'textures/Stone_Stone17.png',
    thumb: 'textures/thumbs/Stone_Stone17.webp',
    group: 'Stone',
  },
  {
    name:  'Stone18',
    url:   'textures/Stone_Stone18.png',
    thumb: 'textures/thumbs/Stone_Stone18.webp',
    group: 'Stone',
  },
  {
    name:  'Stone19',
    url:   'textures/Stone_Stone19.png',
    thumb: 'textures/thumbs/Stone_Stone19.webp',
    group: 'Stone',
  },
  {
    name:  'Stone2',
    url:   'textures/Stone_Stone2.png',
    thumb: 'textures/thumbs/Stone_Stone2.webp',
    group: 'Stone',
  },
  {
    name:  'Stone20',
    url:   'textures/Stone_Stone20.png',
    thumb: 'textures/thumbs/Stone_Stone20.webp',
    group: 'Stone',
  },
  {
    name:  'Stone21',
    url:   'textures/Stone_Stone21.png',
    thumb: 'textures/thumbs/Stone_Stone21.webp',
    group: 'Stone',
  },
  {
    name:  'Stone22',
    url:   'textures/Stone_Stone22.png',
    thumb: 'textures/thumbs/Stone_Stone22.webp',
    group: 'Stone',
  },
  {
    name:  'Stone23',
    url:   'textures/Stone_Stone23.png',
    thumb: 'textures/thumbs/Stone_Stone23.webp',
    group: 'Stone',
  },
  {
    name:  'Stone24',
    url:   'textures/Stone_Stone24.png',
    thumb: 'textures/thumbs/Stone_Stone24.webp',
    group: 'Stone',
  },
  {
    name:  'Stone25',
    url:   'textures/Stone_Stone25.png',
    thumb: 'textures/thumbs/Stone_Stone25.webp',
    group: 'Stone',
  },
  {
    name:  'Stone26',
    url:   'textures/Stone_Stone26.png',
    thumb: 'textures/thumbs/Stone_Stone26.webp',
    group: 'Stone',
  },
  {
    name:  'Stone27',
    url:   'textures/Stone_Stone27.png',
    thumb: 'textures/thumbs/Stone_Stone27.webp',
    group: 'Stone',
  },
  {
    name:  'Stone3',
    url:   'textures/Stone_Stone3.png',
    thumb: 'textures/thumbs/Stone_Stone3.webp',
    group: 'Stone',
  },
  {
    name:  'Stone4',
    url:   'textures/Stone_Stone4.png',
    thumb: 'textures/thumbs/Stone_Stone4.webp',
    group: 'Stone',
  },
  {
    name:  'Stone5',
    url:   'textures/Stone_Stone5.png',
    thumb: 'textures/thumbs/Stone_Stone5.webp',
    group: 'Stone',
  },
  {
    name:  'Stone6',
    url:   'textures/Stone_Stone6.png',
    thumb: 'textures/thumbs/Stone_Stone6.webp',
    group: 'Stone',
  },
  {
    name:  'Stone7',
    url:   'textures/Stone_Stone7.png',
    thumb: 'textures/thumbs/Stone_Stone7.webp',
    group: 'Stone',
  },
  {
    name:  'Stone8',
    url:   'textures/Stone_Stone8.png',
    thumb: 'textures/thumbs/Stone_Stone8.webp',
    group: 'Stone',
  },
  {
    name:  'Stone9',
    url:   'textures/Stone_Stone9.png',
    thumb: 'textures/thumbs/Stone_Stone9.webp',
    group: 'Stone',
  },
  {
    name:  'Wood1',
    url:   'textures/Wood_Wood1.png',
    thumb: 'textures/thumbs/Wood_Wood1.webp',
    group: 'Wood',
  },
  {
    name:  'Wood10',
    url:   'textures/Wood_Wood10.png',
    thumb: 'textures/thumbs/Wood_Wood10.webp',
    group: 'Wood',
  },
  {
    name:  'Wood11',
    url:   'textures/Wood_Wood11.png',
    thumb: 'textures/thumbs/Wood_Wood11.webp',
    group: 'Wood',
  },
  {
    name:  'Wood12',
    url:   'textures/Wood_Wood12.png',
    thumb: 'textures/thumbs/Wood_Wood12.webp',
    group: 'Wood',
  },
  {
    name:  'Wood13',
    url:   'textures/Wood_Wood13.png',
    thumb: 'textures/thumbs/Wood_Wood13.webp',
    group: 'Wood',
  },
  {
    name:  'Wood14',
    url:   'textures/Wood_Wood14.png',
    thumb: 'textures/thumbs/Wood_Wood14.webp',
    group: 'Wood',
  },
  {
    name:  'Wood15',
    url:   'textures/Wood_Wood15.png',
    thumb: 'textures/thumbs/Wood_Wood15.webp',
    group: 'Wood',
  },
  {
    name:  'Wood16',
    url:   'textures/Wood_Wood16.png',
    thumb: 'textures/thumbs/Wood_Wood16.webp',
    group: 'Wood',
  },
  {
    name:  'Wood17',
    url:   'textures/Wood_Wood17.png',
    thumb: 'textures/thumbs/Wood_Wood17.webp',
    group: 'Wood',
  },
  {
    name:  'Wood2',
    url:   'textures/Wood_Wood2.png',
    thumb: 'textures/thumbs/Wood_Wood2.webp',
    group: 'Wood',
  },
  {
    name:  'Wood3',
    url:   'textures/Wood_Wood3.png',
    thumb: 'textures/thumbs/Wood_Wood3.webp',
    group: 'Wood',
  },
  {
    name:  'Wood4',
    url:   'textures/Wood_Wood4.png',
    thumb: 'textures/thumbs/Wood_Wood4.webp',
    group: 'Wood',
  },
  {
    name:  'Wood5',
    url:   'textures/Wood_Wood5.png',
    thumb: 'textures/thumbs/Wood_Wood5.webp',
    group: 'Wood',
  },
  {
    name:  'Wood6',
    url:   'textures/Wood_Wood6.png',
    thumb: 'textures/thumbs/Wood_Wood6.webp',
    group: 'Wood',
  },
  {
    name:  'Wood7',
    url:   'textures/Wood_Wood7.png',
    thumb: 'textures/thumbs/Wood_Wood7.webp',
    group: 'Wood',
  },
  {
    name:  'Wood8',
    url:   'textures/Wood_Wood8.png',
    thumb: 'textures/thumbs/Wood_Wood8.webp',
    group: 'Wood',
  },
  {
    name:  'Wood9',
    url:   'textures/Wood_Wood9.png',
    thumb: 'textures/thumbs/Wood_Wood9.webp',
    group: 'Wood',
  },
];

// Cache for full-resolution preset data (keyed by index)
const _fullPresetCache = new Map();

/**
 * Load only the pre-computed thumbnail for a preset.
 * Returns { name, thumbCanvas, defaultScale }.
 */
function loadPresetThumbnail(preset) {
  // Script-added preset with embedded base64 thumbnail
  if (preset.thumbDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const thumb = makeCanvas(THUMB);
        thumb.getContext('2d').drawImage(img, 0, 0, THUMB, THUMB);
        resolve({ name: preset.name, thumbCanvas: thumb, defaultScale: preset.defaultScale, group: preset.group });
      };
      img.onerror = () => reject(new Error(`Failed to load embedded thumbnail: ${preset.name}`));
      img.src = preset.thumbDataUrl;
    });
  }
  // Original format with external thumb file
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const thumb = makeCanvas(THUMB);
      thumb.getContext('2d').drawImage(img, 0, 0, THUMB, THUMB);
      resolve({ name: preset.name, thumbCanvas: thumb, defaultScale: preset.defaultScale, group: preset.group });
    };
    img.onerror = () => reject(new Error(`Failed to load thumbnail: ${preset.thumb}`));
    img.src = preset.thumb;
  });
}

/**
 * Load the full-resolution texture for a preset (on demand).
 * Returns the full entry: { name, thumbCanvas, fullCanvas, texture, imageData, width, height, defaultScale }.
 * Results are cached so repeated calls for the same index return instantly.
 */
export function loadFullPreset(idx) {
  if (_fullPresetCache.has(idx)) return Promise.resolve(_fullPresetCache.get(idx));
  const preset = IMAGE_PRESETS[idx];
  // Determine image source — script-added presets use file path, built-ins use url
  const src = preset.url || `textures/${preset.file}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { w, h } = fitDimensions(img.width, img.height);
      const full = makeCanvas(w, h);
      full.getContext('2d').drawImage(img, 0, 0, w, h);
      const imageData = full.getContext('2d').getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(full);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = preset.name;
      const entry = { name: preset.name, fullCanvas: full, texture, imageData, width: w, height: h, defaultScale: preset.defaultScale, group: preset.group };
      _fullPresetCache.set(idx, entry);
      resolve(entry);
    };
    img.onerror = () => reject(new Error(`Failed to load preset image: ${src}`));
    img.src = src;
  });
}

/**
 * Load all thumbnails. Returns Promise<Array<{ name, thumbCanvas, defaultScale }|null>>.
 */
export function loadAllThumbnails() {
  return Promise.all(IMAGE_PRESETS.map(p =>
    loadPresetThumbnail(p).catch(() => null)
  ));
}

export { IMAGE_PRESETS };


/**
 * Build a THREE.CanvasTexture + ImageData from a user-uploaded image File.
 */
export function loadCustomTexture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { w, h } = fitDimensions(img.width, img.height);
      const canvas = makeCanvas(w, h);
      const ctx    = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = file.name;
      const thumb = document.createElement('canvas');
      thumb.width = 80; thumb.height = 80;
      const tctx = thumb.getContext('2d');
      const scale = Math.min(80 / img.width, 80 / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      tctx.drawImage(img, (80 - dw) / 2, (80 - dh) / 2, dw, dh);
      resolve({ name: file.name, thumbCanvas: thumb, fullCanvas: canvas, texture, imageData, width: w, height: h, isCustom: true });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
