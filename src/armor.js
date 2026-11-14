// Oculus Nihili: the Void Paladin armour as the game's clothing (the pieces listed in assets/armor/armor.json: today the
// helmet with its respirator, the plate carrier, gloves, cloak and leg rig, in the Hat, Necklace, Gloves, ClothAccessory
// and Garters groups). The pieces are registered with the game before sign-in, the way the Armory's items are, and
// their pictures are fetched from the add-on's assets/armor/, built by tools/build-armor.js. Their pictures are drawn
// standing: in a pose their group draws differently they show only where those still sit right, and hide otherwise.
// Wearing the plate carrier and the helmet together is the power armour: the add-on tells the Order's server, which
// lets you carry 4 weapons while you wear it. A module of void.js's; it needs ctx.modules.guard.
(() => {
	'use strict';
	/** @type {any} */ (window).VoidOrderModules ??= {};
	/** @type {any} */ (window).VoidOrderModules.armor = (/** @type {any} */ ctx) => {
		const w = ctx.w;
		const guard = ctx.modules && ctx.modules.guard;
		if (!guard) {
			console.warn('[Oculus Nihili] the Void Paladin armour is off: the guard module did not load');
			return null;
		}
		const ARMOR = `${ctx.assets}armor/`;
		const FEATURE = 'Void Paladin armour';
		/** @type {Map<string, any>} The registered pieces (assets/armor/armor.json entries) by asset name. */
		const pieces = new Map();
		/** @type {Set<string>} Picture files the pieces have. */
		const images = new Set();
		/** @type {Map<string, string>} The pieces' texts, by the game's text key. */
		const texts = new Map();
		/** @type {string[]} The pieces that together are the power armour. */
		let powerArmor = [];

		/** Whether an asset is one of the armour's. */
		const isArmor = (/** @type {any} */ asset) =>
			!!asset && !!asset.Group && pieces.has(asset.Name) && pieces.get(asset.Name).group === asset.Group.Name;
		/** Whether character c wears every piece of the power armour. */
		function wearsPowerArmor(/** @type {any} */ c) {
			const worn = c && Array.isArray(c.Appearance) ? c.Appearance : [];
			return (
				powerArmor.length > 0 &&
				powerArmor.every((name) => worn.some((/** @type {any} */ i) => i && isArmor(i.Asset) && i.Asset.Name === name))
			);
		}

		/** Fetches the pieces and registers them, once the game has loaded its own items. */
		function start() {
			const missing = () =>
				['AssetAdd', 'AssetGroupGet', 'AssetGet'].find((f) => !guard.gameFunction(f)) ||
				(Array.isArray(w.AssetFemale3DCG) ? '' : 'AssetFemale3DCG');
			let tries = 0;
			const wait = setInterval(() => {
				if (++tries > 1200) {
					clearInterval(wait);
					guard.problem(FEATURE, 'the game never finished loading its items');
					return;
				}
				if (!Array.isArray(w.Asset) || !w.Asset.length) {
					return;
				}
				clearInterval(wait);
				if (missing()) {
					guard.problem(FEATURE, `the game has no ${missing()}`);
					return;
				}
				fetch(`${ARMOR}armor.json`, { cache: 'no-cache' })
					.then((res) => {
						if (!res.ok) {
							throw new Error(`armor.json: HTTP ${res.status}`);
						}
						return res.json();
					})
					.then((data) => {
						try {
							register(data);
						} catch (e) {
							guard.problem(FEATURE, e);
						}
					})
					.catch((e) => guard.problem(FEATURE, e));
			}, 50);
		}

		/**
		 * Adds the pieces to their clothing groups, with their pictures and texts. A name the game already has is left
		 * alone. If the game refuses one, the pieces stop there and the ones added are kept.
		 * @param {any} data assets/armor/armor.json
		 */
		function register(data) {
			if (!Array.isArray(data.pieces) || !Array.isArray(data.images) || !Array.isArray(data.powerArmor)) {
				throw new Error('armor.json is not as expected');
			}
			for (const f of data.images) {
				images.add(f);
			}
			if (!hookPictures()) {
				return;
			}
			guard.hookGame('AssetTextGet', 0, 'Armour texts', (args, next) =>
				typeof args[0] === 'string' && texts.has(args[0]) ? texts.get(args[0]) : next(args),
			);
			for (const piece of data.pieces) {
				const group = w.AssetGroupGet('Female3DCG', piece.group);
				const groupDef = w.AssetFemale3DCG.find((/** @type {any} */ g) => g && g.Group === piece.group);
				if (!group || !groupDef || !Array.isArray(group.Asset)) {
					throw new Error(`the game has no ${piece.group} group as expected`);
				}
				if (w.AssetGet('Female3DCG', piece.group, piece.name)) {
					continue;
				}
				try {
					w.AssetAdd(
						group,
						standingOnly(piece.def, group, piece.fits || []),
						piece.extended ? { [piece.group]: { [piece.name]: withoutGameMessages(piece.extended) } } : undefined,
						groupDef,
					);
				} catch (e) {
					unregister(group, piece.name);
					throw e;
				}
				const asset = w.AssetGet('Female3DCG', piece.group, piece.name);
				if (!asset) {
					throw new Error(`${piece.name} was not added`);
				}
				asset.Description = piece.description;
				pieces.set(piece.name, piece);
				for (const [k, v] of Object.entries(piece.texts || {})) {
					texts.set(k, String(v));
				}
			}
			powerArmor = data.powerArmor.filter((/** @type {string} */ n) => pieces.has(n));
			guard.hookGame('ValidationResolveRemoveDiff', 0, 'Keeping the armour on', keepOnRemove);
			ctx.onSignIn(watchPowerArmor);
		}
		/**
		 * The piece's definition for this game: drawn in the standing pictures, in every pose its group draws the same
		 * and in those of the others where they still fit (`fits`); hidden in the rest, whose pictures aren't made yet.
		 * @param {any} source
		 * @param {any} group the game's group (its pose mapping: how it draws in each pose)
		 * @param {string[]} fits
		 */
		function standingOnly(source, group, fits) {
			const def = JSON.parse(JSON.stringify(source));
			const poses = (group && group.PoseMapping) || {};
			def.PoseMapping = Object.fromEntries(
				Object.entries(poses)
					.filter(([, v]) => v !== '')
					.map(([pose]) => [pose, fits.includes(pose) ? '' : 'Hide']),
			);
			return def;
		}
		/** The extended item config, sending no message of the game's own when the option changes (it has no text for ours). */
		function withoutGameMessages(/** @type {any} */ extended) {
			return { ...extended, ScriptHooks: { ...(extended.ScriptHooks || {}), PublishAction: () => {} } };
		}
		/** Takes a half-added piece back out of the game's lists. */
		function unregister(/** @type {any} */ group, /** @type {string} */ name) {
			const drop = (/** @type {any[]} */ list) => {
				const i = Array.isArray(list) ? list.findIndex((a) => a && a.Name === name && a.Group === group) : -1;
				if (i >= 0) {
					list.splice(i, 1);
				}
			};
			drop(group.Asset);
			drop(w.Asset);
			if (w.AssetMap instanceof Map) {
				w.AssetMap.delete(`${group.Name}/${name}`);
			}
		}

		/** The add-on's address for one of the game's picture paths, or '' when it isn't the armour's. */
		function picture(/** @type {string} */ url) {
			const m = /^(?:\.\/)?Assets\/Female3DCG\/([A-Za-z]+)\/(?:(Preview)\/)?(VoidPaladin[A-Za-z0-9]+?)(?:_([A-Za-z0-9]+))?\.png$/.exec(url);
			const piece = m && pieces.get(m[3]);
			if (!m || !piece || piece.group !== m[1]) {
				return '';
			}
			if (m[2]) {
				return m[4] ? '' : `${ARMOR}preview/${piece.name}.png`;
			}
			const file = `img/${piece.group}/${piece.name}_${m[4]}.png`;
			return images.has(file) ? `${ARMOR}${file}` : '';
		}
		/** Sends the game's requests for the armour's pictures to the add-on's copies, and gives its buttons their pictures. */
		function hookPictures() {
			const ok = guard.hookGame('CommonFetch', 10, FEATURE, (args, next) => {
				const url = typeof args[0] === 'string' ? picture(args[0]) : '';
				return next(url ? [url, ...args.slice(1)] : args);
			});
			if (ok && guard.gameFunction('ElementButton.CreateForAsset')) {
				guard.hookGame('ElementButton.CreateForAsset', 0, 'Armour buttons', (args, next) => {
					const asset = args[1] && ('Asset' in args[1] ? args[1].Asset : args[1]);
					if (!isArmor(asset)) {
						return next(args);
					}
					const options = { ...(args[4] || {}) };
					options.image ??= `${ARMOR}preview/${asset.Name}.png`;
					return next([args[0], args[1], args[2], args[3], options, ...args.slice(5)]);
				});
			}
			return ok;
		}

		// ---- Players who don't have the add-on
		/** Whether the player with that member number is known to use Oculus Nihili (you always do). */
		function usesAddOn(/** @type {number} */ member) {
			if (w.Player && member === w.Player.MemberNumber) {
				return true;
			}
			const c = Array.isArray(w.Character) ? w.Character.find((/** @type {any} */ x) => x && x.MemberNumber === member) : null;
			return !!(c && c.OnlineSharedSettings && c.OnlineSharedSettings.OculusNihili);
		}
		/**
		 * Keeps your armour when someone without the add-on changes your outfit: their game doesn't know the pieces, so the
		 * outfit it sends leaves them out, which the game would otherwise take as removing them.
		 */
		function keepOnRemove(/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) {
			const [previous, params] = args;
			const c = params && params.C;
			if (
				previous &&
				isArmor(previous.Asset) &&
				c &&
				typeof c.IsPlayer === 'function' &&
				c.IsPlayer() &&
				!params.fromSelf &&
				typeof params.sourceMemberNumber === 'number' &&
				!usesAddOn(params.sourceMemberNumber)
			) {
				return { item: previous, valid: false };
			}
			return next(args);
		}

		// ---- The power armour: told to the Order's server, which raises your carry limit while you wear it
		/** What the server was last told (null: nothing yet this session). */
		let told = /** @type {boolean | null} */ (null);
		let sending = false;
		let watching = false;
		/** Tells the server whether you wear the power armour, whenever that changes (and once after signing in). */
		function watchPowerArmor() {
			if (watching) {
				return;
			}
			watching = true;
			const check = () =>
				(async () => {
					if (sending || !w.Player || !ctx.isMember()) {
						return;
					}
					const on = wearsPowerArmor(w.Player);
					if (on === told) {
						return;
					}
					sending = true;
					try {
						const r = await ctx.req({ t: 'armor', on });
						if (r && r.t === 'ok') {
							told = on;
							if (Array.isArray(r.dropped) && r.dropped.length) {
								ctx.note(`Out of the power armour you carry 2 weapons: you put down ${r.dropped.join(' and ')}.`);
							}
						}
					} finally {
						sending = false;
					}
				})().catch((e) => guard.problem(FEATURE, e));
			check();
			setInterval(check, 1500);
			ctx.onServer((/** @type {any} */ x) => {
				// A new connection starts from what the server has, so it is told again.
				if (x && x.t === 'state' && x.me && !!x.me.armor !== told) {
					told = null;
				}
			});
		}

		start();
		return { isArmor, wearsPowerArmor, armorPieces: pieces };
	};
})();
