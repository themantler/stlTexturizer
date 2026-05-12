#!/usr/bin/env python3
"""
update-presets.py
-----------------
Place this script in your textures folder alongside your texture files.
Double-click to run — no command prompt needed.

What it does:
  - Scans the textures folder for PNG, JPG, and WebP files
  - Derives a group name from the filename prefix:
      projecta_my-texture.png  ->  group "Projecta",  name "My Texture"
      my-texture.png           ->  group "Built-in",  name "My Texture"
  - Generates an 80x80 thumbnail for each new texture (embedded as base64)
  - Adds new entries to IMAGE_PRESETS in ../js/presetTextures.js
  - Preserves existing entries - only adds files not already registered
  - Shows a done/error popup when finished

Requirements:
  pip install Pillow
"""

import os
import re
import sys
import base64
import tkinter as tk
from tkinter import messagebox
from pathlib import Path
from io import BytesIO

# ── Config ────────────────────────────────────────────────────────────────────

SCRIPT_DIR     = Path(__file__).parent.resolve()
TEXTURES_DIR   = SCRIPT_DIR
THUMB_SIZE     = 80
SUPPORTED_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
DEFAULT_GROUP  = 'Built-in'

# Filename prefixes that belong to built-in textures, not user groups
BUILTIN_PREFIXES = {'stripes', 'weave', 'woodgrain', 'leather', 'carbon'}

def _find_presets_file():
    check = SCRIPT_DIR
    for _ in range(4):
        candidate = check / 'js' / 'presetTextures.js'
        if candidate.exists():
            return candidate
        check = check.parent
    raise FileNotFoundError(
        'Could not find js/presetTextures.js\n\n'
        'Make sure the script is inside your stlTexturizer folder.'
    )

PRESETS_FILE = _find_presets_file()

# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_name(filename: str):
    stem = Path(filename).stem
    idx  = stem.find('_')
    if idx > 0:
        prefix = stem[:idx].lower()
        if prefix in BUILTIN_PREFIXES:
            group = DEFAULT_GROUP
            name  = re.sub(r'[-_]+', ' ', stem).title()
        else:
            group = prefix.capitalize()
            name  = re.sub(r'[-_]+', ' ', stem[idx + 1:]).title()
    else:
        group = DEFAULT_GROUP
        name  = re.sub(r'[-_]+', ' ', stem).title()
    return group, name


def parse_presets_file(src: str):
    marker    = 'export const IMAGE_PRESETS = ['
    start_idx = src.find(marker)
    if start_idx == -1:
        marker = 'const IMAGE_PRESETS = ['
        start_idx = src.find(marker)
    if start_idx == -1:
        raise ValueError('Could not find IMAGE_PRESETS in presetTextures.js')

    bracket_start = start_idx + len(marker) - 1
    depth   = 0
    end_idx = None
    for i in range(bracket_start, len(src)):
        if src[i] == '[':
            depth += 1
        elif src[i] == ']':
            depth -= 1
            if depth == 0:
                end_idx = i
                break

    if end_idx is None:
        raise ValueError('Could not find end of IMAGE_PRESETS array')

    before  = src[:start_idx + len(marker)]
    entries = src[start_idx + len(marker):end_idx]
    after   = src[end_idx:]
    return before, entries, after


def get_existing_files(entries: str):
    """Return set of all filenames already registered in IMAGE_PRESETS."""
    existing = set()
    # Script-added entries use file: 'filename.png'
    for m in re.finditer(r"file\s*:\s*['\"]([^'\"]+)['\"]", entries):
        existing.add(m.group(1))
    # Built-in entries use url: 'textures/filename.png'
    for m in re.finditer(r"url\s*:\s*['\"][^'\"]*?/([^'\"/]+)['\"]", entries):
        existing.add(m.group(1))
    return existing   
    
def generate_thumb(image_path: Path) -> str:
    try:
        from PIL import Image
    except ImportError:
        raise RuntimeError('Pillow not installed. Run: pip install Pillow')

    DST = TEXTURES_DIR / 'thumbs'
    DST.mkdir(exist_ok=True)

    with Image.open(image_path) as img:
        # Try to use embedded thumbnail first
        embedded = img.info.get('thumbnail')
        if embedded:
            import io
            thumb_img = Image.open(io.BytesIO(embedded)).convert('RGB')
        else:
            # Fall back to normal processing
            img.info.pop('icc_profile', None)
            thumb_img = img.convert('L').convert('RGB')

        scale = max(THUMB_SIZE / thumb_img.width, THUMB_SIZE / thumb_img.height)
        new_w = round(thumb_img.width * scale)
        new_h = round(thumb_img.height * scale)
        thumb_img = thumb_img.resize((new_w, new_h), Image.LANCZOS)
        left = (new_w - THUMB_SIZE) // 2
        top = (new_h - THUMB_SIZE) // 2
        thumb_img = thumb_img.crop((left, top, left + THUMB_SIZE, top + THUMB_SIZE))

        out = DST / (image_path.stem + '.webp')
        thumb_img.save(out, 'WEBP', quality=80)
        return f'textures/thumbs/{out.name}'
        
# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    root = tk.Tk()
    root.withdraw()

    try:
        # Scan texture files — skip the script itself and any non-texture files
        skip = {
            Path(__file__).name,
            'debug.log',
            'update-presets-debug.log',
            'debugtest.py',
            'debug_test.py',
        }
        all_files = sorted(
            f for f in os.listdir(TEXTURES_DIR)
            if Path(f).suffix.lower() in SUPPORTED_EXTS
            and not f.startswith('.')
            and f not in skip
        )

        if not all_files:
            messagebox.showinfo(
                'update-presets',
                f'No texture files found in:\n{TEXTURES_DIR}'
            )
            return

        src = PRESETS_FILE.read_text(encoding='utf-8')
        before, entries, after = parse_presets_file(src)
        existing = get_existing_files(entries)

        new_entries = []
        added       = []

        for filename in all_files:
            if filename in existing:
                continue

            group, name = parse_name(filename)
            image_path  = TEXTURES_DIR / filename
            thumb_path = generate_thumb(image_path)

            entry = (
                f"\n  {{"
                f"\n    name:  '{name}',"
                f"\n    url:   'textures/{filename}',"
                f"\n    thumb: '{thumb_path}',"
                f"\n    group: '{group}',"
                f"\n  }},"
            )
            new_entries.append(entry)
            added.append(f'  + {filename}  ->  group="{group}"  name="{name}"')

        if not new_entries:
            messagebox.showinfo(
                'update-presets',
                f'No new textures to add.\n\n'
                f'{len(existing)} file(s) already registered.'
            )
            return

        updated_src = before + entries + ''.join(new_entries) + '\n' + after
        PRESETS_FILE.write_text(updated_src, encoding='utf-8')

        summary = '\n'.join(added)
        messagebox.showinfo(
            'update-presets - Done',
            f'Added {len(new_entries)} new texture(s):\n\n'
            f'{summary}\n\n'
            f'Refresh your browser to see the changes.'
        )

    except Exception as exc:
        messagebox.showerror('update-presets - Error', str(exc))
        sys.exit(1)

    finally:
        root.destroy()


if __name__ == '__main__':
    main()