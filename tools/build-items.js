// Builds the Armory's hand-held items for Oculus Nihili from the Bondage Club checkout where the weapons were made.
//   node tools/build-items.js [path/to/bc-void-weapons] [git ref]
// It reads that checkout's committed files at the ref (default HEAD), never its working tree, and writes:
//   assets/items/items.json   the items: asset definitions, extended item configs, texts and the image list
//   assets/items/img/         the layer images, under their names in the game's checkout
//   assets/items/preview/     each item's tile picture
//   assets/items/options/     each weapon's option picture (with the Void mark or the catalog mark)
// tools/items-index.json keeps every item's weapons in a fixed order: an option's number is what a saved outfit
// stores, so a weapon added later always goes at the end of its item and nothing already worn changes.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const SRC = path.resolve(process.argv[2] || path.join(REPO, '..', 'bc-void-weapons'));
const REF = process.argv[3] || 'HEAD';
const OUT = path.join(REPO, 'assets', 'items');
const INDEX = path.join(__dirname, 'items-index.json');
const PAGES = 'https://proudkiller0015.github.io/void-order/assets/items';
const GROUP = 'ItemHandheld';
/** The checkout's carry options (the Weapons item's Position module), by number: what each is, for the add-on's lines. */
const CARRY_IDS = ['trigger', 'portarms', 'shoulder', 'back'];
/** Blades, maces and staffs say "Held" where guns say "Hand on the trigger". */
const BLADE_KINDS = ['Swords', 'GlowingBlades', 'ShortBlades', 'Blunt', 'Staffs'];
/** Queen's Wrath's carry options, by number. */
const WRATH_CARRY_IDS = ['held', 'front', 'back'];
/** Each kind's item name, as it reads after the game's "a" ("swaps a void sword for a void rifle"). */
const DESCRIPTIONS = {
	Pistols: 'Void pistol',
	SMGs: 'Void SMG',
	Rifles: 'Void rifle',
	SniperRifles: 'Void sniper rifle',
	Shotguns: 'Void shotgun',
	Crossbows: 'Void crossbow',
	Swords: 'Void sword',
	GlowingBlades: 'Void glowing blade',
	ShortBlades: 'Void short blade',
	Blunt: 'Void blunt weapon',
	Staffs: 'Void staff',
};
/** Where a category goes when it has too few weapons to be an item of its own. */
const MERGE_INTO = {
	SMGs: 'Pistols',
	Shotguns: 'Rifles',
	SniperRifles: 'Rifles',
	Crossbows: 'Rifles',
	GlowingBlades: 'Swords',
	ShortBlades: 'Swords',
	Blunt: 'Swords',
	Staffs: 'Swords',
};
/** Most weapons a category may hold and still be merged into another. */
const MERGE_AT_MOST = 2;
/** Marks a spread of the game's pose mapping for a group, resolved in the game. */
const POSE_MAPPING = '__poseMapping';
/** Marks a reference to one of the game's functions, which the add-on doesn't use. */
const GAME_FUNCTION = '__gameFunction';

const git = (...args) => execFileSync('git', ['-C', SRC, ...args], { maxBuffer: 256 * 1024 * 1024 });
const show = (file) => git('show', `${REF}:BondageClub/${file}`).toString('utf8');

/**
 * The source text of the object literal around `anchor` (the first match after `after`), found by following braces
 * outside strings and comments.
 */
function objectAround(src, anchor, after = 0) {
	const at = src.indexOf(anchor, after);
	if (at < 0) {
		throw new Error(`${anchor} not found`);
	}
	const stack = [];
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === '/' && src[i + 1] === '/') {
			i = src.indexOf('\n', i);
		} else if (c === '/' && src[i + 1] === '*') {
			i = src.indexOf('*/', i) + 1;
		} else if (c === '"' || c === "'" || c === '`') {
			for (i++; src[i] !== c; i++) {
				if (src[i] === '\\') {
					i++;
				}
			}
		} else if (c === '{') {
			stack.push(i);
		} else if (c === '}') {
			const start = stack.pop();
			if (start < at && i > at) {
				return src.slice(start, i + 1);
			}
		}
	}
	throw new Error(`no object around ${anchor}`);
}

/** An object literal from the game's asset files, its references to the game resolved or marked. */
function evaluate(text) {
	const known = {
		AssetPoseMapping: new Proxy({}, { get: (_, group) => ({ [POSE_MAPPING]: group }) }),
		PoseType: { HIDE: 'Hide', DEFAULT: '' },
		ExtendedArchetype: {
			MODULAR: 'modular',
			TYPED: 'typed',
			VIBRATING: 'vibrating',
			VARIABLEHEIGHT: 'variableheight',
			TEXT: 'text',
			NOARCH: 'noarch',
		},
	};
	const scope = new Proxy(known, {
		has: (t, k) => typeof k === 'string' && (k in t || (/^[A-Z][A-Za-z0-9]*$/.test(k) && !(k in globalThis))),
		get: (t, k) => (k in t ? t[k] : k === Symbol.unscopables ? undefined : { [GAME_FUNCTION]: k }),
	});
	return new Function('scope', `with (scope) { return (${text}); }`)(scope);
}

/** The rows of a CSV of `key,text` whose key starts with `prefix`. */
function csvRows(file, prefix) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const line of show(file).split(/\r?\n/)) {
		const comma = line.indexOf(',');
		const key = line.slice(0, comma);
		if (comma > 0 && key.startsWith(prefix)) {
			let text = line.slice(comma + 1);
			if (text.startsWith('"') && text.endsWith('"')) {
				text = text.slice(1, -1).replace(/""/g, '"');
			}
			out[key] = text;
		}
	}
	return out;
}

/** The option numbers in an AllowTypes value. */
const allowed = (v) => (Array.isArray(v) ? v : [v]);

function main() {
	const assets = show('Assets/Female3DCG.js');
	const handheld = assets.indexOf(`Group: "${GROUP}"`);
	const weaponsDef = evaluate(objectAround(assets, 'Name: "Weapons",', handheld));
	const wrathDef = evaluate(objectAround(assets, 'Name: "QueensWrath",', handheld));
	const wrathExt = evaluate(
		objectAround(
			show('Assets/Female3DCGExtended.js'),
			'Archetype: ExtendedArchetype.MODULAR,',
			show('Assets/Female3DCGExtended.js').indexOf('\t\tQueensWrath: {'),
		),
	);
	const wrathStrings = csvRows('Assets/AssetStrings.csv', `${GROUP}QueensWrath`);
	const extended = show('Assets/Female3DCGExtended.js');
	const weaponsExt = evaluate(objectAround(extended, 'Archetype: ExtendedArchetype.MODULAR,', extended.indexOf('\t\tWeapons: {')));
	const strings = csvRows('Assets/AssetStrings.csv', `${GROUP}Weapons`);
	const layerNames = { ...csvRows('Assets/LayerNames.csv', `${GROUP}Weapons`), ...csvRows('Assets/LayerNames.csv', `${GROUP}QueensWrath`) };

	// The weapons of each category, in the checkout's order: [category, [weapon key, option config, old number]].
	const categories = weaponsExt.Modules.filter((m) => m.Name !== 'Position').map((m) => ({
		key: m.Key,
		weapons: m.Options.map((o, i) => ({
			key: path.basename(m.DrawData.elementData[i].imagePath, '.png'),
			option: o,
			old: i,
			name: strings[`${GROUP}WeaponsOption${m.Key}${i}`],
			set: strings[`${GROUP}WeaponsSet${m.Key}${i}`],
		})).slice(1),
	}));
	const position = weaponsExt.Modules.find((m) => m.Name === 'Position');

	// Which item each weapon is in, and its number there: kept from earlier builds, new weapons at the end.
	/** @type {Record<string, string[]>} */
	const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
	const itemOf = (weapon) => Object.keys(index).find((item) => index[item].includes(weapon));
	for (const cat of categories) {
		const fresh = cat.weapons.filter((w) => !itemOf(w.key));
		if (!fresh.length) {
			continue;
		}
		const own = `Void${cat.key}`;
		const target = index[own] || cat.weapons.length > MERGE_AT_MOST || !MERGE_INTO[cat.key] ? own : `Void${MERGE_INTO[cat.key]}`;
		index[target] = [...(index[target] || []), ...fresh.map((w) => w.key)];
	}
	const all = new Map(categories.flatMap((cat) => cat.weapons.map((w) => [w.key, { ...w, cat: cat.key }])));
	for (const [item, keys] of Object.entries(index)) {
		const gone = keys.filter((k) => !all.has(k));
		if (gone.length) {
			throw new Error(`${item}: ${gone.join(', ')} no longer in the checkout; a saved outfit may use them`);
		}
	}

	// Layer images and option pictures, from the checkout at the ref.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'void-items-'));
	const tar = path.join(tmp, 'art.tar');
	fs.writeFileSync(tar, git('archive', REF, `BondageClub/Assets/Female3DCG/${GROUP}`, `BondageClub/Screens/Inventory/${GROUP}/Weapons`));
	execFileSync('tar', ['-xf', 'art.tar'], { cwd: tmp });
	const art = path.join(tmp, 'BondageClub', 'Assets', 'Female3DCG', GROUP);
	const optionArt = path.join(tmp, 'BondageClub', 'Screens', 'Inventory', GROUP, 'Weapons');

	const changed = [];
	const write = (file, data) => {
		const target = path.join(OUT, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		if (fs.existsSync(target) && fs.readFileSync(target).equals(data)) {
			return;
		}
		fs.writeFileSync(target, data);
		changed.push(path.relative(REPO, target).replace(/\\/g, '/'));
	};
	const images = new Set();
	const copyImage = (from, to) => {
		write(to, fs.readFileSync(from));
		images.add(to);
	};

	const base = { ...weaponsDef };
	delete base.Name;
	delete base.Layer;
	const items = [];
	for (const [name, keys] of Object.entries(index)) {
		const weapons = keys.map((k) => all.get(k));
		const numberOf = new Map(weapons.map((w, i) => [`${w.cat}:${w.old}`, i]));
		const layers = [];
		for (const layer of weaponsDef.Layer) {
			if (!layer.AllowTypes) {
				layers.push(layer);
				continue;
			}
			const cat = Object.keys(layer.AllowTypes).find((k) => k !== 'Position');
			if (!cat) {
				// For every weapon of every item (the Hand layer: by carry only).
				layers.push({ ...layer, AllowTypes: { ...layer.AllowTypes } });
				copyImage(path.join(art, `Weapons_${layer.Name}.png`), `img/Weapons_${layer.Name}.png`);
				continue;
			}
			const numbers = allowed(layer.AllowTypes[cat])
				.map((n) => numberOf.get(`${cat}:${n}`))
				.filter((n) => n !== undefined);
			if (!numbers.length) {
				continue;
			}
			const rest = { ...layer.AllowTypes };
			delete rest[cat];
			layers.push({ ...layer, AllowTypes: { w: numbers.length === 1 ? numbers[0] : numbers, ...rest } });
			copyImage(path.join(art, `Weapons_${layer.Name}.png`), `img/Weapons_${layer.Name}.png`);
		}
		// The carries this item's weapons have pictures for, numbered from 0 in the item (swords: held, on the back).
		const used = [
			...new Set(layers.flatMap((l) => (l.AllowTypes && 'Position' in l.AllowTypes ? allowed(l.AllowTypes.Position) : []))),
		].sort((a, b) => a - b);
		const renumber = new Map(used.map((n, i) => [n, i]));
		for (const l of layers) {
			if (l.AllowTypes && 'Position' in l.AllowTypes) {
				const ns = allowed(l.AllowTypes.Position).map((n) => renumber.get(n));
				l.AllowTypes = { ...l.AllowTypes, Position: ns.length === 1 ? ns[0] : ns };
			}
		}
		const carried = used.length > 1;
		for (const w of weapons) {
			copyImage(path.join(optionArt, `${w.key}.png`), `options/${w.key}.png`);
		}
		copyImage(path.join(optionArt, `${weapons[0].key}.png`), `preview/${name}.png`);
		const cat = name.slice('Void'.length);
		const prefix = `${GROUP}${name}`;
		/** @type {Record<string, string>} */
		const texts = {
			[`${prefix}SelectBase`]: 'Select a weapon:',
			[`${prefix}ModuleWeapon`]: 'Weapon',
			[`${prefix}SelectWeapon`]: strings[`${GROUP}WeaponsSelect${cat}`] || 'Select a weapon:',
		};
		weapons.forEach((w, i) => {
			texts[`${prefix}Optionw${i}`] = w.name;
			texts[`${prefix}Setw${i}`] = w.set;
		});
		if (carried) {
			texts[`${prefix}ModulePosition`] = strings[`${GROUP}WeaponsModulePosition`] || 'Carry';
			texts[`${prefix}SelectPosition`] = strings[`${GROUP}WeaponsSelectPosition`] || 'How to carry it:';
			used.forEach((n, i) => {
				const label = n === 0 && BLADE_KINDS.includes(cat) ? 'Held' : strings[`${GROUP}WeaponsOptionPosition${n}`];
				texts[`${prefix}OptionPosition${i}`] = label;
				texts[`${prefix}SetPosition${i}`] = strings[`${GROUP}WeaponsSetPosition${n}`];
			});
		}
		items.push({
			name,
			// The game writes "a <description>" in lower case in its lines ("uses a void rifle on…").
			description: DESCRIPTIONS[cat] || `Void ${cat.toLowerCase()}`,
			weapons: weapons.map((w) => ({ key: w.key, name: w.name, cat: w.cat })),
			carries: carried ? used.map((n) => (n === 0 && BLADE_KINDS.includes(cat) ? 'held' : CARRY_IDS[n])) : [],
			source: 'Weapons',
			def: { Name: name, ...base, Layer: layers },
			extended: {
				...weaponsExt,
				ScriptHooks: undefined,
				Modules: [
					{
						Name: 'Weapon',
						Key: 'w',
						DrawImages: true,
						Options: weapons.map((w) => w.option),
						DrawData: { elementData: weapons.map((w) => ({ imagePath: `${PAGES}/options/${w.key}.png` })) },
					},
					...(carried ? [{ ...position, Options: used.map((n) => position.Options[n]) }] : []),
				],
			},
			texts,
			layerNames: Object.fromEntries(
				Object.entries(layerNames)
					.filter(([k]) => k.startsWith(`${GROUP}Weapons`))
					.map(([k, v]) => [k.replace(`${GROUP}Weapons`, prefix), v]),
			),
		});
	}

	for (const layer of wrathDef.Layer.filter((l) => l.HasImage !== false)) {
		copyImage(path.join(art, `QueensWrath_${layer.Name}.png`), `img/QueensWrath_${layer.Name}.png`);
	}
	copyImage(path.join(art, 'Preview', 'QueensWrath.png'), 'preview/QueensWrath.png');
	items.push({
		name: 'QueensWrath',
		description: "Queen's Wrath scythe",
		weapons: [{ key: 'QueensWrath', name: "Queen's Wrath", cat: 'Scythes' }],
		carries: WRATH_CARRY_IDS,
		source: 'QueensWrath',
		def: wrathDef,
		extended: { ...wrathExt, ScriptHooks: undefined },
		texts: Object.fromEntries(Object.entries(wrathStrings).filter(([k]) => /(Select|Module|Option|Set)/.test(k))),
		layerNames: Object.fromEntries(Object.entries(layerNames).filter(([k]) => k.startsWith(`${GROUP}QueensWrath`))),
	});

	const data = {
		group: GROUP,
		source: `${REF === 'HEAD' ? git('rev-parse', '--short', 'HEAD').toString().trim() : REF}`,
		items,
		images: [...images].sort(),
	};
	write('items.json', Buffer.from(`${JSON.stringify(data, null, '\t')}\n`));
	fs.writeFileSync(INDEX, `${JSON.stringify(index, null, '\t')}\n`);
	for (const dir of ['img', 'options', 'preview']) {
		for (const f of fs.existsSync(path.join(OUT, dir)) ? fs.readdirSync(path.join(OUT, dir)) : []) {
			if (!images.has(`${dir}/${f}`)) {
				fs.unlinkSync(path.join(OUT, dir, f));
				changed.push(`removed assets/items/${dir}/${f}`);
			}
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(items.map((i) => `${i.name}: ${i.weapons.length}`).join('\n'));
	console.log(`${images.size} images; ${changed.length ? `${changed.length} files changed` : 'nothing changed'}`);
}

main();
