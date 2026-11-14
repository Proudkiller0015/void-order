// Builds the Void Paladin armour for Oculus Nihili from the armour drawings' output folder.
//   node tools/build-armor.js [path/to/armor/out]
// The folder holds pieces.json (each piece: its clothing group, layers with Left/Top on the game's 500 x 1000 character
// canvas, colours, options) and <Group>/<Asset>_<Layer>.png, plus preview-<Asset>.png. It writes:
//   assets/armor/armor.json   the pieces: asset definitions, extended item configs, texts, the image list, the power armour
//   assets/armor/img/         the layer images, as <Group>/<Asset>_<Layer>.png
//   assets/armor/preview/     each piece's tile picture
// Run it again whenever the drawings change; files no longer used are removed.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC = path.resolve(process.argv[2] || path.join(REPO, '..', 'void-weapons', 'armor', 'out'));
const OUT = path.join(REPO, 'assets', 'armor');
/** The clothing groups the armour may use. */
const GROUPS = ['Hat', 'Mask', 'Necklace', 'Gloves', 'ClothAccessory', 'Garters'];
const NAME = /^VoidPaladin[A-Za-z0-9]+$/;
const LAYER = /^[A-Za-z0-9]+$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
/**
 * The poses (of those a piece's group draws differently) in which a piece's standing pictures still sit right, as seen
 * in renders of each pose: there they are drawn as they are; in the others the piece hides until it has their pictures.
 * The helmet, the plate carrier and the cloak are in groups that draw the same in every pose.
 */
const STANDING_FITS = {
	VoidPaladinGloves: ['TapedHands'],
	VoidPaladinLegRig: ['Kneel', 'KneelingSpread', 'LegsClosed', 'Spread'],
};

const fail = (/** @type {string} */ why) => {
	throw new Error(why);
};
const source = JSON.parse(fs.readFileSync(path.join(SRC, 'pieces.json'), 'utf8'));
if (!Array.isArray(source.pieces) || !Array.isArray(source.powerArmor)) {
	fail('pieces.json needs "pieces" and "powerArmor"');
}

/** @type {Set<string>} Files written, relative to assets/armor. */
const written = new Set();
const changed = [];
function copy(/** @type {string} */ from, /** @type {string} */ to) {
	const data = fs.readFileSync(from);
	if (data.subarray(1, 4).toString() !== 'PNG') {
		fail(`${from} is not a PNG`);
	}
	const target = path.join(OUT, to);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	if (!fs.existsSync(target) || !fs.readFileSync(target).equals(data)) {
		fs.writeFileSync(target, data);
		changed.push(to);
	}
	written.add(to.split(path.sep).join('/'));
}

const pieces = source.pieces.map((/** @type {any} */ p) => {
	if (!NAME.test(p.Name) || !GROUPS.includes(p.Group) || !Array.isArray(p.Layer) || !p.Layer.length) {
		fail(`piece ${p.Name}: needs a VoidPaladin name, one of ${GROUPS.join(', ')} and layers`);
	}
	// A piece's choices: "Options" (one list: a typed item) or "Modules" (several lists, each with its options: a modular
	// item). An option may hide body groups ("Hide") and the piece's own layers ("HideLayers": names or their starts).
	const options = Array.isArray(p.Options) ? p.Options : [];
	const modules = Array.isArray(p.Modules) ? p.Modules : [];
	if (options.length && modules.length) {
		fail(`piece ${p.Name}: Options or Modules, not both`);
	}
	/** Every list of choices: [its key in AllowTypes, its options]. */
	const lists = options.length ? [['typed', options]] : modules.map((/** @type {any} */ m) => [m.Name, m.Options || []]);
	if (modules.some((/** @type {any} */ m) => !LAYER.test(m.Name) || !Array.isArray(m.Options) || !m.Options.length)) {
		fail(`piece ${p.Name}: each module needs a name and options`);
	}
	/** The options of a list in which a layer shows: all but those whose HideLayers names it (or its start). */
	const shownIn = (/** @type {any[]} */ list, /** @type {string} */ layer) =>
		list
			.map((o, i) => [o, i])
			.filter(([o]) => !(o.HideLayers || []).some((/** @type {string} */ h) => layer.startsWith(h)))
			.map(([, i]) => i);
	const layers = p.Layer.map((/** @type {any} */ l) => {
		if (!LAYER.test(l.Name) || !Number.isFinite(l.Left) || !Number.isFinite(l.Top) || !COLOR.test(l.Color || '')) {
			fail(`piece ${p.Name}, layer ${l.Name}: needs a name, Left, Top and a #rrggbb colour`);
		}
		const file = path.join(SRC, p.Group, `${p.Name}_${l.Name}.png`);
		copy(file, path.join('img', p.Group, `${p.Name}_${l.Name}.png`));
		/** @type {Record<string, any>} */
		const layer = { Name: l.Name, Left: l.Left, Top: l.Top, Priority: l.Priority ?? p.Priority, ParentGroup: '' };
		// Every layer with a colour takes it, the glow included (its art is white, so its colour is the glow's).
		layer.AllowColorize = l.AllowColorize !== false;
		// The game takes a layer's default colour from the layer (older versions from the item's DefaultColor).
		if (layer.AllowColorize) {
			layer.Color = [l.Color];
		}
		/** @type {Record<string, number[]>} */
		const allow = {};
		for (const [k, list] of lists) {
			const shown = shownIn(list, l.Name);
			if (shown.length < list.length) {
				allow[k] = shown;
			}
		}
		if (Object.keys(allow).length) {
			layer.AllowTypes = allow;
		}
		return { layer, color: l.Color };
	});
	const preview = path.join(SRC, `preview-${p.Name}.png`);
	if (fs.existsSync(preview)) {
		copy(preview, path.join('preview', `${p.Name}.png`));
	}
	// The pieces hide only through their options, so a piece without options hides nothing.
	const hide = lists.length ? [] : Array.isArray(p.Hide) ? p.Hide : [];
	const def = {
		Name: p.Name,
		ParentGroup: '',
		Priority: p.Priority,
		Value: 0,
		Hide: hide,
		DefaultColor: layers.filter((x) => x.layer.AllowColorize).map((x) => x.color),
		Layer: layers.map((x) => x.layer),
	};
	if (!def.DefaultColor.length) {
		delete def.DefaultColor;
	}
	const key = `${p.Group}${p.Name}`;
	/** @type {Record<string, string>} */
	const texts = {};
	/** An option in the game's form: its body groups to hide, if any. */
	const asOption = (/** @type {any} */ o) => (Array.isArray(o.Hide) && o.Hide.length ? { Property: { Hide: o.Hide } } : {});
	/** "NeckCover" → "Neck cover". */
	const words = (/** @type {string} */ name) => {
		const t = String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
		return t.charAt(0) + t.slice(1).toLowerCase();
	};
	let extended = null;
	if (modules.length) {
		extended = {
			Archetype: 'modular',
			Modules: modules.map((/** @type {any} */ m) => ({ Name: m.Name, Key: m.Name, Options: m.Options.map(asOption) })),
		};
		texts[`${key}SelectBase`] = `${p.Description}: choose how it is worn.`;
		for (const m of modules) {
			texts[`${key}Module${m.Name}`] = words(m.Name);
			texts[`${key}Select${m.Name}`] = `${words(m.Name)}:`;
			m.Options.forEach((/** @type {any} */ o, /** @type {number} */ i) => {
				texts[`${key}Option${m.Name}${i}`] = words(o.Name);
			});
		}
	}
	if (options.length) {
		extended = {
			Archetype: 'typed',
			Options: options.map((/** @type {any} */ o) => ({ Name: o.Name, ...asOption(o) })),
		};
		texts[`${key}Select`] = `${p.Description}: choose how it is worn.`;
		for (const o of options) {
			texts[`${key}${o.Name}`] = words(o.Name);
		}
	}
	const fits = STANDING_FITS[/** @type {keyof typeof STANDING_FITS} */ (p.Name)] || [];
	return { name: p.Name, group: p.Group, description: p.Description, def, extended, texts, fits };
});

const unknown = source.powerArmor.filter((/** @type {string} */ n) => !pieces.some((p) => p.name === n));
if (unknown.length) {
	fail(`powerArmor names pieces that aren't there: ${unknown.join(', ')}`);
}
const images = [...written].filter((f) => f.startsWith('img/')).sort();
// Uniforms: complete fits worn in one go from the wardrobe, and each of their items on its own. Each item names a group,
// an asset (the game's own or one of the pieces) and its colours (one, or one per layer).
const uniforms = source.uniforms || {};
for (const [id, u] of Object.entries(uniforms)) {
	const bad = !LAYER.test(id) || !u.Description || !Array.isArray(u.Items) || !u.Items.length;
	const badItem = (u.Items || []).find(
		(/** @type {any} */ x) =>
			!LAYER.test(x.Group || '') ||
			!LAYER.test(x.Name || '') ||
			!(COLOR.test(x.Color) || (Array.isArray(x.Color) && x.Color.every((/** @type {string} */ c) => COLOR.test(c)))),
	);
	if (bad || badItem) {
		fail(`uniform ${id}: needs a description and items with a group, a name and colours (${JSON.stringify(badItem || id)})`);
	}
}
const data = { powerArmor: source.powerArmor, pieces, images, uniforms };
const json = `${JSON.stringify(data, null, '\t')}\n`;
const target = path.join(OUT, 'armor.json');
if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== json) {
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(target, json);
	changed.push('armor.json');
}
written.add('armor.json');
// Files from an older build that no piece uses any more.
const walk = (/** @type {string} */ dir) =>
	fs.existsSync(dir)
		? fs
				.readdirSync(dir, { withFileTypes: true })
				.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
		: [];
for (const f of walk(OUT)) {
	const rel = path.relative(OUT, f).split(path.sep).join('/');
	if (!written.has(rel)) {
		fs.rmSync(f);
		changed.push(`-${rel}`);
	}
}
// Folders left empty.
for (const dir of fs.existsSync(path.join(OUT, 'img')) ? fs.readdirSync(path.join(OUT, 'img')) : []) {
	const full = path.join(OUT, 'img', dir);
	if (fs.statSync(full).isDirectory() && !fs.readdirSync(full).length) {
		fs.rmdirSync(full);
	}
}
console.log(`${pieces.length} pieces, ${images.length} images; ${changed.length ? `${changed.length} files changed` : 'nothing changed'}`);
