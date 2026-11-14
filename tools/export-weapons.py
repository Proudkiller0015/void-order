"""Export the Armory's weapon sprites and index from the weapons project.

    python tools/export-weapons.py [path/to/void-weapons]

Reads the weapons project (default: ../void-weapons next to this repository) and writes, in this
repository:

- assets/weapons/<id>.png: each finished weapon in its default colours, trimmed to its outline, at most
  360 px on its longer side, transparent.
- assets/weapons/index.json: every weapon in the catalog (id, name, rarity, heroic, void, melee, kind,
  stats, sprite), whether or not its sprite is finished yet.

A weapon is finished when the pilot config lists it, or when the batch state has it with all three of its
layer files and it was not rejected. Running again only rewrites files whose bytes change, and removes the
sprite of a weapon that is no longer finished. The weapons project is only read.
"""

import ast
import io
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / 'assets' / 'weapons'
SIZE = 360
ZONES = ('Metal', 'Grip', 'Glow')
QUEENS_WRATH = 100
QUEENS_WRATH_ART = Path('queens-wrath') / 'layers' / 'qw-default.png'
# Queen's Wrath is in no catalog: what the Armory says about it.
QUEENS_WRATH_ENTRY = {
    'rarity': 'Legendary',
    'kind': 'Scythes',
    'lore': "Slime Queen Samantha's signature scythe. It weighs 2 tons, and at its Queen's will anything from 5 kg to "
            '1,000 tons; it casts spells and changes its form.',
}


def read_json(path, tries=5):
    """Reads a JSON file another process may be rewriting: a half-written file is retried."""
    for attempt in range(tries):
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            if attempt == tries - 1:
                raise
            time.sleep(0.5)


def literal(path, name):
    """The value of a top-level `name = <literal>` in a Python file, read without running the file."""
    tree = ast.parse(path.read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(f'{name} not found in {path}')


def sprite(base, colors, flip=False):
    """A weapon in the given colours: each zone of the grey layer tinted by its colour, cut out by the mask."""
    L = np.asarray(Image.open(f'{base}-L.png')).astype(np.float32)
    m = np.asarray(Image.open(f'{base}-mask.png')).astype(np.float32)
    z = np.load(f'{base}-zone.npy')
    out = np.zeros(L.shape + (3,), np.float32)
    for zi, name in enumerate(ZONES):
        sel = (z == zi) & (m > 0)
        if not sel.any():
            continue
        v = L * (128.0 / max(1.0, np.median(L[sel])))
        c = np.array([int(colors.get(name, '#808080')[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
        out[sel] = np.clip(c * (3 * np.clip(v[sel], 0, 255)[:, None] / 383.0), 0, 255)
    im = Image.fromarray(np.dstack([out, m]).astype(np.uint8), 'RGBA')
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im.crop(im.getbbox())


def png_bytes(im):
    """The sprite scaled to fit SIZE x SIZE and saved as a 256-colour PNG with alpha and no text chunks:
    about a fifth of the size of a full-colour one, with a little less shading."""
    im = im.copy()
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    a = np.asarray(im).copy()
    a[a[:, :, 3] == 0] = 0
    im = Image.fromarray(a, 'RGBA').quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def finished(project):
    """Each finished weapon's id → (layer file base, colours, flipped)."""
    out = {}
    pilot = read_json(project / 'pilot' / 'pilot.json')
    for w in pilot['weapons']:
        wid = int(w['work'].split('/w')[-1])
        out[wid] = (project / w['work'], w['colors'], False)
    state = read_json(project / 'batches' / 'state.json')
    for k, v in state.items():
        wid = int(k)
        if wid in out or v.get('reject') or 'work' not in v:
            continue
        base = project / v['work']
        if not all(Path(f'{base}{suffix}').exists() for suffix in ('-L.png', '-mask.png', '-zone.npy')):
            continue
        out[wid] = (base, v['colors'], v.get('flipped', False))
    return out


def catalog_stats(project, weapons):
    """Each weapon's stat lines from the catalog text: the signed lines (and a "Damage (…)" line) right after
    its rarity line, as written. Weapons not in the catalog get none."""
    pages = {}
    page = None
    for line in (project / 'catalog.txt').read_text(encoding='utf-8').split('\n'):
        m = re.match(r'=== page (\d+)', line)
        if m:
            page = int(m.group(1))
            continue
        pages.setdefault(page, []).append(line.strip())
    stats = {}
    for w in weapons:
        lines = pages.get(w['page'], [])
        stats[w['id']] = []
        for i, line in enumerate(lines):
            if line != w['name'].strip():
                continue
            rest = [x for x in lines[i + 1:] if x]
            if not rest or ' '.join(rest[0].split()) != ' '.join(w['rarity'].split()):
                continue
            for x in rest[1:]:
                if re.match(r'[+-]\s*\d', x) or re.match(r'Damage\b', x):
                    stats[w['id']].append(' '.join(x.split()))
                else:
                    break
            break
    return stats


def rarity_of(text):
    """The plain rarity ("Very rare") and whether the weapon is heroic, from the catalog's rarity line."""
    heroic = 'Heroic weapon' in text
    base = re.sub(r'Void Order (weapon|staff)|Heroic weapon', '', text)
    return ' '.join(base.split()), heroic


def write_if_changed(path, data, changes):
    """Writes `data` unless the file already holds it; a text file checked out with CRLF line ends counts as the same."""
    if path.exists():
        old = path.read_bytes()
        if old == data or (path.suffix == '.json' and old.replace(b'\r\n', b'\n') == data):
            return
    path.write_bytes(data)
    changes.append(path.relative_to(REPO).as_posix())


def main():
    project = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO.parent / 'void-weapons'
    weapons = sorted(read_json(project / 'weapons.json'), key=lambda w: w['id'])
    categories = literal(project / 'tools' / 'batch.py', 'CATEGORIES')
    names = literal(project / 'tools' / 'fullcfg.py', 'NAMES')
    kind = {i: names[key][0] for key, ids in categories for i in ids}
    stats = catalog_stats(project, weapons)
    done = finished(project)

    OUT.mkdir(parents=True, exist_ok=True)
    changes = []
    for wid, (base, colors, flip) in sorted(done.items()):
        if wid == QUEENS_WRATH and (project / QUEENS_WRATH_ART).exists():
            # Queen's Wrath has its own finished drawing; its layer files are an early version.
            art = Image.open(project / QUEENS_WRATH_ART).convert('RGBA')
            write_if_changed(OUT / f'{wid}.png', png_bytes(art.crop(art.getbbox())), changes)
            continue
        write_if_changed(OUT / f'{wid}.png', png_bytes(sprite(base, colors, flip)), changes)
    for old in OUT.glob('*.png'):
        if old.stem.isdigit() and int(old.stem) not in done:
            old.unlink()
            changes.append(f'removed {old.relative_to(REPO).as_posix()}')

    index = []
    for w in weapons:
        rarity, heroic = rarity_of(w['rarity'])
        index.append({
            'id': w['id'],
            'name': w['name'],
            'rarity': rarity,
            'heroic': heroic,
            'void': w['void'],
            'melee': w['melee'],
            'kind': kind.get(w['id']),
            'stats': stats.get(w['id'], []),
            'sprite': w['id'] in done,
            **(QUEENS_WRATH_ENTRY if w['id'] == QUEENS_WRATH else {}),
        })
    text = json.dumps(index, ensure_ascii=False, indent='\t') + '\n'
    write_if_changed(OUT / 'index.json', text.encode('utf-8'), changes)

    print(f'{len(done)} of {len(weapons)} weapons have sprites')
    print('\n'.join(changes) if changes else 'nothing changed')


if __name__ == '__main__':
    main()
