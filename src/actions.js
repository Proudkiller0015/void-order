// Oculus Nihili: what you can do with a weapon of the Armory in your hands. Holding one adds its actions to the game's
// activity menu: combat on others by body zone (aim, shoot, slash, strike, cast…), upkeep on your own hands (reload,
// hone, recharge, check the scope, channel), and Queen's Wrath's own set. Each sends a line everyone in the room reads,
// add-on or not, and may roll Void dice from the weapon's stats. Taking up, switching and carrying a weapon get a line
// too, and ammunition and charge can be counted (off by default).
//
// Queen's Wrath belongs to the app admin: in anyone else's hands it weighs two tons and won't move, unless she lent
// it to them (recorded on the Order's server from her own session). She lends it from her hands to someone else's, and
// recalls it from whoever holds it.
//
// Everything is registered through guarded hooks: if a game update breaks them, only these actions switch off.
(window.VoidOrderModules = window.VoidOrderModules || {}).actions = (/** @type {any} */ ctx) => {
	'use strict';
	const w = ctx.w;
	const items = ctx.modules.items;
	if (!items || typeof items.held !== 'function') {
		// No Armory items in this game: nothing to act with.
		return null;
	}
	const FEATURE = 'Weapon actions';
	const QW = 'QueensWrath';
	/** The app admin, Queen's Wrath's owner (the live one before the server has answered). */
	const owner = () => (ctx.state() && ctx.state().appAdmin) || 255659;
	const lentTo = () => (ctx.state() && ctx.state().lent) || 0;

	// ---- Settings (this browser)
	const SETTINGS = [
		{ k: 'actions', label: 'Weapon actions in the activity menu', dflt: true },
		{ k: 'actionDice', label: 'Roll Void dice with attacks (from the weapon’s stats)', dflt: true },
		{ k: 'actionLines', label: 'A line in the room when you take up, switch or carry a weapon', dflt: true },
		{ k: 'actionAmmo', label: 'Count ammunition and charge (reload and recharge to fill)', dflt: false },
	];
	const on = (/** @type {string} */ k) => ctx.pref(k, SETTINGS.find((s) => s.k === k)?.dflt);

	// ---- The weapons' kinds, and the words for the zones
	const GUNS = ['Pistols', 'SMGs', 'Rifles', 'SniperRifles', 'Shotguns'];
	const BOWS = ['Crossbows'];
	const BLADES = ['Swords', 'GlowingBlades', 'ShortBlades'];
	const SCOPED = ['Rifles', 'SniperRifles'];
	/** @type {Record<string, string>} */
	const ZONE = {
		ItemHead: 'head',
		ItemNeck: 'throat',
		ItemArms: 'arm',
		ItemHands: 'hand',
		ItemTorso: 'chest',
		ItemPelvis: 'waist',
		ItemLegs: 'thigh',
		ItemFeet: 'legs',
	};
	/** Rounds or charges when full, by kind. */
	const FULL = { Pistols: 15, SMGs: 30, Rifles: 30, SniperRifles: 5, Shotguns: 6, Crossbows: 1, GlowingBlades: 5, Staffs: 5, QW: 5 };

	/**
	 * The actions. `kinds`: the weapon kinds that have it ('QW' for Queen's Wrath). `target`: zones on others; `self`:
	 * zones on yourself. `say(a, b, wpn, zone)`: the line. `attack`: rolls Void dice. `uses`: 'shot' or 'charge' (counted
	 * when that's on); `fills`: what an upkeep action refills. `ownerOnly`: Queen's Wrath's owner only.
	 * @typedef {{ name: string, label: string, kinds: string[], target?: string[], self?: string[],
	 *   say: (a: string, b: string, wpn: string, zone: string) => string, attack?: boolean, uses?: string, fills?: string,
	 *   ownerOnly?: boolean, special?: string, when?: (target: any) => boolean }} Def
	 * @type {Def[]}
	 */
	const DEFS = [
		{
			name: 'VoidAim',
			label: 'Aim',
			kinds: [...GUNS, ...BOWS],
			target: ['ItemHead', 'ItemTorso'],
			say: (a, b, x, z) => `${a} levels the ${x} at ${b}'s ${z}.`,
		},
		{
			name: 'VoidShoot',
			label: 'Shoot',
			kinds: GUNS,
			target: ['ItemTorso', 'ItemArms', 'ItemLegs', 'ItemFeet'],
			attack: true,
			uses: 'shot',
			say: (a, b, x, z) => `${a} fires the ${x} at ${b}'s ${z}.`,
		},
		{
			name: 'VoidLoose',
			label: 'Loose a bolt',
			kinds: BOWS,
			target: ['ItemTorso', 'ItemArms', 'ItemLegs'],
			attack: true,
			uses: 'shot',
			say: (a, b, x, z) => `${a} looses a bolt from the ${x} at ${b}'s ${z}.`,
		},
		{
			name: 'VoidMuzzle',
			label: 'Press the muzzle',
			kinds: GUNS,
			target: ['ItemHead', 'ItemNeck', 'ItemTorso'],
			say: (a, b, x, z) => `${a} presses the muzzle of the ${x} against ${b}'s ${z}.`,
		},
		{
			name: 'VoidButt',
			label: 'Strike with the stock',
			kinds: [...GUNS, ...BOWS],
			target: ['ItemTorso', 'ItemArms', 'ItemHead'],
			attack: true,
			say: (a, b, x, z) => `${a} drives the stock of the ${x} into ${b}'s ${z}.`,
		},
		{
			name: 'VoidSlash',
			label: 'Slash',
			kinds: [...BLADES, 'QW'],
			target: ['ItemArms', 'ItemTorso', 'ItemLegs'],
			attack: true,
			say: (a, b, x, z) => `${a} slashes at ${b}'s ${z} with the ${x}.`,
		},
		{
			name: 'VoidStab',
			label: 'Thrust',
			kinds: BLADES,
			target: ['ItemTorso', 'ItemLegs'],
			attack: true,
			say: (a, b, x, z) => `${a} thrusts the ${x} at ${b}'s ${z}.`,
		},
		{
			name: 'VoidNeck',
			label: 'Blade to the neck',
			kinds: [...BLADES, 'QW'],
			target: ['ItemNeck'],
			say: (a, b, x) => `${a} rests the edge of the ${x} against ${b}'s throat.`,
		},
		{
			name: 'VoidPoint',
			label: 'Point the blade',
			kinds: BLADES,
			target: ['ItemHead', 'ItemTorso'],
			say: (a, b, x, z) => `${a} points the ${x} at ${b}'s ${z}.`,
		},
		{
			name: 'VoidStrike',
			label: 'Strike',
			kinds: ['Blunt', 'Staffs'],
			target: ['ItemHead', 'ItemTorso', 'ItemArms', 'ItemLegs'],
			attack: true,
			say: (a, b, x, z) => `${a} swings the ${x} into ${b}'s ${z}.`,
		},
		{
			name: 'VoidCast',
			label: 'Cast a spell',
			kinds: ['Staffs', 'QW'],
			target: ['ItemHead', 'ItemTorso'],
			attack: true,
			uses: 'charge',
			say: (a, b, x) => `${a} raises the ${x} and casts a spell at ${b}.`,
		},
		{
			name: 'VoidReap',
			label: 'Reap',
			kinds: ['QW'],
			target: ['ItemTorso'],
			attack: true,
			say: (a, b, x) => `${a} brings ${x} around in a reaping arc at ${b}.`,
		},
		{
			name: 'VoidSweep',
			label: 'Sweep',
			kinds: ['QW'],
			target: ['ItemLegs', 'ItemFeet'],
			attack: true,
			say: (a, b, x) => `${a} sweeps ${b}'s legs out with the shaft of ${x}.`,
		},
		{
			name: 'VoidHook',
			label: 'Hook',
			kinds: ['QW'],
			target: ['ItemNeck', 'ItemPelvis'],
			say: (a, b, x, z) => `${a} hooks ${b}'s ${z} with the blade of ${x} and drags them close.`,
		},
		{
			name: 'VoidLend',
			label: 'Lend Queen’s Wrath',
			kinds: ['QW'],
			target: ['ItemHands'],
			ownerOnly: true,
			special: 'lend',
			say: (a, b, x) => `${a} places ${x} in ${b}'s hands. For now, it lets ${b} lift it.`,
		},
		{
			name: 'VoidRecall',
			label: 'Recall Queen’s Wrath',
			kinds: ['*'],
			target: ['ItemHands'],
			ownerOnly: true,
			special: 'recall',
			when: (C) => isQw(items.held(C)),
			say: (a, b, x) => `${a} calls ${x} back; it tears free of ${b}'s grip and returns to ${a}'s hands.`,
		},
		// Upkeep, on your own hands.
		{
			name: 'VoidReload',
			label: 'Reload',
			kinds: [...GUNS, ...BOWS],
			self: ['ItemHands'],
			fills: 'shot',
			say: (a, b, x) => `${a} reloads the ${x}.`,
		},
		{
			name: 'VoidScope',
			label: 'Check the scope',
			kinds: SCOPED,
			self: ['ItemHands'],
			say: (a, b, x) => `${a} checks the scope of the ${x}.`,
		},
		{
			name: 'VoidHone',
			label: 'Hone the blade',
			kinds: ['Swords', 'ShortBlades', 'QW'],
			self: ['ItemHands'],
			say: (a, b, x) => `${a} runs a whetstone along the edge of ${x === QW_NAME ? x : `the ${x}`}.`,
		},
		{
			name: 'VoidRecharge',
			label: 'Recharge',
			kinds: ['GlowingBlades'],
			self: ['ItemHands'],
			fills: 'charge',
			say: (a, b, x) => `${a} lets the glow of the ${x} build again.`,
		},
		{
			name: 'VoidChannel',
			label: 'Channel the Void',
			kinds: ['Staffs', 'QW'],
			self: ['ItemHands'],
			fills: 'charge',
			say: (a, b, x) => `${a} channels the Void into ${x === QW_NAME ? x : `the ${x}`}.`,
		},
		{
			name: 'VoidRecallSelf',
			label: 'Recall Queen’s Wrath',
			kinds: ['*'],
			self: ['ItemHands'],
			ownerOnly: true,
			special: 'recallAny',
			when: () => !!holderInRoom(),
			say: (a) => `${a} holds out a hand and calls Queen's Wrath back to it.`,
		},
	];
	const QW_NAME = "Queen's Wrath";
	/** @type {Map<string, Def>} */
	const byName = new Map(DEFS.map((d) => [d.name, d]));
	/** The game's activity objects for ours. */
	const ACTS = new Map(
		DEFS.map((d) => [
			d.name,
			{
				Name: d.name,
				MaxProgress: 0,
				MaxProgressSelf: 0,
				Prerequisite: [],
				Target: d.target || [],
				TargetSelf: d.self || [],
				VoidOrder: true,
			},
		]),
	);

	/** The weapon item a character holds (held() names it; the menu needs the item itself). */
	const wornOf = (/** @type {any} */ C) => (typeof w.InventoryGet === 'function' ? w.InventoryGet(C, 'ItemHandheld') : null);
	const isQw = (/** @type {any} */ h) =>
		!!h && (h.item === QW || (!!h.item && !!h.item.Asset && h.item.Asset.Name === QW) || (!!h.weapon && h.weapon.key === QW));
	const kindOf = (/** @type {any} */ h) => (isQw(h) ? 'QW' : h.weapon && h.weapon.cat);
	const nameOf = (/** @type {any} */ h) => (isQw(h) ? QW_NAME : (h.weapon && h.weapon.name) || 'weapon');
	const nick = (/** @type {any} */ C) => (typeof w.CharacterNickname === 'function' ? w.CharacterNickname(C) : C.Nickname || C.Name);
	/** Whether you may move Queen's Wrath: its owner, or whoever she lent it to. */
	const mayWieldQw = () => !!w.Player && (w.Player.MemberNumber === owner() || w.Player.MemberNumber === lentTo());
	/** Someone else in the room holding Queen's Wrath. */
	const holderInRoom = () =>
		(Array.isArray(w.ChatRoomCharacter) ? w.ChatRoomCharacter : []).find(
			(C) => C.MemberNumber !== w.Player.MemberNumber && isQw(items.held(C)),
		) || null;

	// ---- Ammunition and charge (when counted), per weapon, in this browser
	/** @type {Record<string, number>} */
	const ammo = ctx.pref('ammo', {});
	const fullOf = (/** @type {any} */ h) => {
		const k = kindOf(h);
		if (h.weapon && /sawed-off|double/i.test(h.weapon.name || '')) {
			return 2;
		}
		return FULL[/** @type {keyof typeof FULL} */ (k)] || 0;
	};
	const ammoKey = (/** @type {any} */ h) => (isQw(h) ? QW : (h.weapon && h.weapon.key) || '');
	const left = (/** @type {any} */ h) => (ammoKey(h) in ammo ? ammo[ammoKey(h)] : fullOf(h));
	const setLeft = (/** @type {any} */ h, /** @type {number} */ n) => {
		ammo[ammoKey(h)] = n;
		ctx.setPref('ammo', ammo);
	};

	// ---- Void dice from the weapon's stats: 1d6 plus its base damage, or its own dice (Queen's Wrath: 2d100 + 50)
	/** @type {any[] | null} */
	let catalog = null;
	fetch(`${ctx.assets}weapons/index.json?v=${encodeURIComponent(ctx.VERSION)}`)
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
		.then((list) => (catalog = Array.isArray(list) ? list : []))
		.catch((e) => ctx.report('Weapon stats', e));
	/**
	 * The dice a weapon's attack rolls: a stat line like "2d100 + 50 Damage" gives its own dice (Queen's Wrath), any
	 * other weapon rolls 1d6 plus its "+N Base damage".
	 * @returns {{ dice: number[], mod: number }}
	 */
	function attackDice(/** @type {any} */ h) {
		const name = nameOf(h);
		const entry = catalog && catalog.find((x) => x.name === name || (h.weapon && x.name === h.weapon.name));
		const own = entry && (entry.stats || []).map((s) => /^(\d+)d(\d+)\s*\+\s*(\d+)\s+Damage$/i.exec(s)).find(Boolean);
		if (own) {
			const count = Math.min(10, Number(own[1]));
			return { dice: Array(count).fill(Number(own[2])), mod: Math.min(99, Number(own[3])) };
		}
		return { dice: [6], mod: baseDamage(h) };
	}
	function baseDamage(/** @type {any} */ h) {
		const name = nameOf(h);
		const entry = catalog && catalog.find((x) => x.name === name || (h.weapon && x.name === h.weapon.name));
		const stat = entry && (entry.stats || []).find((s) => /Base damage/i.test(s));
		const n = stat ? parseInt(stat, 10) : 0;
		return Number.isInteger(n) ? Math.max(-99, Math.min(99, n)) : 0;
	}

	// ---- Sending lines everyone reads
	/**
	 * An activity line: the game's activity message, with its text carried in the message so players without the
	 * add-on read it too (their game finds no text for our activity and shows ours in its place).
	 */
	function sendActivity(
		/** @type {any} */ actor,
		/** @type {any} */ acted,
		/** @type {string} */ group,
		/** @type {string} */ name,
		/** @type {string} */ text,
	) {
		const key = `${acted.IsPlayer && acted.IsPlayer() ? 'ChatSelf' : 'ChatOther'}-${group}-${name}`;
		/** @type {any[]} */
		let dict = [];
		if (typeof w.DictionaryBuilder === 'function') {
			dict = new w.DictionaryBuilder().sourceCharacter(actor).targetCharacter(acted).focusGroup(group).build();
		}
		dict.push({ Tag: `MISSING TEXT IN "ActivityDictionary.csv": ${key}`, Text: text });
		w.ServerSend('ChatRoomChat', { Content: key, Type: 'Activity', Dictionary: dict });
	}
	/** A plain action line (the game shows the text for the 'Beep' placeholder). */
	function sendLine(/** @type {string} */ text) {
		if (w.CurrentScreen === 'ChatRoom' && typeof w.ServerSend === 'function') {
			w.ServerSend('ChatRoomChat', { Content: 'Beep', Type: 'Action', Dictionary: [{ Tag: 'Beep', Text: text }] });
		}
	}

	// ---- What the menu offers
	/** Our actions for the player's held weapon on character C's zone `group`. */
	function offered(/** @type {any} */ C, /** @type {string} */ group) {
		if (!on('actions') || !w.Player) {
			return [];
		}
		const h = items.held(w.Player);
		const self = C.MemberNumber === w.Player.MemberNumber;
		const isOwner = w.Player.MemberNumber === owner();
		return DEFS.filter((d) => {
			const zones = self ? d.self : d.target;
			if (!zones || !zones.includes(group)) {
				return false;
			}
			if (d.ownerOnly && !isOwner) {
				return false;
			}
			if (d.kinds.includes('*')) {
				return !d.when || d.when(C);
			}
			if (!h || !d.kinds.includes(kindOf(h))) {
				return false;
			}
			return !d.when || d.when(C);
		}).map((d) => ({ Activity: ACTS.get(d.name), Item: (h && wornOf(w.Player)) || undefined, Group: group }));
	}

	// ---- Doing one
	async function run(/** @type {any} */ acted, /** @type {string} */ group, /** @type {string} */ name) {
		const d = byName.get(name);
		const h = items.held(w.Player);
		if (!d) {
			return;
		}
		const a = nick(w.Player);
		const b = nick(acted);
		const zone = ZONE[group] || 'body';
		// Queen's Wrath won't move for anyone it wasn't given to.
		if (isQw(h) && !mayWieldQw() && !d.ownerOnly) {
			sendActivity(
				w.Player,
				acted,
				group,
				name,
				`${a} strains to move ${QW_NAME}, but in ${a}'s hands it weighs two tons and will not budge.`,
			);
			return;
		}
		if (d.special === 'lend') {
			const r = await ctx.req({ t: 'lend', member: acted.MemberNumber });
			if (!r || r.t !== 'ok') {
				ctx.note(`Queen's Wrath wasn't lent: ${(r && r.why) || 'no answer'}.`);
				return;
			}
			moveQw(w.Player, acted);
		} else if (d.special === 'recall' || d.special === 'recallAny') {
			const from = d.special === 'recall' ? acted : holderInRoom();
			const r = await ctx.req({ t: 'recall' });
			if (!r || r.t !== 'ok') {
				ctx.note(`Queen's Wrath wasn't recalled: ${(r && r.why) || 'no answer'}.`);
				return;
			}
			if (from) {
				moveQw(from, w.Player);
			}
		}
		let text = d.say(a, b, h ? nameOf(h) : QW_NAME, zone);
		if (h && on('actionAmmo') && (d.uses || d.fills)) {
			if (d.fills) {
				setLeft(h, fullOf(h));
			} else if (fullOf(h)) {
				const n = left(h);
				if (n <= 0) {
					text =
						d.uses === 'shot'
							? `${a} pulls the trigger of the ${nameOf(h)} at ${b}: click. It's empty.`
							: `${a} raises ${isQw(h) ? QW_NAME : `the ${nameOf(h)}`} at ${b}, but its power is spent.`;
					sendActivity(w.Player, acted, group, name, text);
					return;
				}
				setLeft(h, n - 1);
			}
		}
		sendActivity(w.Player, acted, group, name, text);
		ctx.guard(() => {
			if (d.attack && typeof w.CharacterSetFacialExpression === 'function') {
				w.CharacterSetFacialExpression(w.Player, 'Eyebrows', 'Angry', 4);
			}
		});
		if (d.attack && h && on('actionDice')) {
			const roll = attackDice(h);
			const why = await ctx.roll(roll.dice, roll.mod);
			if (why) {
				ctx.note(why);
			}
		}
	}
	/** Moves Queen's Wrath from one character's hands to another's, with its colours and options. */
	function moveQw(/** @type {any} */ from, /** @type {any} */ to) {
		const item = typeof w.InventoryGet === 'function' ? w.InventoryGet(from, 'ItemHandheld') : null;
		if (!item || item.Asset.Name !== QW) {
			return;
		}
		const color = Array.isArray(item.Color) ? [...item.Color] : item.Color;
		const property = item.Property ? JSON.parse(JSON.stringify(item.Property)) : undefined;
		w.InventoryRemove(from, 'ItemHandheld');
		w.InventoryWear(to, QW, 'ItemHandheld', color);
		const given = w.InventoryGet(to, 'ItemHandheld');
		if (given && property) {
			given.Property = property;
		}
		if (typeof w.ChatRoomCharacterItemUpdate === 'function') {
			w.ChatRoomCharacterItemUpdate(from, 'ItemHandheld');
			w.ChatRoomCharacterItemUpdate(to, 'ItemHandheld');
		}
	}

	// ---- Hooks into the game, each guarded: a broken one switches off only these actions.
	const hook = (() => {
		const g = ctx.modules.guard;
		if (g && typeof g.hookGame === 'function') {
			return (/** @type {string} */ fn, /** @type {(args: any[], next: (a: any[]) => any) => any} */ body) =>
				g.hookGame(fn, 0, FEATURE, body);
		}
		const sdk = w.bcModSdk;
		if (!sdk || typeof sdk.registerMod !== 'function') {
			throw new Error('the mod SDK is missing');
		}
		const mod = sdk.registerMod({ name: 'VoidOrderActions', fullName: 'Oculus Nihili: weapon actions', version: ctx.VERSION });
		let broken = false;
		return (/** @type {string} */ fn, /** @type {(args: any[], next: (a: any[]) => any) => any} */ body) => {
			if (typeof w[fn] !== 'function') {
				throw new Error(`${fn} is missing`);
			}
			mod.hookFunction(fn, 0, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) => {
				if (broken) {
					return next(args);
				}
				try {
					return body(args, next);
				} catch (e) {
					broken = true;
					ctx.report(FEATURE, e);
					return next(args);
				}
			});
		};
	})();

	hook('ActivityAllowedForGroup', (args, next) => {
		const list = next(args);
		const [C, group] = args;
		if (!C || !Array.isArray(list)) {
			return list;
		}
		if (
			C.MemberNumber !== w.Player.MemberNumber &&
			typeof w.InventoryIsBlockedByDistance === 'function' &&
			w.InventoryIsBlockedByDistance(C)
		) {
			return list;
		}
		return [...list, ...offered(C, group)];
	});
	hook('ActivityRun', (args, next) => {
		const [actor, acted, targetGroup, itemActivity] = args;
		const act = itemActivity && itemActivity.Activity;
		if (!act || !act.VoidOrder || !actor || !actor.IsPlayer || !actor.IsPlayer()) {
			return next(args);
		}
		ctx.guard(() => run(acted, targetGroup.Name, act.Name), undefined, FEATURE);
		return undefined;
	});
	// The action buttons show the weapon's own picture (the game would look for it among its own previews).
	try {
		hook('ElementButton.CreateForActivity', (args, next) => {
			const act = args[1];
			const it = act && act.Item;
			if (!act || !act.Activity || !act.Activity.VoidOrder || !it || !items.isArmory(it.Asset)) {
				return next(args);
			}
			const options = { ...(args[4] || {}) };
			options.image ??= `${ctx.assets}items/preview/${it.Asset.Name}.png`;
			return next([args[0], args[1], args[2], args[3], options, ...args.slice(5)]);
		});
	} catch (e) {
		ctx.report('Weapon action pictures', e);
	}
	hook('ActivityDictionaryText', (args, next) => {
		const m = /^Label-Chat(?:Other|Self)-[A-Za-z]+-(Void[A-Za-z]+)$/.exec(String(args[0] || ''));
		const d = m && byName.get(m[1]);
		return d ? d.label : next(args);
	});

	// ---- Lines for taking up, switching and carrying a weapon; the note for an unworthy wielder of Queen's Wrath.
	/** @type {string | null} */
	let last = null;
	let warnedQw = false;
	const CARRY = ['puts a finger on the trigger of the', 'holds across the chest the', 'rests on a shoulder the'];
	setInterval(
		() =>
			ctx.guard(
				() => {
					if (!w.Player || !w.Player.MemberNumber || w.CurrentScreen !== 'ChatRoom') {
						return;
					}
					const h = items.held(w.Player);
					const now = h ? `${ammoKey(h)}|${h.position ?? ''}` : '';
					if (last !== null && now !== last && h && on('actionLines')) {
						const [before] = last.split('|');
						const a = nick(w.Player);
						const x = nameOf(h);
						if (before !== ammoKey(h)) {
							sendLine(before ? `${a} switches to ${isQw(h) ? x : `the ${x}`}.` : `${a} takes up ${isQw(h) ? x : `the ${x}`}.`);
						} else if (typeof h.position === 'number' && CARRY[h.position]) {
							sendLine(`${a} ${CARRY[h.position]} ${x}.`);
						}
					}
					last = now;
					if (isQw(h) && !mayWieldQw()) {
						if (!warnedQw) {
							warnedQw = true;
							ctx.note(`${QW_NAME} does not consider you its worthy wielder. In your hands it weighs two tons.`);
						}
					} else {
						warnedQw = false;
					}
				},
				undefined,
				FEATURE,
			),
		1500,
	);

	// A light flinch when one of these lands on you.
	if (typeof w.ChatRoomRegisterMessageHandler === 'function') {
		w.ChatRoomRegisterMessageHandler({
			Description: 'Oculus Nihili: weapon actions',
			Priority: 220,
			Callback: (/** @type {any} */ data, /** @type {any} */ sender, /** @type {any} */ msg, /** @type {any} */ meta) => {
				ctx.guard(
					() => {
						const name = /-(Void[A-Za-z]+)$/.exec(String((data && data.Content) || ''));
						const d = name && data.Type === 'Activity' && byName.get(name[1]);
						if (d && d.attack && meta && meta.TargetCharacter && meta.TargetCharacter.IsPlayer() && sender && !sender.IsPlayer()) {
							w.CharacterSetFacialExpression?.(w.Player, 'Eyes', 'Closed', 2);
						}
					},
					undefined,
					FEATURE,
				);
				return false;
			},
		});
	}

	// ⚙ Settings › Weapon actions
	ctx.addSettings((/** @type {HTMLElement} */ body) => {
		body.append(ctx.make('h3', '', 'Weapon actions'));
		for (const s of SETTINGS) {
			const l = ctx.make('label', 'check');
			const box = ctx.make('input');
			box.type = 'checkbox';
			box.checked = !!on(s.k);
			box.addEventListener('change', () => ctx.setPref(s.k, box.checked));
			l.append(box, document.createTextNode(` ${s.label}`));
			body.append(l, ctx.make('br'));
		}
	});

	return { offered, run, defs: DEFS };
};
