// Oculus Nihili: the Armory's weapons as the game's hand-held items. Each weapon category is one item in the
// ItemHandheld group (its weapons are the options of its "Weapon" module, key "w", and guns have a "Position" module
// for how they are carried), and Queen's Wrath is an item of its own. They are registered with the game before sign-in,
// since an outfit holding one only loads if the game knows the item by then. The definitions, texts and pictures are
// built by tools/build-items.js into assets/items/; the pictures are fetched from there instead of the game's server.
// A module of void.js's; it needs ctx.modules.guard, and without it the items stay off.
(() => {
	'use strict';
	/** @type {any} */ (window).VoidOrderModules ??= {};
	/** @type {any} */ (window).VoidOrderModules.items = (/** @type {any} */ ctx) => {
		const w = ctx.w;
		const guard = ctx.modules && ctx.modules.guard;
		if (!guard) {
			console.warn('[Oculus Nihili] the Armory items are off: the guard module did not load');
			return null;
		}
		const ITEMS = `${ctx.assets}items/`;
		const GROUP = 'ItemHandheld';
		const FEATURE = 'Weapon items';
		/** A transparent pixel: the picture for a pose the items have no drawing for. */
		const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
		/** @type {Map<string, any>} The registered items (assets/items/items.json entries) by asset name. */
		const items = new Map();
		/** @type {Set<string>} Picture files the items have. */
		const images = new Set();
		/** @type {Map<string, string>} The items' texts, by the game's text key. */
		const texts = new Map();
		/** @type {Map<string, string>} The items' layer names (LayerNames.csv keys), for the Layering and colour screens. */
		const layerNames = new Map();
		/** @type {(() => void)[]} Called once the items are registered. */
		const whenReady = [];
		let ready = false;

		/** Runs something waiting for the items, its failure only reported. */
		const runReady = (/** @type {() => void} */ f) => {
			try {
				f();
			} catch (e) {
				guard.problem(FEATURE, e);
			}
		};
		/** Whether an asset is one of the Armory's. */
		const isArmory = (/** @type {any} */ asset) => !!asset && !!asset.Group && asset.Group.Name === GROUP && items.has(asset.Name);
		/**
		 * Gives the game's LayerNames text our layers' names ("Blade", "Guard", "Hand layer"…), which its Layering and
		 * colour screens show: in every LayerNames cache already built, and in each one built later (the colour screen
		 * makes its own). The game's TextCache is a top-level class, not on window, so it can't be hooked like a
		 * function: its cacheLines is wrapped, and the wrapper only ever adds names after the game's own work.
		 */
		/* global TextCache, TextAllScreenCache, ItemColorLayerNames -- the game's top-level declarations */
		function nameLayers() {
			const feature = 'Weapon layer names';
			const T = typeof TextCache === 'function' ? TextCache : null;
			if (!T || !T.prototype || typeof T.prototype.cacheLines !== 'function' || !layerNames.size) {
				guard.problem(feature, 'the game keeps its texts differently now');
				return;
			}
			const add = (/** @type {any} */ cache) => {
				if (cache && cache.cache && /LayerNames\.csv$/.test(String(cache.path))) {
					for (const [k, v] of layerNames) {
						cache.cache[k] ??= v;
					}
				}
			};
			const original = T.prototype.cacheLines;
			if (!original.voidOrder) {
				const wrapped = function (/** @type {any[]} */ ...args) {
					// @ts-ignore - the game's own method, on its own cache
					const r = original.apply(this, args);
					try {
						add(this);
					} catch (e) {
						guard.problem(feature, e);
					}
					return r;
				};
				wrapped.voidOrder = true;
				T.prototype.cacheLines = wrapped;
			}
			try {
				if (typeof TextAllScreenCache !== 'undefined' && TextAllScreenCache instanceof Map) {
					for (const cache of TextAllScreenCache.values()) {
						add(cache);
					}
				}
				add(typeof ItemColorLayerNames !== 'undefined' ? ItemColorLayerNames : null);
			} catch (e) {
				guard.problem(feature, e);
			}
		}
		/** The item C wears of this asset. */
		const wornIn = (/** @type {any} */ C, /** @type {any} */ asset) =>
			Array.isArray(C.Appearance) ? C.Appearance.find((/** @type {any} */ i) => i && i.Asset === asset) : null;
		/**
		 * Whether the Layering screen moved, resized or rotated an item (or one of its layers). The game's texture masks
		 * don't follow those (in WebGL even a move shifts them), so such a weapon is drawn whole: its Hand layer is left
		 * out, rather than cutting holes beside the hands.
		 */
		function transformed(/** @type {any} */ item) {
			const p = (item && item.Property) || {};
			const off = (/** @type {any} */ v, /** @type {number} */ dflt) =>
				v != null && (typeof v === 'object' ? Object.values(v).some((x) => x != null && x !== dflt) : v !== dflt);
			return (
				off(p.TranslationX, 0) ||
				off(p.TranslationY, 0) ||
				off(p.ScaleX, 1) ||
				off(p.ScaleY, 1) ||
				off(p.Rotation, 0) ||
				off(p.LayerTranslationX, 0) ||
				off(p.LayerTranslationY, 0) ||
				off(p.LayerScaleX, 1) ||
				off(p.LayerScaleY, 1) ||
				off(p.LayerRotation, 0)
			);
		}

		/**
		 * The Armory weapon a character holds: the item's name, the weapon (key, name and catalog category), its option
		 * number in the item and the carry option; null when they hold none.
		 * @param {any} c a character
		 * @returns {{ item: string, weapon: { key: string, name: string, cat: string }, option: number, position: number, carry: string } | null}
		 */
		function held(c) {
			const worn = c && Array.isArray(c.Appearance) ? c.Appearance.find((/** @type {any} */ i) => i && isArmory(i.Asset)) : null;
			if (!worn) {
				return null;
			}
			const item = items.get(worn.Asset.Name);
			const record = (worn.Property && worn.Property.TypeRecord) || {};
			const option = Number.isInteger(record.w) ? record.w : 0;
			const weapon = item.weapons[option] || item.weapons[0];
			const position = Number.isInteger(record.Position) ? record.Position : 0;
			// What that carry is: 'trigger', 'portarms', 'shoulder', 'back', 'held' or 'front' ('' for none).
			const carry = (Array.isArray(item.carries) && item.carries[position]) || '';
			return { item: item.name, weapon, option, position, carry };
		}

		/** Fetches the definitions and registers them, once the game has loaded its own items. */
		function start() {
			/** The game functions registering needs; the first one missing, or ''. */
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
				// The game has loaded its own items once its item list has them.
				if (!Array.isArray(w.Asset) || !w.Asset.length) {
					return;
				}
				if (missing()) {
					clearInterval(wait);
					guard.problem(FEATURE, `the game has no ${missing()}`);
					return;
				}
				clearInterval(wait);
				fetch(`${ITEMS}items.json`, { cache: 'no-cache' })
					.then((res) => {
						if (!res.ok) {
							throw new Error(`items.json: HTTP ${res.status}`);
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
			ctx.onSignIn(() => {
				try {
					markUser();
				} catch (e) {
					guard.problem('Showing you use the add-on', e);
				}
			});
		}

		/**
		 * Adds the items to the game's hand-held group, with their pictures and texts. An item the game already has is
		 * left alone. If the game refuses one, the items stop there and the ones added are kept.
		 * @param {any} data assets/items/items.json
		 */
		function register(data) {
			const group = w.AssetGroupGet('Female3DCG', data.group);
			const groupDef = w.AssetFemale3DCG.find((/** @type {any} */ g) => g && g.Group === data.group);
			if (!group || !groupDef || !Array.isArray(group.Asset) || !Array.isArray(data.items) || !Array.isArray(data.images)) {
				throw new Error(`the game has no ${data.group} group as expected`);
			}
			for (const f of data.images) {
				images.add(f);
			}
			if (!hookPictures()) {
				return;
			}
			guard.hookGame('AssetTextGet', 0, 'Weapon texts', (args, next) =>
				typeof args[0] === 'string' && texts.has(args[0]) ? texts.get(args[0]) : next(args),
			);
			for (const item of data.items) {
				if (w.AssetGet('Female3DCG', data.group, item.name)) {
					continue;
				}
				try {
					w.AssetAdd(
						group,
						gameDefinition(item.def),
						item.extended ? { [data.group]: { [item.name]: withoutGameMessages(item.extended) } } : undefined,
						groupDef,
					);
				} catch (e) {
					unregister(group, item.name);
					throw e;
				}
				const asset = w.AssetGet('Female3DCG', data.group, item.name);
				if (!asset) {
					throw new Error(`${item.name} was not added`);
				}
				asset.Description = item.description;
				items.set(item.name, item);
				for (const [k, v] of Object.entries(item.texts || {})) {
					texts.set(k, String(v));
				}
				for (const [k, v] of Object.entries(item.layerNames || {})) {
					layerNames.set(k, String(v));
				}
			}
			guard.hookGame('ValidationResolveRemoveDiff', 0, 'Keeping weapons on', keepOnRemove);
			nameLayers();
			if (guard.gameFunction('CharacterAppearanceBuildMasks')) {
				guard.hookGame('CharacterAppearanceBuildMasks', 0, 'Hand layer', (args, next) => {
					const masks = next(args);
					const C = args[0];
					if (!Array.isArray(masks) || !C) {
						return masks;
					}
					return masks.filter((/** @type {any} */ l) => !(l && l.Name === 'Hand' && isArmory(l.Asset) && transformed(wornIn(C, l.Asset))));
				});
			}
			ready = true;
			for (const f of whenReady.splice(0)) {
				runReady(f);
			}
		}
		/**
		 * The extended item config, sending no message of the game's own when the weapon or the carry changes: the game
		 * looks its text up in its own files, where our items have none, so every player saw "MISSING TEXT". The
		 * holder's add-on says it in a line everyone reads instead (src/actions.js).
		 * @param {any} extended
		 */
		function withoutGameMessages(extended) {
			return { ...extended, ScriptHooks: { ...(extended.ScriptHooks || {}), PublishAction: () => {} } };
		}
		/** Takes a half-added item back out of the game's lists. */
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
		/**
		 * An item definition made ready for this version of the game: the group's pose mapping filled in, and colours on
		 * the item as well as on its layers (older versions of the game read the item's, newer ones the layers').
		 * @param {any} source
		 */
		function gameDefinition(source) {
			const def = JSON.parse(JSON.stringify(source));
			if (def.PoseMapping && def.PoseMapping.__poseMapping) {
				const { __poseMapping: from, ...rest } = def.PoseMapping;
				// The game's AssetPoseMapping is a top-level const (not on window): read the group's own copy of it.
				const group = typeof w.AssetGroupGet === 'function' ? w.AssetGroupGet('Female3DCG', from) : null;
				const base = (w.AssetPoseMapping && w.AssetPoseMapping[from]) || (group && group.PoseMapping) || {};
				def.PoseMapping = { ...base, ...rest };
			}
			if (!def.DefaultColor && def.Layer.some((/** @type {any} */ l) => Array.isArray(l.Color))) {
				def.DefaultColor = def.Layer.filter((/** @type {any} */ l) => !l.CopyLayerColor && l.AllowColorize !== false).map(
					(/** @type {any} */ l) => (Array.isArray(l.Color) && l.Color[0]) || 'Default',
				);
			}
			return def;
		}

		/** The add-on's address for one of the game's picture paths, or '' when it isn't an Armory picture. */
		function picture(/** @type {string} */ url) {
			const m = /^(?:\.\/)?Assets\/Female3DCG\/ItemHandheld\/(?:([A-Za-z]+)\/)?([A-Za-z0-9]+?)(?:_(.+))?\.png$/.exec(url);
			const item = m && items.get(m[2]);
			if (!m || !item) {
				return '';
			}
			if (m[1] === 'Preview' && !m[3]) {
				return `${ITEMS}preview/${item.name}.png`;
			}
			// A pose's folder (the bound layers ask for TapedHands/) has the same picture: the art doesn't change by pose.
			const file = `img/${item.source}_${m[3]}.png`;
			return images.has(file) ? `${ITEMS}${file}` : EMPTY_PNG;
		}
		/**
		 * Sends the game's requests for Armory pictures to the add-on's copies (every picture the game draws is fetched
		 * through CommonFetch), and gives the items' buttons their pictures. False when pictures can't be redirected: the
		 * items are then not registered at all, since they would draw as nothing.
		 */
		function hookPictures() {
			const ok = guard.hookGame('CommonFetch', 10, FEATURE, (args, next) => {
				const url = typeof args[0] === 'string' ? picture(args[0]) : '';
				return next(url ? [url, ...args.slice(1)] : args);
			});
			if (ok && guard.gameFunction('ElementButton.CreateForAsset')) {
				guard.hookGame('ElementButton.CreateForAsset', 0, 'Weapon item buttons', (args, next) => {
					const asset = args[1] && ('Asset' in args[1] ? args[1].Asset : args[1]);
					if (!isArmory(asset)) {
						return next(args);
					}
					const options = { ...(args[4] || {}) };
					options.image ??= `${ITEMS}preview/${asset.Name}.png`;
					return next([args[0], args[1], args[2], args[3], options, ...args.slice(5)]);
				});
			}
			return ok;
		}

		// ---- Players who don't have the add-on
		/** Marks the account as using Oculus Nihili (in its shared settings), so other users' add-ons know you see the items. */
		function markUser() {
			const shared = w.Player.OnlineSharedSettings;
			if (shared.OculusNihili === ctx.VERSION || !w.ServerAccountUpdate || typeof w.ServerAccountUpdate.QueueData !== 'function') {
				return;
			}
			shared.OculusNihili = ctx.VERSION;
			w.ServerAccountUpdate.QueueData({ OnlineSharedSettings: shared });
		}
		/** Whether the player with that member number is known to use Oculus Nihili (you always do). */
		function usesAddOn(/** @type {number} */ member) {
			if (w.Player && member === w.Player.MemberNumber) {
				return true;
			}
			const c = Array.isArray(w.Character) ? w.Character.find((/** @type {any} */ x) => x && x.MemberNumber === member) : null;
			return !!(c && c.OnlineSharedSettings && c.OnlineSharedSettings.OculusNihili);
		}
		/**
		 * Keeps your Armory item when someone without the add-on changes your outfit: their game doesn't know the item, so
		 * the outfit it sends leaves it out, which the game would otherwise take as removing it.
		 * @param {any[]} args ValidationResolveRemoveDiff's: the item, the change's details
		 * @param {(a: any[]) => any} next
		 */
		function keepOnRemove(args, next) {
			const [previous, params] = args;
			const c = params && params.C;
			if (
				previous &&
				isArmory(previous.Asset) &&
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

		start();
		return {
			isArmory,
			held,
			armoryItems: items,
			/** Calls `f` once the items are registered (at once if they are). */
			whenItemsReady: (/** @type {() => void} */ f) => (ready ? runReady(f) : whenReady.push(f)),
		};
	};
})();
