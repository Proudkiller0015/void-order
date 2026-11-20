// Oculus Nihili, the Eye of the Void: the Void Order's add-on for Bondage Club.
//
// /void opens the Order's panel: orders and photo sessions from the hierarchy, the members by branch and rank, ID
// cards in the Order's own format, joining, Void dice everyone in the room sees roll, and for the Founder, admins and
// branch leaders, placing members. Everything shared lives on the Order's server; each member signs in with a key
// kept in their BC account settings, so it works on every device. Everything runs inside `guard`: if the game
// changes, the Void Order shows an error and the game carries on.
(() => {
	'use strict';
	const w = /** @type {any} */ (window);
	if (w.VoidOrder) {
		return;
	}
	const VERSION = '2.0.0-beta.2.23';
	/** The Order's server (a test page sets VoidOrderServer before loading this). */
	const SERVER = w.VoidOrderServer || 'wss://void-order.slimebeep-relay.workers.dev/ws';
	/** Where the add-on's pictures are (a test page sets VoidOrderAssets). */
	const ASSETS = w.VoidOrderAssets || 'https://proudkiller0015.github.io/void-order/assets/';
	/** Where the key is kept in the account (Player.ExtensionSettings), synced to every device. */
	const SETTINGS_KEY = 'VoidOrder';
	/** Content of the hidden room messages that show an ID card or a dice roll to the room's Void Order users. */
	const HIDDEN = 'VoidOrder';
	const LIMITS = {
		name: 40,
		bio: 300,
		about: 2000,
		orderTitle: 80,
		orderText: 1500,
		pic: 12000,
		room: 40,
		dice: 10,
		mod: 99,
		medalName: 40,
		medalReason: 140,
	};
	/** Ranks in a branch, the lowest rank that joins a chapter and that leads the branch, and branches per member. */
	/** The rank of a member in no branch (not the Founder or a Monsignor), and the colour of their mark. */
	const NEOPHYTE = 'Neophyte';
	const NEOPHYTE_COLOR = '#9a8fb8';
	/** The Order's name: fixed, like its structure (the name stored when it was founded is never shown). */
	const ORDER_NAME = 'Holy Order of Void';
	/** Queen's Wrath, the Keeper's signature scythe: a carry slot of its own, never counted. */
	const QUEENS_WRATH = 100;
	/**
	 * The app admin's title: the Keeper of the Eye (the Eye is Oculus Nihili). It shows instead of Founder while she still
	 * holds the Founder's place, which belongs to whoever she hands it to.
	 */
	const KEEPER = { name: 'Keeper of the Eye', sym: '𓁹‿𓁹', color: '#c9a8ff' };
	const TIERS = 5;
	const CHAPTER_FROM = 2;
	const LEADS_FROM = 4;
	const PLACES = 2;
	const DICE = [4, 6, 8, 10, 12, 20, 100];
	/** A roll shown in the room older than this (ms) is someone showing an old roll again: it isn't played. */
	const ROLL_FRESH = 60000;
	const FORM_NAME = { f: 'Feminine', m: 'Masculine', n: 'Neutral' };
	const KIND_ICON = { order: '📜', session: '📸', notice: '📢' };
	const KIND_NAME = { order: 'Order', session: 'Photo session', notice: 'Notice' };
	const ACK_LABEL = { read: '👁 Read', done: '✔ Done', yes: '✔ Coming', maybe: '❔ Maybe', no: '✖ Can’t come' };
	const ACKS = { order: ['read', 'done'], session: ['yes', 'maybe', 'no'], notice: ['read'] };

	// ---- Small helpers
	/** Text made safe to put in HTML. */
	const escapeHtml = (/** @type {string} */ text) =>
		String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
	/** A line in your own chat log only (the game shows it as HTML, so the text is escaped). */
	const note = (/** @type {string} */ text) => {
		if (w.CurrentScreen === 'ChatRoom' && typeof w.ChatRoomSendLocal === 'function') {
			w.ChatRoomSendLocal(`⸸ ${escapeHtml(text)}`);
		}
	};
	/** How long a code stays valid, in words: "48 hours", "7 days". */
	const spellHours = (/** @type {number} */ h) => (h >= 48 && h % 24 === 0 ? plural(h / 24, 'day') : plural(h, 'hour'));
	/** "1 member", "3 members". */
	const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const nick = (/** @type {any} */ C) => (typeof w.CharacterNickname === 'function' ? w.CharacterNickname(C) : C.Nickname || C.Name);
	/** Local settings for this browser. */
	const pref = (/** @type {string} */ k, /** @type {any} */ dflt) => {
		try {
			const v = localStorage.getItem(`voidorder.${k}`);
			return v === null ? dflt : JSON.parse(v);
		} catch (e) {
			return dflt;
		}
	};
	const setPref = (/** @type {string} */ k, /** @type {any} */ v) => {
		try {
			localStorage.setItem(`voidorder.${k}`, JSON.stringify(v));
		} catch (e) {
			/* private window */
		}
	};
	const date = (/** @type {number} */ t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	const dateTime = (/** @type {number} */ t) =>
		new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	/** "in 2 h 5 min", "5 min ago". */
	const fromNow = (/** @type {number} */ t) => {
		const mins = Math.round((t - Date.now()) / 60000);
		const a = Math.abs(mins);
		if (!a) {
			return 'just now';
		}
		const text =
			a < 60 ? `${a} min` : a < 2880 ? `${Math.floor(a / 60)} h${a % 60 ? ` ${a % 60} min` : ''}` : `${Math.round(a / 1440)} days`;
		return mins >= 0 ? `in ${text}` : `${text} ago`;
	};
	const b64url = (/** @type {ArrayBuffer} */ buf) =>
		btoa(String.fromCharCode(...new Uint8Array(buf)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	const isColor = (/** @type {any} */ c) => /^#[0-9a-fA-F]{6}$/.test(c || '');

	/**
	 * Runs fn; if it throws, the error goes to `say` (or the console) and the game carries on.
	 * @param {() => any} fn
	 * @param {(text: string) => void} [say]
	 * @param {string} [feature] the feature named in a problem report
	 */
	function guard(fn, say, feature = 'Oculus Nihili') {
		try {
			const r = fn();
			if (r && typeof r.catch === 'function') {
				r.catch((/** @type {any} */ e) => report(e, say, feature));
			}
		} catch (e) {
			report(e, say, feature);
		}
	}
	function report(/** @type {any} */ e, /** @type {((text: string) => void) | undefined} */ say, feature = 'Oculus Nihili') {
		console.warn(`[Oculus Nihili] ${feature}:`, e);
		if (say) {
			say(`⚠ Something went wrong in ${feature}. It has been reported; if it keeps happening, reload the game.`);
		}
		if (problem) {
			problem(feature, e);
		}
	}
	/** Hands a failure to the problem reporter (set once the modules' context exists). */
	let problem = /** @type {((feature: string, e: any) => void) | null} */ (null);

	// ---- The key: P-256, kept in the account's add-on settings so every device signs in as the same member.
	/** @type {{ owner: number, priv: CryptoKey, pub: { x: string, y: string } } | null} */
	let key = null;
	const hasLz = () => typeof w.LZString !== 'undefined' && w.LZString && typeof w.LZString.compressToUTF16 === 'function';
	const canSync = () =>
		!!w.Player.ExtensionSettings &&
		typeof w.Player.ExtensionSettings === 'object' &&
		typeof w.ServerPlayerExtensionSettingsSync === 'function';
	/** The key saved in the account (or, where the game keeps no add-on settings, this browser), or null. */
	function savedJwk() {
		const raw = canSync() ? w.Player.ExtensionSettings[SETTINGS_KEY] : pref(`key.${w.Player.MemberNumber}`, null);
		if (typeof raw !== 'string' || !raw) {
			return null;
		}
		try {
			const text = raw[0] === '{' ? raw : hasLz() && w.LZString.decompressFromUTF16(raw);
			const s = JSON.parse(text || 'null');
			return s && s.v === 1 && s.k && typeof s.k.d === 'string' ? s.k : null;
		} catch (e) {
			return null;
		}
	}
	function saveJwk(/** @type {any} */ k) {
		const json = JSON.stringify({ v: 1, k });
		if (canSync()) {
			w.Player.ExtensionSettings[SETTINGS_KEY] = hasLz() ? w.LZString.compressToUTF16(json) : json;
			w.ServerPlayerExtensionSettingsSync(SETTINGS_KEY);
		} else {
			setPref(`key.${w.Player.MemberNumber}`, json);
		}
	}
	/** This account's key, made the first time. */
	async function getKey() {
		const me = w.Player.MemberNumber;
		if (key && key.owner === me) {
			return key;
		}
		let jwk = savedJwk();
		if (!jwk) {
			const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
			const full = await crypto.subtle.exportKey('jwk', pair.privateKey);
			jwk = { x: full.x, y: full.y, d: full.d };
			saveJwk(jwk);
		}
		const priv = await crypto.subtle.importKey(
			'jwk',
			{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign'],
		);
		key = { owner: me, priv, pub: { x: jwk.x, y: jwk.y } };
		return key;
	}

	// ---- The connection
	/** @type {WebSocket | null} */
	let ws = null;
	/** The account the connection is signed in as. */
	let signedAs = 0;
	let retry = 0;
	let retryTimer = 0;
	let pingTimer = 0;
	/** A reset or join code to sign in with. */
	let resetCode = '';
	/** @type {any} The Order as the server last sent it. */
	let state = null;
	/** @type {Map<number, any>} Orders by id. */
	const orders = new Map();
	/** Whether the first order list came (orders arriving after it are new). */
	let ordersLoaded = false;
	/** @type {Map<number, (x: any) => void>} Requests waiting for their answer. */
	const waiting = new Map();
	let rid = 0;
	/** The room told to the server. */
	let toldRoom = '';

	/** The current room, if it is public and you are a member who shows it to anyone; else ''. */
	function publicRoom() {
		const d = w.ChatRoomData;
		if (w.CurrentScreen !== 'ChatRoom' || !d || !d.Name || !isMember() || state.me.roomFor === 'none') {
			return '';
		}
		const pub = Array.isArray(d.Visibility) ? d.Visibility.length === 1 && d.Visibility[0] === 'All' : !d.Private;
		return pub ? String(d.Name).slice(0, LIMITS.room) : '';
	}

	/** When the add-on started trying to reach the server and has had no answer since (0: it has one). */
	let tryingSince = 0;
	function connect() {
		if (ws || !w.Player || !w.Player.MemberNumber) {
			return;
		}
		if (!tryingSince) {
			tryingSince = Date.now();
			setTimeout(() => render(), UNREACHABLE + 500);
		}
		const me = w.Player.MemberNumber;
		let sock;
		try {
			sock = new WebSocket(SERVER);
		} catch (e) {
			return later();
		}
		ws = sock;
		signedAs = me;
		sock.onmessage = (e) =>
			guard(async () => {
				const x = JSON.parse(e.data);
				if (x.t === 'hello') {
					const k = await getKey();
					const sig = b64url(
						await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, new TextEncoder().encode(`${x.nonce}|void|${me}`)),
					);
					toldRoom = publicRoom();
					sock.send(
						JSON.stringify({
							t: 'auth',
							member: me,
							name: nick(w.Player),
							pub: k.pub,
							sig,
							room: toldRoom,
							...(resetCode ? { code: resetCode } : {}),
						}),
					);
					return;
				}
				onServer(x);
			});
		sock.onclose = () => {
			if (ws !== sock) {
				return;
			}
			ws = null;
			state = null;
			clearInterval(pingTimer);
			render();
			later();
		};
		sock.onopen = () => {
			retry = 0;
			clearInterval(pingTimer);
			pingTimer = window.setInterval(() => sock.readyState === 1 && sock.send('{"t":"ping"}'), 30000);
		};
	}
	/** Tries again later, waiting longer each time (up to a minute). */
	function later() {
		clearTimeout(retryTimer);
		retry = Math.min(retry + 1, 6);
		retryTimer = window.setTimeout(connect, Math.min(60000, 1000 * 2 ** retry));
	}
	/** Closes the connection and signs in again (another account, or a reset code). */
	function reconnect() {
		const old = ws;
		ws = null;
		state = null;
		orders.clear();
		ordersLoaded = false;
		clearInterval(pingTimer);
		if (old) {
			try {
				old.close();
			} catch (e) {
				/* closed */
			}
		}
		retry = 0;
		connect();
	}
	/** Whether this session already took a left-over power armour off the server's record (see onServer). */
	let armorCleared = false;
	/**
	 * Sends a request and resolves with the server's answer ({ t: 'ok' | 'error' | 'card' | 'roll', ... }).
	 * @param {Record<string, any>} x
	 * @returns {Promise<any>}
	 */
	function req(x) {
		return new Promise((resolve) => {
			if (!ws || ws.readyState !== 1 || !state) {
				resolve({ t: 'error', why: 'not connected to the Order, try again in a moment' });
				return;
			}
			const id = ++rid;
			waiting.set(id, resolve);
			ws.send(JSON.stringify({ ...x, rid: id }));
			setTimeout(() => {
				if (waiting.delete(id)) {
					resolve({ t: 'error', why: 'no answer from the Order' });
				}
			}, 10000);
		});
	}

	function onServer(/** @type {any} */ x) {
		if (typeof x.rid === 'number' && waiting.has(x.rid)) {
			const done = waiting.get(x.rid);
			waiting.delete(x.rid);
			done(x);
		}
		for (const f of serverListeners) {
			guard(() => f(x));
		}
		if (
			x.t === 'report' &&
			x.report &&
			state &&
			state.appAdmin === (w.Player && w.Player.MemberNumber) &&
			!(tab === 'admin' && adminView === 'reports')
		) {
			unseenReports++;
			drawBubble();
		}
		if (x.t === 'state') {
			tryingSince = 0;
			state = x;
			if (!signedIn) {
				signedIn = true;
				for (const f of signInListeners.splice(0)) {
					guard(f);
				}
			}
			if (resetCode && x.status === 'member') {
				resetCode = '';
				note('Your key is in. Welcome to the Order.');
			}
			// The Void Paladin outfit was taken out (its power armour raised the carry limit to 4): a member the server still
			// counts as wearing it is taken out of it once, so their limit is 2 again.
			if (x.me && x.me.armor && !armorCleared) {
				armorCleared = true;
				guard(async () => {
					const r = await req({ t: 'armor', on: false });
					if (r && r.t === 'ok' && Array.isArray(r.dropped) && r.dropped.length) {
						note(`The Void Paladin armour is gone, so you carry 2 weapons: you put down ${r.dropped.join(' and ')}.`);
					}
				});
			}
			render();
		} else if (x.t === 'orders') {
			orders.clear();
			for (const o of x.orders) {
				orders.set(o.id, o);
			}
			if (!ordersLoaded) {
				ordersLoaded = true;
				const open = [...orders.values()].filter(waitsForMe).length;
				if (open) {
					note(`${plural(open, 'unanswered order')} from the Order. Type /void to read.`);
				}
			}
			render();
		} else if (x.t === 'order') {
			const fresh = !orders.has(x.o.id);
			orders.set(x.o.id, x.o);
			if (fresh && ordersLoaded && isForMe(x.o)) {
				const text = `${KIND_ICON[x.o.kind]} New ${KIND_NAME[x.o.kind].toLowerCase()} from ${x.o.byName}: ${x.o.title}`;
				note(`${text} (/void)`);
				toast(text, () => openPanel('orders'));
			}
			render();
		} else if (x.t === 'unorder') {
			orders.delete(x.id);
			render();
		} else if (x.t === 'hunt' && x.board) {
			huntBoard = x.board;
			render();
		} else if (x.t === 'medal' && x.medal) {
			const text = `🎖 ${x.medal.byName} commended you: ${x.medal.name}`;
			note(`${text}${x.medal.reason ? ` (${x.medal.reason})` : ''}`);
			toast(text, () => openCard(w.Player.MemberNumber, note));
		} else if (x.t === 'card' && x.card && cardWanted.has(x.member)) {
			cardWanted.delete(x.member);
			showCard(x.card, true);
		} else if (x.t === 'error' && typeof x.rid !== 'number') {
			console.warn('[Void Order]', x.why);
		}
	}

	// ---- The structure: branches, their ranks and chapters, hybrid titles, Monsignor
	const structure = () => state.structure;
	const branchOf = (/** @type {string} */ id) => structure().branches.find((/** @type {any} */ b) => b.id === id) || null;
	/** A branch's name with its symbol either side: "≈][≈ Inquisitor ≈][≈". */
	const withSym = (/** @type {{ name: string, sym: string }} */ x) => (x.sym ? `${x.sym} ${x.name} ${x.sym}` : x.name);
	/** A rank name in one form, with the element for a '*' ("*mancer": Pyromancer, or Mancer with none). */
	function word(/** @type {any} */ forms, /** @type {string} */ form, el = '') {
		const text = String(forms[form] || forms.n).replace('*', el);
		return text.charAt(0).toUpperCase() + text.slice(1);
	}
	/** A rank's name for everyone: its neutral form, with "…" for the element ("…mancer"). */
	const tierLabel = (/** @type {any} */ forms) => String(forms.n).replace('*', '…');
	/** The forms of rank t in branch b, in chapter c (whose own names replace the branch's). */
	function tierForms(/** @type {any} */ b, /** @type {number} */ t, c = '') {
		const ch = b.chapters.find((/** @type {any} */ x) => x.id === c);
		return (ch && ch.tiers[t - 1]) || b.tiers[t - 1];
	}
	/** A member's rank name in one of their places ("Pyromancer", "High Priestess"). */
	function rankName(/** @type {any} */ p, /** @type {any} */ m) {
		const b = branchOf(p.b);
		return b ? word(tierForms(b, p.t, p.c), m.form, m.el) : '';
	}
	const chapterName = (/** @type {any} */ p) => branchOf(p.b)?.chapters.find((/** @type {any} */ c) => c.id === p.c)?.name || '';
	/** The title of a member in two branches ("Commisar"), or ''. */
	function hybridTitle(/** @type {any} */ m) {
		if (m.places.length < 2) {
			return '';
		}
		const forms = structure().hybrids[[m.places[0].b, m.places[1].b].sort().join('+')];
		return forms ? word(forms, m.form) : '';
	}
	/** "Paladin - Knight", with ", Salvatoris" when `chapter`. */
	function placeText(/** @type {any} */ p, /** @type {any} */ m, chapter = false) {
		const b = branchOf(p.b);
		const c = chapter && chapterName(p);
		return b ? `${b.name} - ${rankName(p, m)}${c ? `, ${c}` : ''}` : '';
	}
	/**
	 * A member's ID in the Order's format: the motto, then the Founder or Monsignor, then "(Branch) - (Rank)" and the
	 * chapter; a hybrid has their title, then each branch with its rank and chapter.
	 * @returns {{ text: string, sym?: string, color?: string, cls?: string }[]}
	 */
	function idLines(/** @type {any} */ m, /** @type {boolean} */ founder) {
		const s = structure();
		const lines = [];
		if (s.motto) {
			lines.push({ text: s.motto, cls: 'motto' });
		}
		if (isKeeper(m)) {
			lines.push({ text: KEEPER.name, sym: KEEPER.sym, color: KEEPER.color });
		} else if (founder) {
			lines.push({ text: s.founder.name, sym: s.founder.sym, color: s.founder.color });
		}
		if (m.mon) {
			lines.push({ text: s.monsignor.name, sym: s.monsignor.sym, color: s.monsignor.color });
		}
		if (showsRank(m, founder)) {
			lines.push({ text: orderRank(m), cls: 'rank' });
		}
		const title = hybridTitle(m);
		if (title) {
			lines.push({ text: title, cls: 'hybrid' });
		}
		for (const p of m.places) {
			const b = branchOf(p.b);
			if (!b) {
				continue;
			}
			lines.push({ text: placeText(p, m, !!title), sym: b.sym, color: b.color });
			if (!title && p.c) {
				lines.push({ text: chapterName(p), cls: 'chapter' });
			}
		}
		return lines;
	}
	/** A member's Order rank ("Zealot"): every member starts a Neophyte. */
	function orderRank(/** @type {any} */ m) {
		const ranks = structure().ranks;
		return (Array.isArray(ranks) && ranks[m.rank || 0]) || NEOPHYTE;
	}
	/** Whether an ID shows the Order rank: everyone's but the Founder's, and the Keeper's only once she has one. */
	const showsRank = (/** @type {any} */ m, /** @type {boolean} */ founder) => !founder && (!isKeeper(m) || !!m.rank);

	/** A member's place in a few words: "Founder · Monsignor", "Warmage", "Paladin - Knight", "Neophyte". */
	function placeSummary(/** @type {any} */ m) {
		const s = structure();
		const parts = [];
		if (isKeeper(m)) {
			parts.push(KEEPER.name);
		} else if (m.n === founderN()) {
			parts.push(s.founder.name);
		}
		if (m.mon) {
			parts.push(s.monsignor.name);
		}
		const title = hybridTitle(m);
		parts.push(...(title ? [title] : m.places.map((/** @type {any} */ p) => placeText(p, m))));
		return parts.join(' · ') || orderRank(m);
	}

	// ---- Who stands where (the server decides; this only shows what you may do)
	const isMember = () => !!state && state.status === 'member';
	const founderN = () => (state && state.meta ? state.meta.founder : 0);
	/** Whether a member (or their ID card) is the Keeper of the Eye, the app admin. */
	const isKeeper = (/** @type {any} */ m) => !!m && (!!m.keeper || (!!state && !!state.appAdmin && m.n === state.appAdmin));
	const memberOf = (/** @type {number} */ n) => (state && state.members ? state.members.find((/** @type {any} */ m) => m.n === n) : null);
	/** The Founder or an admin: every power, everywhere. */
	const isTop = (/** @type {any} */ m) => m.n === founderN() || !!m.admin;
	const tierOf = (/** @type {any} */ m, /** @type {string} */ b) => (m.places.find((/** @type {any} */ p) => p.b === b) || { t: 0 }).t;
	const leadsAny = (/** @type {any} */ m) => m.places.some((/** @type {any} */ p) => p.t >= LEADS_FROM);
	/** Branches member m leads. */
	const ledBy = (/** @type {any} */ m) => structure().branches.filter((/** @type {any} */ b) => tierOf(m, b.id) >= LEADS_FROM);
	/** Whether `by` acts on m with the Founder's or an admin's powers: nobody acts on them but the Founder. */
	const topOver = (/** @type {any} */ by, /** @type {any} */ m) =>
		by.n === founderN() || (!!by.admin && m.n !== founderN() && (m.n === by.n || !m.admin));
	/** Whether `by`, leading branch b, outranks m in it. */
	const leaderOver = (/** @type {any} */ by, /** @type {any} */ m, /** @type {string} */ b) =>
		!isTop(m) && tierOf(m, b) > 0 && tierOf(m, b) < tierOf(by, b) && tierOf(by, b) >= LEADS_FROM;
	/** Whether `by` stands over m: orders go down to them. */
	const commands = (/** @type {any} */ by, /** @type {any} */ m) =>
		by.n !== m.n && (topOver(by, m) || m.places.some((/** @type {any} */ p) => leaderOver(by, m, p.b)));
	/** Whether m has no place yet and `by` leads a branch to place them in. */
	const placesNew = (/** @type {any} */ by, /** @type {any} */ m) => !m.places.length && !m.mon && !isTop(m) && leadsAny(by);
	/** The ranks `me` may give m in branch b (none if they may not place m there). */
	function givableTiers(/** @type {any} */ me, /** @type {any} */ m, /** @type {string} */ b) {
		const all = [1, 2, 3, 4, 5];
		if (topOver(me, m)) {
			return all;
		}
		const mine = tierOf(me, b);
		if (mine < LEADS_FROM || isTop(m)) {
			return [];
		}
		const ok =
			tierOf(m, b) > 0
				? leaderOver(me, m, b)
				: m.places.length
					? m.places.every((/** @type {any} */ p) => leaderOver(me, m, p.b))
					: placesNew(me, m);
		return ok ? all.filter((t) => t < mine) : [];
	}
	const mayRemove = (/** @type {any} */ me, /** @type {any} */ m) =>
		me.n !== m.n &&
		(topOver(me, m) ||
			(!m.mon && (placesNew(me, m) || (m.places.length > 0 && m.places.every((/** @type {any} */ p) => leaderOver(me, m, p.b))))));
	const mayReset = (/** @type {any} */ me, /** @type {any} */ m) => commands(me, m) || placesNew(me, m);
	/** Whether `me` may commend m: the Founder and admins anyone they act on, a leader those below them. */
	const mayCommend = (/** @type {any} */ me, /** @type {any} */ m) => commands(me, m);
	const mayOrder = () => isMember() && (isTop(state.me) || leadsAny(state.me));
	/** Whether member m is in an order's group: 'priest', 'priest/3', 'priest:vox-nihil', 'monsignor' or 'unplaced'. */
	function inGroup(/** @type {string} */ g, /** @type {any} */ m) {
		if (g === 'monsignor') {
			return !!m.mon;
		}
		if (g === 'unplaced') {
			return !m.places.length && !m.mon;
		}
		const [, b, sep, rest] = /^([a-z0-9-]+)(?:([/:])([a-z0-9-]+))?$/.exec(g) || [];
		const p = m.places.find((/** @type {any} */ x) => x.b === b);
		return !!p && (!sep || (sep === '/' ? p.t === Number(rest) : p.c === rest));
	}
	/** Whether an order goes to you: from someone over you, to everyone, your group or you by name. */
	function isForMe(/** @type {any} */ o) {
		if (!isMember() || o.by === state.me.n) {
			return false;
		}
		const me = state.me;
		const author = memberOf(o.by);
		const under = author ? commands(author, me) : true;
		return (
			under &&
			(o.to.all === true || (o.to.groups || []).some((/** @type {string} */ g) => inGroup(g, me)) || (o.to.members || []).includes(me.n))
		);
	}
	/** Your answer to an order, or null. */
	const myAck = (/** @type {any} */ o) => (o.acks ? o.acks[w.Player.MemberNumber] : o.mine) || null;
	/** Whether an order is waiting for your answer. */
	const waitsForMe = (/** @type {any} */ o) => isForMe(o) && !myAck(o);

	// ---- Reminders for photo sessions, and new orders as toasts
	function remindTick() {
		if (!isMember()) {
			return;
		}
		const seen = pref('reminded', {});
		let changed = false;
		for (const o of orders.values()) {
			if (o.kind !== 'session' || !(isForMe(o) || o.by === w.Player.MemberNumber)) {
				continue;
			}
			const a = myAck(o);
			if (a && a.a === 'no') {
				continue;
			}
			const left = o.when - Date.now();
			const stage = left <= 0 && left > -30 * 60000 ? 'now' : left > 0 && left <= opts.remind * 60000 ? 'soon' : '';
			if (stage && seen[o.id] !== stage && !(stage === 'soon' && seen[o.id] === 'now')) {
				seen[o.id] = stage;
				changed = true;
				if (stage === 'now' && !opts.remindNow) {
					continue;
				}
				const text = stage === 'now' ? `📸 ${o.title} starts now!` : `📸 ${o.title} starts ${fromNow(o.when)}.`;
				note(`${text}${o.body ? ` ${o.body}` : ''}`);
				toast(text, () => openPanel('orders'));
			}
		}
		if (changed) {
			// Only sessions still listed are remembered.
			for (const id of Object.keys(seen)) {
				if (!orders.has(Number(id))) {
					delete seen[id];
				}
			}
			setPref('reminded', seen);
		}
	}

	// ---- The look
	const CSS = `
		#void-panel, #void-card, .void-toast, #void-tab, #void-dice, #void-bubble, #void-roller { --v-bg: #0c0714; --v-bg2: #160d24; --v-line: #3d2a5c; --v-text: #e8defc; --v-dim: #a597c4; --v-accent: #b48cff; --v-hot: #e05cff; --v-bad: #ff7a90;
			font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--v-text); box-sizing: border-box; }
		#void-panel *, #void-card * { box-sizing: border-box; }
		#void-panel { position: fixed; z-index: 2147483001; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(820px, 96vw); height: min(680px, 92vh);
			display: flex; flex-direction: column; border-radius: 18px; border: 1px solid var(--v-line); overflow: hidden;
			background: radial-gradient(120% 80% at 50% -10%, #2a1648 0%, var(--v-bg) 55%) var(--v-bg); box-shadow: 0 0 0 1px #000, 0 20px 60px #000d, 0 0 80px #6a2cff22; }
		#void-panel header { display: flex; align-items: center; gap: 10px; padding: 12px 16px 0; }
		#void-panel h2 { margin: 0; font: 600 20px/1.2 Georgia, 'Times New Roman', serif; letter-spacing: 3px; text-transform: uppercase; color: #f1e9ff; text-shadow: 0 0 18px #9b59ff88; flex: 1; }
		#void-panel .status { font-size: 12px; color: var(--v-dim); }
		#void-panel .x { border: 0; background: none; color: var(--v-dim); font-size: 20px; cursor: pointer; padding: 0 4px; }
		#void-panel nav { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid var(--v-line); overflow-x: auto; }
		#void-panel nav button { border: 0; border-bottom: 2px solid transparent; background: none; color: var(--v-dim); padding: 6px 10px; cursor: pointer; font: inherit; white-space: nowrap; }
		#void-panel nav button.on { color: var(--v-text); border-bottom-color: var(--v-accent); }
		#void-panel nav .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px; background: var(--v-hot); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
		#void-panel main { flex: 1; overflow: auto; padding: 14px 16px 18px; }
		#void-panel h3 { margin: 14px 0 6px; font: 600 13px/1.3 system-ui, sans-serif; letter-spacing: 2px; text-transform: uppercase; color: var(--v-accent); }
		#void-panel h3:first-child { margin-top: 0; }
		#void-panel p { margin: 4px 0 8px; }
		#void-panel .dim { color: var(--v-dim); font-size: 12px; }
		#void-panel .box { border: 1px solid var(--v-line); border-radius: 12px; background: #ffffff06; padding: 10px 12px; margin: 0 0 8px; }
		#void-panel .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		#void-panel .grow { flex: 1; min-width: 0; }
		#void-panel button.b { border: 1px solid var(--v-line); border-radius: 999px; background: #ffffff0a; color: var(--v-text); padding: 4px 12px; cursor: pointer; font: inherit; font-size: 13px; }
		#void-panel button.b:hover { border-color: var(--v-accent); }
		#void-panel button.b.main { background: linear-gradient(180deg, #8a4dff, #5b2bc4); border-color: #9b6bff; color: #fff; }
		#void-panel button.b.bad { color: var(--v-bad); }
		#void-panel button.b.on { border-color: var(--v-accent); background: #9b59ff33; }
		#void-panel button.b:disabled { opacity: .45; cursor: default; }
		#void-panel input, #void-panel textarea, #void-panel select { width: 100%; background: #05020a; color: var(--v-text); border: 1px solid var(--v-line); border-radius: 8px; padding: 6px 8px; font: inherit; }
		#void-panel select.auto, #void-panel input.auto { width: auto; }
		#void-panel input[type=checkbox] { width: auto; }
		#void-panel textarea { resize: vertical; min-height: 60px; }
		#void-panel label { display: block; margin: 8px 0 3px; color: var(--v-dim); font-size: 12px; }
		#void-panel label.check { display: inline-flex; gap: 5px; align-items: center; margin: 0; color: var(--v-text); font-size: 13px; }
		#void-panel .msg { color: var(--v-hot); font-size: 13px; white-space: pre-wrap; }
		#void-panel main > .msg { position: sticky; top: -14px; z-index: 3; margin: -4px 0 10px; padding: 6px 10px; border: 1px solid var(--v-line); border-radius: 10px;
			background: var(--v-bg2); box-shadow: 0 4px 12px #0006; }
		#void-panel main > .msg:empty { display: none; }
		#void-panel .order .head { display: flex; gap: 8px; align-items: baseline; }
		#void-panel .order .title { font-weight: 600; flex: 1; }
		#void-panel .order.open { border-color: #9b59ff99; box-shadow: inset 3px 0 0 var(--v-hot); }
		#void-panel .order .body { white-space: pre-wrap; margin: 6px 0; }
		#void-panel .when { color: #ffd0ff; font-weight: 600; }
		#void-panel .branch { margin: 16px 0 2px; font: 600 15px Georgia, serif; letter-spacing: 1px; }
		#void-panel .tier { margin: 6px 0 2px 4px; font-size: 12px; color: var(--v-dim); letter-spacing: 1px; text-transform: uppercase; }
		#void-panel .member { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 8px; cursor: pointer; }
		#void-panel .member:hover { background: #ffffff0c; }
		#void-panel .dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3150; flex: none; }
		#void-panel .dot.on { background: #6bff9e; box-shadow: 0 0 6px #6bff9e; }
		#void-panel .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--v-line); color: var(--v-dim); white-space: nowrap; }
		#void-panel .place { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(130px, 1.3fr) minmax(130px, 1.3fr) auto; gap: 6px; align-items: center; margin-top: 6px; }
		#void-panel .forms { display: grid; grid-template-columns: 64px 1fr 1fr 1fr; gap: 4px 6px; align-items: center; margin: 4px 0; }
		#void-panel .forms .dim { text-align: right; }
		#void-panel details { border: 1px solid var(--v-line); border-radius: 10px; padding: 6px 10px; margin: 6px 0; }
		#void-panel summary { cursor: pointer; font-weight: 600; }
		#void-panel .code { font: 600 22px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; color: #fff; user-select: all; }
		#void-panel .pick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
		#void-panel .dice-pick { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 10px; }
		#void-panel .die { width: 64px; height: 64px; border-radius: 14px; border: 1px solid var(--v-line); background: radial-gradient(circle at 50% 35%, #3a1d66, #0d0618); color: #f1e9ff; cursor: pointer;
			display: flex; flex-direction: column; align-items: center; justify-content: center; font: 600 15px Georgia, serif; box-shadow: inset 0 0 12px #8a4dff44; }
		#void-panel .die:hover { border-color: var(--v-accent); box-shadow: inset 0 0 16px #b48cff77, 0 0 10px #8a4dff66; }
		#void-panel .die canvas { position: static; margin: 0; width: 30px; height: 30px; }
		#void-panel .pool { font: 600 20px Georgia, serif; letter-spacing: 1px; min-height: 28px; }
		#void-card { position: fixed; z-index: 2147483002; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(400px, 94vw); max-height: 94vh; overflow: auto; padding: 18px 18px 16px; border-radius: 18px;
			border: 1px solid #7a52c4; background: radial-gradient(140% 90% at 50% 0%, #3a1d66 0%, #12091f 60%, #08040f 100%); box-shadow: 0 20px 60px #000e, 0 0 60px #8a4dff44; text-align: center; }
		#void-card .x { position: absolute; top: 8px; right: 10px; border: 0; background: none; color: var(--v-dim); font-size: 18px; cursor: pointer; }
		#void-card .badge { position: absolute; top: 10px; left: 10px; width: 64px; height: 64px; }
		#void-card .org { font: 600 12px Georgia, serif; letter-spacing: 4px; text-transform: uppercase; color: var(--v-dim); }
		#void-card .pic { width: 120px; height: 120px; margin: 12px auto 10px; border-radius: 50%; border: 2px solid #9b6bff; background: #05020a center/cover no-repeat;
			display: flex; align-items: center; justify-content: center; font-size: 48px; color: #6a4aa0; box-shadow: 0 0 30px #8a4dff55; }
		#void-card .nm { font: 600 22px Georgia, serif; color: #fff; }
		#void-card .num { color: var(--v-dim); font-size: 12px; }
		#void-card .id { margin: 10px 0 0; padding: 10px 8px 8px; border-top: 1px solid #ffffff14; border-bottom: 1px solid #ffffff14; }
		#void-card .ln { font: 600 16px/1.5 Georgia, serif; letter-spacing: .5px; }
		#void-card .ln .sym { font-size: 13px; opacity: .85; margin: 0 6px; }
		#void-card .ln.motto { font: italic 600 14px Georgia, serif; color: #e9dcff; letter-spacing: 1px; text-shadow: 0 0 12px #b48cff99; }
		#void-card .ln.hybrid { font: 600 18px Georgia, serif; color: #fff; letter-spacing: 2px; text-transform: uppercase; text-shadow: 0 0 14px #b48cffaa; }
		#void-card .ln.chapter { font: italic 14px Georgia, serif; color: #d9c8ff; }
		#void-card .ln.rank { font: 600 15px Georgia, serif; color: #e9dcff; letter-spacing: 1px; }
		#void-panel a, #void-card a { color: var(--v-accent); text-decoration: underline; word-break: break-all; }
		#void-card .pic.zoomable { cursor: zoom-in; }
		#void-zoom { position: absolute; inset: 0; z-index: 2; border-radius: 18px; cursor: zoom-out; background: #05020af2 center/contain no-repeat; }
		#void-panel main, #void-panel nav, #void-panel .picker, #void-card { scrollbar-width: thin; scrollbar-color: var(--v-line) transparent; }
		@media (max-width: 520px) {
			#void-panel h2 { font-size: 15px; letter-spacing: 2px; }
			#void-panel header { padding: 10px 10px 0; gap: 6px; }
			#void-panel nav { padding: 8px 6px 0; flex-wrap: wrap; overflow-x: visible; }
			#void-panel nav button { padding: 6px 7px; }
			#void-panel main { padding: 12px 10px 14px; }
		}
		#void-card .bio { margin-top: 10px; white-space: pre-wrap; font-size: 13px; color: #d6cdee; }
		#void-card .medals { display: flex; justify-content: center; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
		#void-card .medals svg { cursor: help; filter: drop-shadow(0 0 4px #e05cff66); }
		#void-card .commend { display: flex; gap: 8px; align-items: center; text-align: left; margin-top: 6px; font-size: 12px; color: #d6cdee; }
		#void-card .commend b { color: #fff; }
		#void-card .commend .dim { color: var(--v-dim); }
		#void-card .commend button { margin-left: auto; border: 1px solid #5b3d8f; border-radius: 999px; background: none; color: var(--v-bad); font-size: 11px; padding: 1px 8px; cursor: pointer; white-space: nowrap; }
		#void-card h4 { margin: 12px 0 2px; font: 600 11px system-ui, sans-serif; letter-spacing: 2px; text-transform: uppercase; color: var(--v-accent); text-align: left; }
		#void-panel header .icon { border: 1px solid transparent; background: none; color: var(--v-dim); font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 8px; cursor: pointer; }
		#void-panel header .icon:hover, #void-panel header .icon.on { color: var(--v-text); border-color: var(--v-line); background: #ffffff0a; }
		#void-panel .me-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 46%; padding: 2px 10px 2px 2px; border: 1px solid var(--v-line); border-radius: 999px;
			background: #ffffff08; color: var(--v-text); cursor: pointer; font: inherit; }
		#void-panel .me-chip:hover, #void-panel .me-chip.on { border-color: var(--v-accent); }
		#void-panel .me-chip .status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#void-panel .av { --c: #7a52c4; flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
			background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--c) 70%, #fff 10%), #12091f 90%); border: 1px solid var(--c); color: #fff; font: 600 13px/1 Georgia, serif; }
		#void-panel .av::before { content: attr(data-i); }
		#void-panel .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
		#void-panel .chip { --c: var(--v-accent); border: 1px solid var(--v-line); border-radius: 999px; background: #ffffff08; color: var(--v-text); padding: 5px 12px; cursor: pointer; font: inherit; font-size: 13px; }
		#void-panel .chip:hover { border-color: var(--c); }
		#void-panel .chip.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 28%, transparent); color: #fff; }
		#void-panel .chip.toggle::before { content: '○ '; opacity: .7; }
		#void-panel .chip.toggle.on::before { content: '● '; opacity: 1; }
		#void-panel .chip .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 6px; border-radius: 9px; background: var(--v-hot); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
		#void-panel .subnav { margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px dashed var(--v-line); }
		#void-panel .mlist h3 { margin-top: 12px; }
		#void-panel .mrow { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; margin: 0 0 4px; border: 1px solid transparent; border-radius: 12px; background: #ffffff06;
			color: var(--v-text); font: inherit; text-align: left; cursor: pointer; flex-wrap: wrap; }
		#void-panel .mrow:hover { border-color: var(--v-line); background: #ffffff0d; }
		#void-panel .mrow .who { min-width: 110px; }
		#void-panel .mrow .nm { font-weight: 600; }
		#void-panel .mrow .num { color: var(--v-dim); font-size: 12px; }
		#void-panel .mrow .go { margin-left: auto; color: var(--v-dim); font-size: 18px; }
		#void-panel .pills { display: inline-flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
		#void-panel .pill { --c: #8d7bb8; font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; white-space: nowrap; color: #fff;
			background: color-mix(in srgb, var(--c) 35%, transparent); border: 1px solid color-mix(in srgb, var(--c) 70%, transparent); }
		#void-panel .pill.soft { background: none; color: color-mix(in srgb, var(--c) 60%, #fff); }
		#void-panel .pill.hybrid { --c: #e9dcff; font-family: Georgia, serif; letter-spacing: 1px; text-transform: uppercase; }
		#void-panel .sheet-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
		#void-panel .sheet-head .nm { font: 600 18px Georgia, serif; }
		#void-panel .idprev { margin: 0 0 6px; padding: 10px 8px; border-radius: 12px; text-align: center; border: 1px solid #7a52c455;
			background: radial-gradient(140% 120% at 50% 0%, #2c1650 0%, #12091f 70%); }
		#void-panel .idprev .ln { font: 600 15px/1.5 Georgia, serif; }
		#void-panel .idprev .ln .sym { font-size: 12px; opacity: .85; margin: 0 6px; }
		#void-panel .idprev .ln.motto { font: italic 600 13px Georgia, serif; color: #e9dcff; }
		#void-panel .idprev .ln.hybrid { font-size: 16px; letter-spacing: 2px; text-transform: uppercase; color: #fff; }
		#void-panel .idprev .ln.rank { color: #e9dcff; letter-spacing: 1px; }
		#void-panel .idprev .ln.chapter { font: italic 13px Georgia, serif; color: #d9c8ff; }
		#void-panel .sec { margin: 14px 0 0; padding-top: 2px; }
		#void-panel .sec.danger { margin-top: 22px; padding: 10px 12px; border: 1px solid #ff7a9055; border-radius: 12px; background: #ff7a900a; }
		#void-panel .sec.danger h3 { color: var(--v-bad); }
		#void-panel .pl { border: 1px solid var(--v-line); border-radius: 12px; padding: 8px 10px; margin: 0 0 8px; background: #ffffff05; }
		#void-panel .branch.sm { margin: 0; font-size: 14px; }
		#void-panel button.b.sm { padding: 2px 10px; font-size: 12px; }
		#void-panel .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; margin: 6px 0 8px; }
		#void-panel .tile { --c: var(--v-accent); display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 6px; border-radius: 14px; cursor: pointer;
			border: 1px solid var(--v-line); background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--c) 22%, transparent), #0d0618 80%); color: var(--v-text); font: inherit; }
		#void-panel .tile .sym { font-size: 16px; color: var(--c); letter-spacing: 1px; white-space: nowrap; }
		#void-panel .tile .nm { font: 600 13px Georgia, serif; }
		#void-panel .tile:hover { border-color: var(--c); }
		#void-panel .tile.on { border-color: var(--c); box-shadow: 0 0 0 1px var(--c), 0 0 14px color-mix(in srgb, var(--c) 40%, transparent); }
		#void-panel .stepper { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 8px 0 4px; }
		#void-panel .stepper .step { width: 32px; height: 32px; padding: 0; font-size: 18px; line-height: 1; }
		#void-panel .steps { display: flex; gap: 4px; }
		#void-panel .st { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--v-line); background: #05020a; color: var(--v-dim); font: 600 14px Georgia, serif; cursor: pointer; }
		#void-panel .st.below { background: #9b59ff22; color: var(--v-text); }
		#void-panel .st.on { background: linear-gradient(180deg, #8a4dff, #5b2bc4); border-color: #b48cff; color: #fff; }
		#void-panel .st:disabled { opacity: .3; cursor: default; }
		#void-panel .rank-name { font: 600 15px Georgia, serif; margin-left: 4px; }
		#void-panel .save { margin-top: 10px; }
		#void-panel .wtiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; margin: 6px 0; }
		#void-panel .wtile { --c: #c9c4d8; position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 4px; border-radius: 12px;
			border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); background: #ffffff06; color: var(--v-text); font: inherit; font-size: 11px; text-align: center; }
		#void-panel .wtile .nm { line-height: 1.2; }
		#void-panel .wtile.pickable { cursor: pointer; }
		#void-panel .wtile.pickable:hover { border-color: var(--c); background: #ffffff0f; }
		#void-panel .wtile .off { position: absolute; top: 2px; right: 2px; border: 0; background: #0009; color: var(--v-bad); border-radius: 50%; width: 20px; height: 20px; cursor: pointer; font-size: 11px; }
		#void-panel .picker { border: 1px solid var(--v-line); border-radius: 12px; padding: 8px; margin-top: 6px; max-height: 360px; overflow: auto; background: #05020a88; }
		#void-panel .picker .kind { margin: 8px 0 2px; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--v-dim); }
		#void-panel .commend { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
		#void-panel .form label { margin-top: 10px; }
		#void-panel .logline { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px solid #ffffff0a; font-size: 13px; }
		#void-panel .logline .when { color: var(--v-dim); white-space: nowrap; font-weight: 400; }
		@media (max-width: 520px) {
			#void-panel .me-chip .status { display: none; }
			#void-panel .me-chip { padding: 2px; }
			#void-panel .mrow .pills { order: 3; width: 100%; padding-left: 38px; }
			#void-panel .st { width: 30px; height: 30px; }
		}
		#void-panel .medal-pick { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
		#void-panel .medal-pick button { border: 1px solid var(--v-line); border-radius: 8px; background: #ffffff08; padding: 2px 4px; cursor: pointer; }
		#void-panel .medal-pick button.on { border-color: var(--v-accent); background: #9b59ff33; }
		#void-panel .contract.focus { border-color: #ff8a5c; box-shadow: 0 0 0 1px #ff8a5c, 0 0 18px #ff8a5c55; }
		#void-panel .contract .reward { color: #ffd38a; font-weight: 600; }
		#void-panel .contract .quote { font-style: italic; color: #e9dcff; margin: 4px 0; }
		#void-panel .contract .notes { white-space: pre-wrap; margin: 4px 0; padding: 6px 8px; border-left: 2px solid #ff8a5c; background: #ff8a5c10; border-radius: 4px; }
		#void-panel .contract a, #void-panel .hunt-head a { color: var(--v-accent); }
		#void-panel .weapon { display: grid; grid-template-columns: 96px 1fr auto; gap: 10px; align-items: center; }
		#void-panel .weapon .stats { font-size: 12px; color: #e9dcff; }
		.void-sprite { display: flex; align-items: center; justify-content: center; border-radius: 10px; background: radial-gradient(circle at 50% 40%, #4a3270, #160d24); overflow: hidden; }
		.void-sprite img { max-width: 92%; max-height: 92%; object-fit: contain; filter: drop-shadow(0 0 6px #8a4dff88); }
		.void-sprite.none { border: 1px dashed #5b3d8f; color: #6a4aa0; font: 600 22px Georgia, serif; }
		.void-rarity { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
		#void-card .carried { margin-top: 10px; }
		#void-card .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--v-line); color: var(--v-dim); white-space: nowrap; }
		#void-card .carried .row { justify-content: center; gap: 4px; }
		#void-card .carried .void-sprite { width: 100%; height: 150px; }
		#void-card .carried .wname { font: 600 16px Georgia, serif; color: #fff; margin-top: 4px; }
		#void-card .carried .stats { font-size: 12px; color: #e9dcff; }
		#void-card .arms { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: 6px; }
		#void-card .arms .void-sprite { width: 44px; height: 44px; cursor: help; }
		#void-panel .threat { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
		#void-card .foot { margin-top: 12px; font-size: 11px; color: var(--v-dim); border-top: 1px solid #ffffff14; padding-top: 8px; display: flex; gap: 8px; align-items: center; justify-content: center; }
		#void-card .copy { border: 1px solid #5b3d8f; border-radius: 999px; background: none; color: var(--v-dim); font-size: 11px; padding: 1px 8px; cursor: pointer; white-space: nowrap; }
		.void-toast { position: fixed; z-index: 2147483003; right: 16px; width: 300px; max-width: calc(100vw - 32px); padding: 10px 30px 10px 14px; border-radius: 12px; cursor: pointer;
			border: 1px solid #7a52c4; background: #12091fee; box-shadow: 0 8px 30px #000c; transition: opacity .4s, bottom .2s; }
		.void-toast .shut { position: absolute; top: 4px; right: 6px; border: 0; background: none; color: var(--v-dim); font-size: 14px; cursor: pointer; padding: 2px 4px; }
		#void-bubble canvas.eye { width: 82%; height: 82%; pointer-events: none; }
		.void-tip { position: fixed; z-index: 2147483004; max-width: min(280px, calc(100vw - 24px)); padding: 6px 10px; border-radius: 8px; white-space: pre-wrap;
			background: #1d1230f2; color: #f1e9ff; border: 1px solid #7a52c4; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 6px 20px #000a; pointer-events: none; }
		#void-bubble { position: fixed; z-index: 2147483000; width: 52px; height: 52px; padding: 0; border-radius: 50%; border: 2px solid var(--v-accent); display: flex; align-items: center; justify-content: center;
			background: radial-gradient(circle at 35% 30%, #3a1c66, #12091f 70%); color: #f1e9ff; font: 600 12px/1 Georgia, 'Segoe UI Historic', serif; cursor: pointer; touch-action: none; user-select: none;
			box-shadow: 0 4px 16px #000c, 0 0 18px #6a2cff66; text-shadow: 0 0 8px var(--v-accent); }
		#void-bubble.small { width: 40px; height: 40px; font-size: 9px; }
		#void-bubble.dragging { cursor: grabbing; opacity: .85; }
		#void-bubble .badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 9px; background: var(--v-hot); color: #fff;
			font: bold 11px/14px system-ui, sans-serif; text-align: center; border: 2px solid #12091f; text-shadow: none; }
		#void-tab { position: fixed; z-index: 2147483000; left: 0; top: 50%; transform: translateY(-50%); width: 26px; height: 54px; border: 1px solid #5b3d8f; border-left: 0;
			border-radius: 0 10px 10px 0; background: #12091fdd; color: #c9a8ff; font: 600 16px Georgia, serif; cursor: pointer; padding: 0; text-shadow: 0 0 8px #9b59ff; }
		#void-panel.placed { transform: none; }
		#void-panel header { cursor: move; touch-action: none; user-select: none; }
		#void-panel .v-rs { position: absolute; z-index: 3; touch-action: none; }
		#void-panel .v-rs[data-rs="n"], #void-panel .v-rs[data-rs="s"] { left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
		#void-panel .v-rs[data-rs="e"], #void-panel .v-rs[data-rs="w"] { top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
		#void-panel .v-rs[data-rs="nw"], #void-panel .v-rs[data-rs="ne"], #void-panel .v-rs[data-rs="sw"], #void-panel .v-rs[data-rs="se"] { width: 14px; height: 14px; }
		#void-panel .v-rs[data-rs="n"], #void-panel .v-rs[data-rs="nw"], #void-panel .v-rs[data-rs="ne"] { top: 0; }
		#void-panel .v-rs[data-rs="s"], #void-panel .v-rs[data-rs="sw"], #void-panel .v-rs[data-rs="se"] { bottom: 0; }
		#void-panel .v-rs[data-rs="w"], #void-panel .v-rs[data-rs="nw"], #void-panel .v-rs[data-rs="sw"] { left: 0; }
		#void-panel .v-rs[data-rs="e"], #void-panel .v-rs[data-rs="ne"], #void-panel .v-rs[data-rs="se"] { right: 0; }
		#void-panel .v-rs[data-rs="nw"], #void-panel .v-rs[data-rs="se"] { cursor: nwse-resize; }
		#void-panel .v-rs[data-rs="ne"], #void-panel .v-rs[data-rs="sw"] { cursor: nesw-resize; }
		#void-tab { touch-action: none; }
		#void-tab.dragging { cursor: grabbing; opacity: .8; }
		#void-tab.right { left: auto; right: 0; border-left: 1px solid #5b3d8f; border-right: 0; border-radius: 10px 0 0 10px; }
		#void-panel .setting { display: flex; align-items: center; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
		#void-panel .setting .hint { flex-basis: 100%; margin: -2px 0 0 26px; }
		#void-dice { position: fixed; inset: 0; z-index: 2147483004; pointer-events: none; transition: opacity .4s; }
		#void-dice.still { animation: void-fade-in .3s ease-out; }
		@keyframes void-fade-in { from { opacity: 0; } }
		#void-dice canvas { position: absolute; left: 0; top: 0; margin: 0; display: block; width: 100%; height: 100%; }
		#void-dice .banner { position: absolute; left: 50%; transform: translateX(-50%); max-width: 92vw; padding: 6px 16px 8px; border-radius: 14px; text-align: center;
			border: 1px solid #7a52c4; background: #0e0619e6; box-shadow: 0 8px 30px #000a, 0 0 30px #8a4dff44; }
		#void-dice .who { font: 600 14px Georgia, serif; letter-spacing: 1px; color: #e9dcff; }
		#void-dice .sum { font: 600 13px system-ui, sans-serif; color: var(--v-dim); min-height: 18px; }
		#void-roller { position: fixed; z-index: 2147483003; width: 300px; max-width: 94vw; padding: 10px 12px 12px; border-radius: 14px; border: 1px solid #7a52c4;
			background: radial-gradient(120% 90% at 50% 0%, #2a1650 0%, #0c0714 70%); box-shadow: 0 12px 40px #000d, 0 0 30px #6a2cff33; color: var(--v-text);
			font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
		#void-roller * { box-sizing: border-box; }
		#void-roller .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
		#void-roller .top b { flex: 1; font: 600 13px Georgia, serif; letter-spacing: 2px; text-transform: uppercase; color: var(--v-accent); }
		#void-roller .x { border: 0; background: none; color: var(--v-dim); font-size: 16px; cursor: pointer; }
		#void-roller .dice { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
		#void-roller .dice button { display: flex; flex-direction: column; align-items: center; padding: 2px 0; border-radius: 9px; border: 1px solid var(--v-line); cursor: pointer;
			background: radial-gradient(circle at 50% 35%, #3a1d66, #0d0618); color: #f1e9ff; font: 600 11px Georgia, serif; }
		#void-roller .dice button:hover { border-color: var(--v-accent); }
		#void-roller .dice canvas { width: 26px; height: 26px; margin: 0; position: static; }
		#void-roller .pool { margin: 8px 0 6px; min-height: 24px; font: 600 18px Georgia, serif; text-align: center; }
		#void-roller .row { display: flex; align-items: center; gap: 6px; }
		#void-roller .row .grow { flex: 1; }
		#void-roller button.b { border: 1px solid var(--v-line); border-radius: 999px; background: #ffffff0a; color: var(--v-text); padding: 4px 12px; cursor: pointer; font: inherit; font-size: 13px; }
		#void-roller button.b.main { background: linear-gradient(180deg, #8a4dff, #5b2bc4); border-color: #9b6bff; color: #fff; }
		#void-roller button.b.step { width: 28px; padding: 4px 0; }
		#void-roller .mod { min-width: 34px; text-align: center; font: 600 15px Georgia, serif; }
		#void-roller .msg { min-height: 1.2em; color: var(--v-hot); font-size: 12px; margin-top: 4px; }
		#void-roller .hist { margin-top: 6px; border-top: 1px solid #ffffff14; padding-top: 6px; font-size: 12px; color: var(--v-dim); max-height: 120px; overflow: auto; }
		#void-roller .hist div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		#void-dice .sum b { font: 600 22px Georgia, serif; color: #fff; text-shadow: 0 0 14px #e05cff; margin-left: 6px; }
		#void-dice .warn { font-size: 11px; color: #ffb36b; }
	`;
	const style = () => {
		if (!document.getElementById('void-style')) {
			const s = document.createElement('style');
			s.id = 'void-style';
			s.textContent = CSS;
			document.head.append(s);
		}
	};
	/**
	 * A new element with a class and its text.
	 * @param {string} tag
	 * @param {string} [cls]
	 * @param {string} [text]
	 * @returns {any}
	 */
	const make = (tag, cls = '', text = '') => {
		const el = document.createElement(tag);
		if (cls) {
			el.className = cls;
		}
		if (text) {
			el.textContent = text;
		}
		return el;
	};
	/** A button that runs `fn` inside guard. */
	const button = (/** @type {string} */ text, /** @type {() => any} */ fn, cls = 'b') => {
		const b = make('button', cls, text);
		b.addEventListener('click', () => guard(fn, panelSay));
		return b;
	};
	/** A select with [value, text] options. */
	function select(
		/** @type {[string, string][]} */ options,
		/** @type {string} */ value,
		/** @type {(v: string) => any} */ change,
		cls = 'auto',
	) {
		const sel = make('select', cls);
		for (const [v, text] of options) {
			const o = make('option', '', text);
			o.value = v;
			o.selected = v === value;
			sel.append(o);
		}
		sel.addEventListener('change', () => guard(() => change(sel.value), panelSay));
		return sel;
	}
	/**
	 * An element with `text`, its web addresses (http and https only) as links that open in a new tab; the rest stays
	 * plain text, never markup.
	 */
	function linked(/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text) {
		const el = make(tag, cls);
		const str = String(text || '');
		let at = 0;
		for (const m of str.matchAll(/https?:\/\/[^\s<>"']+/g)) {
			const url = m[0].replace(/[.,;:!?)\]]+$/, '');
			let ok = false;
			try {
				ok = /^https?:$/.test(new URL(url).protocol);
			} catch (e) {
				ok = false;
			}
			if (!ok || m.index === undefined) {
				continue;
			}
			el.append(document.createTextNode(str.slice(at, m.index)));
			const a = make('a', '', url);
			a.href = url;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			el.append(a);
			at = m.index + url.length;
		}
		el.append(document.createTextNode(str.slice(at)));
		return el;
	}
	/** A checkbox with its label. */
	function check(/** @type {string} */ text, /** @type {boolean} */ on, /** @type {(on: boolean) => any} */ change) {
		const l = make('label', 'check');
		const c = make('input');
		c.type = 'checkbox';
		c.checked = on;
		c.addEventListener('change', () => guard(() => change(c.checked), panelSay));
		l.append(c, document.createTextNode(text));
		return l;
	}
	/** Keys typed in the panel stay out of the game (see shieldKeys, which also keeps them from other add-ons). */
	const keepKeys = (/** @type {HTMLElement} */ el) => {
		for (const t of ['keydown', 'keyup', 'keypress']) {
			el.addEventListener(t, (e) => {
				if (/** @type {KeyboardEvent} */ (e).key !== 'Escape') {
					e.stopPropagation();
				}
			});
		}
	};
	/** Whether an element is part of the add-on's own windows (the panel, an ID card, the dice tray). */
	const inOurs = (/** @type {any} */ el) => el instanceof Element && !!el.closest('#void-panel, #void-card, #void-dice, #void-roller');
	/**
	 * Keys typed in the add-on's windows, caught on the window before anything else (registered as soon as the add-on
	 * runs): the add-on's own Esc and hotkey are handled here, and the key goes no further, so another add-on that sends
	 * typing to the chat box never sees it. Typing itself still happens (nothing is prevented). If an add-on that
	 * listened earlier still moved the focus to the chat box, it goes back to the field being typed in, caret and all.
	 */
	function shieldKeys(/** @type {KeyboardEvent} */ e) {
		const t = e.target;
		if (!inOurs(t)) {
			return;
		}
		const field = /** @type {HTMLInputElement} */ (t);
		if (document.activeElement !== field && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName) && field.isConnected) {
			field.focus();
		}
		if (e.type === 'keydown') {
			guard(() => {
				hotkeyDown(e);
				if (e.key === 'Escape') {
					escape();
				}
			});
		}
		e.stopImmediatePropagation();
	}
	/** Esc: closes the topmost of ours: a picture shown big, then an ID card, then the dice tray, then the panel. */
	function escape() {
		const top = ['void-zoom', 'void-roller', 'void-card', 'void-dice'].map((id) => document.getElementById(id)).find(Boolean);
		if (top) {
			top.remove();
			render();
		} else {
			closePanel();
		}
	}
	/**
	 * Whether the player is with our windows: their last click was on one of them (or the bubble or side tab), or one
	 * just opened. Then Esc closes it even when nothing of ours has the focus (after a click on a part that takes none,
	 * or right after the bubble opened the panel); an Esc meant for the game, in its chat or elsewhere, is left alone.
	 */
	let withUs = false;
	const OURS = '#void-panel, #void-card, #void-dice, #void-bubble, #void-tab, #void-roller';
	/** A click: on ours, the player is with us; anywhere but on an open ID card, the card closes. */
	function pointerDown(/** @type {PointerEvent} */ e) {
		const t = e.target instanceof Element ? e.target : null;
		withUs = !!t && !!t.closest(OURS);
		if (!t || !t.closest('#void-card')) {
			document.getElementById('void-card')?.remove();
		}
		if (!t || !t.closest('#void-roller, [data-roller]')) {
			document.getElementById('void-roller')?.remove();
		}
	}
	/** Esc on the page itself, or on the bubble or side tab, while the player is with us (listened before the game). */
	function escapeFromPage(/** @type {KeyboardEvent} */ e) {
		const t = e.target;
		const onPage =
			t === document.body || t === document.documentElement || (t instanceof Element && !!t.closest('#void-bubble, #void-tab'));
		if (e.key === 'Escape' && withUs && onPage && (document.getElementById('void-panel') || document.getElementById('void-card'))) {
			// Caught before the game, which would otherwise take this Esc as leaving its screen.
			e.preventDefault();
			e.stopImmediatePropagation();
			escape();
		}
	}
	for (const type of ['keydown', 'keypress', 'keyup']) {
		addEventListener(type, (e) => shieldKeys(/** @type {KeyboardEvent} */ (e)), true);
	}
	/**
	 * A pop-up at the bottom right that goes away by itself (clicking it runs `click`), with a soft sound if that is on;
	 * neither while pop-ups are off or you don't want to be disturbed.
	 */
	function toast(/** @type {string} */ text, /** @type {(() => void) | undefined} */ click) {
		if (!opts.toasts || opts.dnd) {
			return;
		}
		if (opts.sound) {
			chime();
		}
		style();
		const t = make('div', 'void-toast', text);
		const shut = make('button', 'shut', '✕');
		shut.title = 'Close';
		shut.addEventListener('click', (e) => {
			e.stopPropagation();
			t.remove();
			restackToasts();
		});
		t.prepend(shut);
		t.addEventListener('click', () => {
			t.remove();
			restackToasts();
			if (click) {
				guard(click);
			}
		});
		const shown = [...document.querySelectorAll('.void-toast')];
		for (const old of shown.slice(0, Math.max(0, shown.length - 2))) {
			old.remove();
		}
		document.body.append(t);
		restackToasts();
		setTimeout(() => {
			t.style.opacity = '0';
			setTimeout(() => {
				t.remove();
				restackToasts();
			}, 500);
		}, 9000);
	}
	/** Stacks the pop-ups up from the bottom right, above the eye button when it is shown there. */
	function restackToasts() {
		const bubble = document.getElementById('void-bubble');
		const r = bubble ? bubble.getBoundingClientRect() : null;
		const clear = r && r.right > innerWidth - 340 && r.top > innerHeight / 2 ? innerHeight - r.top + 8 : 16;
		let y = clear;
		for (const t of [...document.querySelectorAll('.void-toast')].reverse()) {
			/** @type {HTMLElement} */ (t).style.bottom = `${y}px`;
			y += /** @type {HTMLElement} */ (t).offsetHeight + 8;
		}
	}

	// ---- Commendations: a medal on a ribbon, with one of the Order's pictures
	const SVG_NS = 'http://www.w3.org/2000/svg';
	/**
	 * The pictures, drawn in 24×24: shapes filled in the medal's dark ink ('hole' cuts back to the gold).
	 * @type {Record<string, { name: string, shapes: [string, Record<string, string | number>][] }>}
	 */
	const MEDAL_ICONS = {
		eye: {
			name: 'The Eye',
			shapes: [
				['path', { d: 'M2 12 Q12 3 22 12 Q12 21 2 12 Z', fill: 'none', 'stroke-width': 2 }],
				['circle', { cx: 12, cy: 12, r: 3.5 }],
			],
		},
		scythe: {
			name: 'Scythe',
			shapes: [
				['path', { d: 'M6 22 L15 5', fill: 'none', 'stroke-width': 2.2 }],
				['path', { d: 'M15 5 Q8 1 2 6 Q9 4.5 13.5 8.5 Z' }],
			],
		},
		star: {
			name: 'Star',
			shapes: [['path', { d: 'M12 2 L14.9 8.6 L22 9.3 L16.6 14 L18.2 21 L12 17.3 L5.8 21 L7.4 14 L2 9.3 L9.1 8.6 Z' }]],
		},
		flame: { name: 'Flame', shapes: [['path', { d: 'M12 2 C15 7 19 9 18 15 A6 6 0 0 1 6 15 C5.5 11 8.5 9 9 6 C10.5 8.5 12 9 12 2 Z' }]] },
		moon: { name: 'Moon', shapes: [['path', { d: 'M15 3 A9 9 0 1 0 21 15 A7 7 0 1 1 15 3 Z' }]] },
		crown: { name: 'Crown', shapes: [['path', { d: 'M3 18 L5 7 L9.5 12 L12 5 L14.5 12 L19 7 L21 18 Z' }]] },
		shield: { name: 'Shield', shapes: [['path', { d: 'M12 2 L20 5 V11 C20 16 16.5 19.5 12 22 C7.5 19.5 4 16 4 11 V5 Z' }]] },
		rose: {
			name: 'Rose',
			shapes: [
				['circle', { cx: 12, cy: 8.5, r: 5.5 }],
				['path', { d: 'M12 8.5 m-2.5 0 a2.5 2.5 0 1 0 5 0', fill: 'none', stroke: 'hole', 'stroke-width': 1.4 }],
				['path', { d: 'M12 14 V22 M12 18.5 Q8.5 16 6.5 18', fill: 'none', 'stroke-width': 2 }],
			],
		},
		skull: {
			name: 'Skull',
			shapes: [
				['path', { d: 'M12 2 A8 8 0 0 0 4 10 C4 13 5.5 15 8 16 V21 H16 V16 C18.5 15 20 13 20 10 A8 8 0 0 0 12 2 Z' }],
				['circle', { cx: 8.8, cy: 10.5, r: 2.2, fill: 'hole' }],
				['circle', { cx: 15.2, cy: 10.5, r: 2.2, fill: 'hole' }],
				['path', { d: 'M10.5 18 V21 M13.5 18 V21', fill: 'none', stroke: 'hole', 'stroke-width': 1.2 }],
			],
		},
		chain: {
			name: 'Chain',
			shapes: [
				['ellipse', { cx: 8, cy: 12, rx: 5.5, ry: 3.4, fill: 'none', 'stroke-width': 2.4, transform: 'rotate(-35 8 12)' }],
				['ellipse', { cx: 16, cy: 12, rx: 5.5, ry: 3.4, fill: 'none', 'stroke-width': 2.4, transform: 'rotate(-35 16 12)' }],
			],
		},
		key: {
			name: 'Key',
			shapes: [
				['circle', { cx: 7, cy: 12, r: 4.2, fill: 'none', 'stroke-width': 2.4 }],
				['path', { d: 'M11 12 H21 M17.5 12 V16 M20.5 12 V15', fill: 'none', 'stroke-width': 2.4 }],
			],
		},
		heart: {
			name: 'Heart',
			shapes: [['path', { d: 'M12 21 C5 15 2 11.5 2 7.5 A4.5 4.5 0 0 1 12 6 A4.5 4.5 0 0 1 22 7.5 C22 11.5 19 15 12 21 Z' }]],
		},
	};
	const MEDAL_KEYS = Object.keys(MEDAL_ICONS);
	const GOLD = '#d9b45a';
	const INK = '#2a1648';
	/** A medal `size` pixels tall: a violet ribbon, a gold disc, and the picture on it. */
	function medalSvg(/** @type {string} */ icon, /** @type {number} */ size) {
		const el = (/** @type {string} */ tag, /** @type {Record<string, string | number>} */ attrs) => {
			const e = document.createElementNS(SVG_NS, tag);
			for (const [k, v] of Object.entries(attrs)) {
				e.setAttribute(k, String(v));
			}
			return e;
		};
		const svg = el('svg', { viewBox: '0 0 28 36', width: Math.round((size * 28) / 36), height: size });
		svg.append(
			el('polygon', { points: '7,0 21,0 18,13 10,13', fill: '#5b2bc4' }),
			el('polygon', { points: '12.5,0 15.5,0 14.8,13 13.2,13', fill: '#e05cff' }),
			el('circle', { cx: 14, cy: 23, r: 12, fill: GOLD, stroke: '#fff1c2', 'stroke-width': 1.4 }),
		);
		const g = el('g', {
			transform: 'translate(5 14) scale(0.75)',
			fill: INK,
			stroke: INK,
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
		});
		for (const [tag, attrs] of (MEDAL_ICONS[icon] || MEDAL_ICONS.star).shapes) {
			const a = { ...attrs };
			for (const k of ['fill', 'stroke']) {
				if (a[k] === 'hole') {
					a[k] = GOLD;
				}
			}
			g.append(el(tag, a));
		}
		svg.append(g);
		return svg;
	}

	// ---- ID cards
	/** Member numbers whose card was asked for by the room (a hidden "show ID"), shown when they arrive. */
	const cardWanted = new Set();
	/** Opens an ID card. `fromRoom` cards come from someone showing theirs. */
	function showCard(/** @type {any} */ c, fromRoom = false) {
		style();
		document.getElementById('void-card')?.remove();
		const card = make('div');
		card.id = 'void-card';
		keepKeys(card);
		const x = make('button', 'x', '✕');
		x.addEventListener('click', () => card.remove());
		const pic = make('div', 'pic', c.pic ? '' : '⸸');
		if (c.pic && /^data:image\/(webp|jpeg|png);base64,/.test(c.pic)) {
			pic.style.backgroundImage = `url("${c.pic}")`;
			pic.classList.add('zoomable');
			pic.title = 'See it big';
			pic.addEventListener('click', () => {
				const z = make('div');
				z.id = 'void-zoom';
				z.title = 'Close';
				z.style.backgroundImage = `url("${c.pic}")`;
				z.addEventListener('click', () => z.remove());
				card.append(z);
			});
		}
		const lines = idLines(c, c.founder);
		const id = idBlock(lines);
		if (c.badge && /^[a-z0-9-]{1,40}$/.test(c.badge)) {
			const b = make('img', 'badge');
			b.src = `${ASSETS}badges/${c.badge}-160.png`;
			b.alt = '';
			b.addEventListener('error', () => b.remove());
			card.append(b);
		}
		card.append(x, make('div', 'org', ORDER_NAME), pic, make('div', 'nm', c.name), make('div', 'num', `Member #${c.n}`), id);
		const medals = [...(c.medals || [])].reverse();
		if (medals.length) {
			const row = make('div', 'medals');
			for (const md of medals) {
				const svg = medalSvg(md.icon, 46);
				const tip = document.createElementNS(SVG_NS, 'title');
				tip.textContent = `${md.name}${md.reason ? `: ${md.reason}` : ''} (from ${md.byName}, ${date(md.at)})`;
				svg.prepend(tip);
				row.append(svg);
			}
			card.append(row);
		}
		if (c.bio) {
			card.append(linked('div', 'bio', c.bio));
		}
		if (medals.length) {
			card.append(make('h4', '', 'Commendations'));
			const holder = memberOf(c.n);
			for (const md of medals) {
				const line = make('div', 'commend');
				const text = make('div');
				text.append(
					make('b', '', md.name),
					linked('span', '', md.reason ? ` · ${md.reason}` : ''),
					make('div', 'dim', `from ${md.byName}, ${date(md.at)}`),
				);
				line.append(medalSvg(md.icon, 26), text);
				if (isMember() && (md.by === state.me.n || (holder && topOver(state.me, holder)))) {
					const back = make('button', '', 'Take back');
					back.addEventListener('click', () =>
						guard(async () => {
							const r = await req({ t: 'unaward', member: c.n, id: md.id });
							if (r.t === 'ok') {
								await openCard(c.n, note);
							} else {
								back.textContent = r.why;
							}
						}),
					);
					line.append(back);
				}
				card.append(line);
			}
		}
		card.append(cardArms(c));
		const foot = make('div', 'foot');
		foot.append(make('span', '', `${fromRoom ? 'Shown in this room · ' : ''}In the Order since ${date(c.joined)}`));
		const copy = make('button', 'copy', 'Copy ID');
		copy.title = 'Copy the ID text, in the Order’s format';
		copy.addEventListener('click', () =>
			guard(async () => {
				await navigator.clipboard.writeText(lines.map((l) => l.text).join('\n'));
				copy.textContent = 'Copied';
			}),
		);
		foot.append(copy);
		card.append(foot);
		document.body.append(card);
		withUs = true;
		placeCard(card);
	}
	/** The ID lines of a card, as drawn on it (also the live preview in a member's sheet). */
	function idBlock(/** @type {{ text: string, sym?: string, color?: string, cls?: string }[]} */ lines, cls = 'id') {
		const id = make('div', cls);
		for (const l of lines) {
			const ln = make('div', `ln${l.cls ? ` ${l.cls}` : ''}`);
			if (l.sym) {
				ln.append(make('span', 'sym', l.sym), document.createTextNode(l.text), make('span', 'sym', l.sym));
			} else {
				ln.textContent = l.text;
			}
			if (isColor(l.color)) {
				ln.style.color = l.color;
			}
			id.append(ln);
		}
		return id;
	}
	/** Puts an ID card over the middle of the panel while the panel is open (it may have been moved), inside the screen. */
	function placeCard(/** @type {HTMLElement} */ card) {
		const p = document.getElementById('void-panel');
		if (!p) {
			return;
		}
		const r = p.getBoundingClientRect();
		const c = card.getBoundingClientRect();
		card.style.left = `${between(r.left + r.width / 2, c.width / 2, innerWidth - c.width / 2)}px`;
		card.style.top = `${between(r.top + r.height / 2, c.height / 2, innerHeight - c.height / 2)}px`;
	}
	/** Looks up a member's card on the server and opens it; `say` gets why it couldn't. */
	async function openCard(/** @type {number} */ n, say = panelSay) {
		const r = await req({ t: 'card', member: n });
		if (r.t === 'card' && r.card) {
			showCard(r.card);
		} else {
			say(r.why || `#${n} is not in the Order.`);
		}
	}
	/** Shows your ID card to the room: an emote everyone sees, and a hidden note so Void Order users get the card. */
	function showMyIdInRoom() {
		if (w.CurrentScreen !== 'ChatRoom') {
			return 'Show your ID card in a chat room.';
		}
		if (!isMember()) {
			return 'Only members have an ID card.';
		}
		w.ServerSend('ChatRoomChat', { Content: `shows their ID card of the ${ORDER_NAME}.`, Type: 'Emote' });
		w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ card: true }] });
		return '';
	}
	/** @type {Map<number, number>} When each person's card shown in the room was last opened (once a minute at most). */
	const roomCards = new Map();
	/** @type {Map<number, number>} When each person's last roll shown in the room came. */
	const roomRolls = new Map();
	/** @type {Map<number, number>} When each person's last Void dice line was played. */
	const roomLines = new Map();
	/**
	 * A Void dice line in the room: its dice play, landing on the faces it gives, for the message's sender (not the name
	 * in the text). Not your own (played when you rolled), at most one a second from each person and a few waiting, and
	 * only while other people's dice are on.
	 */
	function rollFromLine(/** @type {string} */ text, /** @type {any} */ sender) {
		const n = sender && sender.MemberNumber;
		if (!n || !w.Player || n === w.Player.MemberNumber || !opts.roomDice) {
			return;
		}
		const r = readRollLine(text);
		if (!r || Date.now() - (roomLines.get(n) || 0) < 1000 || diceQueue.length >= DICE_QUEUE) {
			return;
		}
		roomLines.set(n, Date.now());
		playRoll({ ...r, id: '', by: n, name: nick(sender) }, '');
	}
	/**
	 * A hidden Void Order note in the room: someone showing their card, or a dice roll. The card or roll comes from the
	 * server, not the note, and a roll only counts if it is the sender's own and fresh.
	 */
	function onRoomMessage(/** @type {any} */ data, /** @type {any} */ sender) {
		guard(() => {
			if (data && data.Type === 'Emote' && typeof data.Content === 'string' && data.Content.includes(ROLL_LINE)) {
				return rollFromLine(data.Content, sender);
			}
			if (!data || data.Type !== 'Hidden' || data.Content !== HIDDEN || !sender || !sender.MemberNumber || !ws || !state) {
				return;
			}
			const d = Array.isArray(data.Dictionary) ? data.Dictionary[0] : null;
			const n = sender.MemberNumber;
			if (d && d.card === true && opts.roomCards) {
				const last = roomCards.get(n) || 0;
				if (cardWanted.has(n) || Date.now() - last < 60000) {
					return;
				}
				roomCards.set(n, Date.now());
				cardWanted.add(n);
				ws.send(JSON.stringify({ t: 'card', member: n }));
				setTimeout(() => cardWanted.delete(n), 10000);
			} else if (d && d.here === true && n !== w.Player.MemberNumber) {
				roomVoid.add(n);
				if (d.reply === true && isMember() && Date.now() - (hereAnswered.get(n) || 0) > 10000) {
					hereAnswered.set(n, Date.now());
					sendHere(false);
				}
			} else if (d && typeof d.roll === 'string' && n !== w.Player.MemberNumber && opts.roomDice) {
				// At most one roll a second from each person, and a few waiting.
				if (Date.now() - (roomRolls.get(n) || 0) < 1000 || diceQueue.length >= DICE_QUEUE) {
					return;
				}
				roomRolls.set(n, Date.now());
				return fetchRoll(d.roll, n);
			}
		});
		return false;
	}
	// ---- The Void mark over the members in the room
	/** Where the mark sits on a character (in the game's unzoomed character space): under SlimeBeep's slime. */
	const MARK = { x: 330, y: 80, size: 34 };
	/** Members in this room who run the add-on: they said so with a hidden note when they came in. */
	const roomVoid = new Set();
	/** @type {Map<number, number>} When each person's "who's here" was last answered. */
	const hereAnswered = new Map();
	/** The room you are in, and the room you told you are here. */
	let lastRoom = '';
	let toldHere = '';
	/** A hidden note to the room that you run the add-on; `reply` asks the others to say so too. */
	const sendHere = (/** @type {boolean} */ reply) =>
		w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ here: true, ...(reply ? { reply: true } : {}) }] });
	/** Forgets who was here when you change rooms, and tells a new room you are here (members only). */
	function hereTick() {
		const room = w.CurrentScreen === 'ChatRoom' && w.ChatRoomData && w.ChatRoomData.Name ? String(w.ChatRoomData.Name) : '';
		if (room !== lastRoom) {
			lastRoom = room;
			toldHere = '';
			roomVoid.clear();
		}
		if (room && isMember() && toldHere !== room) {
			toldHere = room;
			sendHere(true);
		}
	}
	/** The member under character C's mark, if it shows: they run the add-on, they are a member, and so are you. */
	function markedMember(/** @type {any} */ C) {
		if (!C || !C.MemberNumber || !isMember() || !opts.roomBadges) {
			return null;
		}
		if (typeof w.ChatRoomHideIconState === 'number' && w.ChatRoomHideIconState > 0) {
			return null;
		}
		const n = C.MemberNumber;
		const m = memberOf(n);
		return m && !m.invited && (n === w.Player.MemberNumber || roomVoid.has(n)) ? m : null;
	}
	// ---- Personal badges (assets/badges/): a member's own picture instead of the plain mark.
	/** @type {{ id: string, name: string }[] | null} The badges there are (assets/badges/index.json). */
	let badges = null;
	let badgesLoading = false;
	function loadBadges() {
		if (badges || badgesLoading) {
			return;
		}
		badgesLoading = true;
		fetch(`${ASSETS}badges/index.json?v=${encodeURIComponent(VERSION)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((list) => {
				badges = Array.isArray(list) ? list : [];
				render();
			})
			.catch((e) => report(e, undefined, 'Badges'))
			.finally(() => (badgesLoading = false));
	}
	/** @type {Map<string, HTMLImageElement>} */
	const badgeImages = new Map();
	/** A badge's picture (48 or 160 px), once loaded; null while loading or if it can't be reached. */
	function badgeImage(/** @type {string} */ id, /** @type {number} */ size) {
		if (!/^[a-z0-9-]{1,40}$/.test(id || '')) {
			return null;
		}
		const k = `${id}-${size}`;
		let img = badgeImages.get(k);
		if (!img) {
			img = new Image();
			img.onerror = () => report(new Error(`badge picture ${k}.png could not be loaded`), undefined, 'Badges');
			img.src = `${ASSETS}badges/${k}.png`;
			badgeImages.set(k, img);
		}
		return img.complete && img.naturalWidth ? img : null;
	}
	/** @type {Map<string, HTMLCanvasElement>} Drawn marks, by symbol and colour. */
	const markImages = new Map();
	/** A mark: the symbol in a dark violet disc with a glowing ring in the branch's colour. */
	function markImage(/** @type {string} */ sym, /** @type {string} */ color) {
		const k = `${sym}|${color}`;
		let c = markImages.get(k);
		if (!c) {
			c = document.createElement('canvas');
			c.width = c.height = 72;
			const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
			const disc = g.createRadialGradient(36, 30, 4, 36, 36, 34);
			disc.addColorStop(0, '#3a1d66');
			disc.addColorStop(1, '#0b0614');
			g.fillStyle = disc;
			g.shadowColor = color;
			g.shadowBlur = 8;
			g.beginPath();
			g.arc(36, 36, 30, 0, Math.PI * 2);
			g.fill();
			g.lineWidth = 3;
			g.strokeStyle = color;
			g.stroke();
			g.shadowBlur = 6;
			g.fillStyle = color;
			g.textAlign = 'center';
			g.textBaseline = 'middle';
			let px = 34;
			do {
				g.font = `600 ${px}px Georgia, 'Segoe UI Symbol', 'Segoe UI Historic', serif`;
				px -= 2;
			} while (g.measureText(sym).width > 46 && px > 10);
			g.fillText(sym, 36, 38);
			markImages.set(k, c);
		}
		return c;
	}
	/** A member's mark: the Founder's, a Monsignor's, their main branch's, or a Neophyte's dim ⸸. */
	function markOf(/** @type {any} */ m) {
		const s = structure();
		const b = m.places[0] && branchOf(m.places[0].b);
		const x = isKeeper(m) ? KEEPER : m.n === founderN() ? s.founder : m.mon ? s.monsignor : b || { sym: '⸸', color: NEOPHYTE_COLOR };
		return { sym: x.sym || '⸸', color: isColor(x.color) ? x.color : '#b48cff' };
	}
	/** Whether the mouse is on the mark of a character drawn at x, y with zoom. */
	const onMark = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) =>
		typeof w.MouseIn === 'function' && w.MouseIn(x + MARK.x * zoom, y + MARK.y * zoom, MARK.size * zoom, MARK.size * zoom);
	/** Draws the Void mark over a member in the room, and their place while the mouse is on it. */
	function drawMark(/** @type {any} */ C, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) {
		const m = markedMember(C);
		// The game's own canvas (its MainCanvas variable isn't on window).
		const g = /** @type {HTMLCanvasElement | null} */ (document.getElementById('MainCanvas'))?.getContext('2d');
		if (!m || !g) {
			return;
		}
		const { sym, color } = markOf(m);
		const badge = m.badge ? badgeImage(m.badge, 48) : null;
		if (badge) {
			// A little larger than the mark: the badge's scythe reaches past its disc.
			const s = MARK.size * 1.3;
			const d = (s - MARK.size) / 2;
			g.drawImage(badge, x + (MARK.x - d) * zoom, y + (MARK.y - d) * zoom, s * zoom, s * zoom);
		} else {
			g.drawImage(markImage(sym, color), x + MARK.x * zoom, y + MARK.y * zoom, MARK.size * zoom, MARK.size * zoom);
		}
		if (onMark(x, y, zoom) && typeof w.DrawTextFit === 'function') {
			w.DrawTextFit(placeSummary(m), x + 250 * zoom, y + (MARK.y + MARK.size / 2) * zoom, 150 * zoom, color, 'black');
		}
	}
	/** A click on someone's mark opens their ID card, and on their target their contract; returns whether it was one. */
	function clickMark(/** @type {any} */ C, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) {
		const bounty = targetOf(C);
		if (bounty && onTarget(x, y, zoom)) {
			guard(() => showContract(bounty.id));
			return true;
		}
		const m = markedMember(C);
		if (!m || !onMark(x, y, zoom)) {
			return false;
		}
		guard(() => openCard(m.n, note));
		return true;
	}

	// ---- The Armory: the Order's catalog of weapons, and who has which
	/** @type {any[] | null} The catalog (assets/weapons/index.json): { id, name, rarity, heroic, void, melee, kind, stats, sprite }. */
	let catalog = null;
	/** @type {Promise<any[]> | null} */
	let catalogLoading = null;
	/** Loads the catalog once; a failed load is tried again next time. */
	/** Why the Armory's list didn't load ('' while it is loading or loaded). */
	let catalogFailed = '';
	function loadCatalog() {
		if (catalogFailed) {
			return Promise.resolve(null);
		}
		catalogLoading =
			catalogLoading ||
			fetch(`${ASSETS}weapons/index.json`)
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((list) => {
					catalog = Array.isArray(list) ? list : [];
					render();
					return catalog;
				})
				.catch((e) => {
					catalogLoading = null;
					catalogFailed = String((e && e.message) || e);
					console.warn('[Oculus Nihili] the Armory list did not load:', e);
					render(true);
					return null;
				});
		return catalogLoading;
	}
	/** The Armory's list could not load: say so, with a Try again. */
	function catalogDown(/** @type {HTMLElement} */ into) {
		into.append(
			make('p', '', "The Armory's list didn't load. Check your connection and try again."),
			button(
				'Try again',
				() => {
					catalogFailed = '';
					render(true);
				},
				'b main',
			),
		);
	}
	/** The app admin's own weapon, shown as a scythe and marked as hers. */
	const SIGNATURE = 100;
	const weaponOf = (/** @type {number} */ id) => (catalog || []).find((x) => x.id === id) || null;
	/** A weapon's kind in the catalog's menu ("Shotguns", "Staffs"…). */
	const kindOf = (/** @type {any} */ x) => (x.id === SIGNATURE ? 'Scythes' : x.kind || 'Other');
	const RARITY = {
		Common: '#c9c4d8',
		Uncommon: '#7fd48a',
		Rare: '#6fb3ff',
		'Very rare': '#c08cff',
		Cursed: '#ff6b6b',
		Legendary: '#ffb84d',
		Personal: '#ff7ad9',
	};
	/** A weapon's picture in a box, or a plain mark for one not drawn yet. */
	function sprite(/** @type {any} */ x, /** @type {number} */ size) {
		const box = make('div', `void-sprite${x.sprite ? '' : ' none'}`);
		if (size) {
			box.style.width = box.style.height = `${size}px`;
		}
		if (x.sprite) {
			const img = make('img');
			img.alt = x.name;
			img.src = `${ASSETS}weapons/${x.id}.png`;
			box.append(img);
		} else {
			box.textContent = '⸸';
			box.title = 'Not drawn yet';
		}
		return box;
	}
	/** A weapon's rarity, Void Order and heroic marks, as tags. */
	function weaponTags(/** @type {any} */ x) {
		const row = make('span', 'row');
		row.style.display = 'inline-flex';
		const r = make('span', 'void-rarity', x.rarity);
		r.style.color = RARITY[x.rarity] || '#c9c4d8';
		row.append(r);
		if (x.void) {
			row.append(make('span', 'tag', '⸸ Void Order'));
		}
		if (x.heroic) {
			row.append(make('span', 'tag', 'Heroic'));
		}
		if (x.id === SIGNATURE) {
			row.append(make('span', 'tag', 'Slime’s signature'));
		}
		return row;
	}
	/** A weapon's stats on one line ("+3 Base damage · +1 Speed"), or '' when it has none. */
	const statsLine = (/** @type {any} */ x) => (Array.isArray(x.stats) ? x.stats.join(' · ') : '');
	/** The weapons a member has, in the catalog's order. */
	const armsOf = (/** @type {any} */ m) => (catalog || []).filter((x) => (m.weapons || []).includes(x.id));
	/** The Armory tab: every weapon by kind, who has it, and carrying your own. */
	function drawArmory(/** @type {HTMLElement} */ body) {
		if (!catalog && catalogFailed) {
			return catalogDown(body);
		}
		if (!catalog) {
			body.append(make('p', 'dim', 'Opening the Armory…'));
			guard(loadCatalog, panelSay);
			return;
		}
		const me = state.me;
		body.append(
			make(
				'p',
				'dim',
				'The Order’s catalog of weapons for its DnD games. The hierarchy issues them; you carry up to two of yours, and they show on your ID card. To hold one, put it on from the wardrobe’s hand-held items.',
			),
		);
		const filter = field('w:filter', '', 40);
		filter.placeholder = 'Find a weapon';
		filter.addEventListener('input', () => render(true));
		const kinds = [...new Set(catalog.map(kindOf))];
		const kind = drafts['w:kind'] || '';
		const row = make('div', 'row');
		filter.classList.add('grow');
		filter.style.width = 'auto';
		row.append(
			filter,
			select([['', 'Every kind'], ['mine', 'Mine'], ...kinds.map((k) => /** @type {[string, string]} */ ([k, k]))], kind, (v) => {
				drafts['w:kind'] = v;
				render(true);
			}),
		);
		body.append(row);
		const q = String(drafts['w:filter'] || '').toLowerCase();
		const mine = me.weapons || [];
		const shown = catalog.filter(
			(x) => (!q || x.name.toLowerCase().includes(q)) && (!kind || (kind === 'mine' ? mine.includes(x.id) : kindOf(x) === kind)),
		);
		for (const k of kinds) {
			const list = shown.filter((x) => kindOf(x) === k);
			if (!list.length) {
				continue;
			}
			body.append(make('h3', '', `${k} · ${list.length}`));
			for (const x of list) {
				const box = make('div', 'box weapon');
				box.id = `weapon-${x.id}`;
				const text = make('div');
				text.append(make('b', '', x.name), document.createTextNode(' '), weaponTags(x));
				const stats = statsLine(x);
				if (stats) {
					text.append(make('div', 'stats', stats));
				}
				if (x.lore) {
					text.append(make('div', 'dim', x.lore));
				}
				// The app admin has every weapon early, for testing: that isn't holding one (Queen's Wrath, hers, is).
				const holders = state.members
					.filter((/** @type {any} */ m) => (m.n !== state.appAdmin || x.id === SIGNATURE) && (m.weapons || []).includes(x.id))
					.map((/** @type {any} */ m) => m.name);
				text.append(make('div', 'dim', holders.length ? `Held by ${holders.join(', ')}` : 'Nobody has it yet'));
				const side = make('div');
				if (mine.includes(x.id)) {
					side.append(carryButtons(me, x));
				}
				box.append(sprite(x, 96), text, side);
				body.append(box);
			}
		}
		if (!shown.length) {
			body.append(make('p', 'dim', 'No weapon matches.'));
		}
	}
	/** The weapons part of an ID card: the one carried, big, and the rest in a row. Waits for the catalog if needed. */
	function cardArms(/** @type {any} */ c) {
		const wrap = make('div');
		if (!(c.weapons || []).length) {
			return wrap;
		}
		if (!catalog) {
			loadCatalog()
				.then(() => wrap.replaceWith(cardArms(c)))
				.catch(() => {});
			return wrap;
		}
		// Only what they carry (at most their limit, Queen's Wrath in a slot of its own), never their whole armory.
		const carried = carriedOf(c)
			.map(weaponOf)
			.filter((/** @type {any} */ x) => x);
		for (const x of carried) {
			const big = make('div', 'carried');
			big.append(sprite(x, 0), make('div', 'wname', x.name), weaponTags(x));
			if (x.id === QUEENS_WRATH) {
				big.append(make('div', 'dim', 'Bound, comes when called'));
			}
			const stats = statsLine(x);
			if (stats) {
				big.append(make('div', 'stats', stats));
			}
			wrap.append(big);
		}
		const counted = carried.filter((/** @type {any} */ x) => x.id !== QUEENS_WRATH).length;
		const limit = c.carryLimit || 2;
		const line = make(
			'div',
			'dim',
			`${counted} of ${limit} carried${limit > 2 && c.n === (state && state.appAdmin) ? ' · slime body' : ''} · ${plural((c.weapons || []).length, 'weapon')} in their armory`,
		);
		wrap.append(line);
		return wrap;
	}
	/**
	 * Carry / Put down for one of your weapons. At your limit, Carry asks which one to put down for it (Queen's Wrath
	 * never counts).
	 */
	function carryButtons(/** @type {any} */ me, /** @type {any} */ x) {
		const now = carriedOf(me);
		const box = make('div');
		if (now.includes(x.id)) {
			box.append(
				button('Put down', () => act({ t: 'carry', weapons: now.filter((id) => id !== x.id) }, () => panelSay(`Put down: ${x.name}.`))),
			);
			return box;
		}
		const counted = now.filter((id) => id !== QUEENS_WRATH);
		if (x.id === QUEENS_WRATH || counted.length < (me.carryLimit || 2)) {
			box.append(button('Carry', () => act({ t: 'carry', weapons: [...now, x.id] }, () => panelSay(`Carrying ${x.name}.`)), 'b main'));
			return box;
		}
		if (drafts['w:swap'] !== String(x.id)) {
			box.append(
				button(
					'Carry',
					() => {
						drafts['w:swap'] = String(x.id);
						render(true);
					},
					'b main',
				),
			);
			return box;
		}
		box.append(make('div', 'dim', 'Put down which?'));
		for (const id of counted) {
			box.append(
				button(weaponOf(id)?.name || `#${id}`, () => {
					delete drafts['w:swap'];
					act({ t: 'carry', weapons: [...now.filter((y) => y !== id), x.id] }, () => panelSay(`Carrying ${x.name}.`));
				}),
			);
		}
		return box;
	}
	/** The weapons a member carries: `carried`, or the one `carry` of an older server. */
	const carriedOf = (/** @type {any} */ m) => (Array.isArray(m.carried) ? m.carried : m.carry ? [m.carry] : []);
	/** Issuing weapons in Manage: the ones a member has (✕ takes one back), and a pick of the others to issue. */
	// ---- The hunt board: the Void Order Prison's public board, as the Order's server last read it
	/** @type {any} The board: { contracts, wanted, debtors, totals, at, url }, or null before the first copy. */
	let huntBoard = null;
	/** The contract shown highlighted on the board (by its code). */
	let huntFocus = '';
	/** Whether a bounty is hidden by the hierarchy (an escaped inmate's key is "vop:<prison number>"). */
	const huntHidden = (/** @type {string} */ key) => !!huntBoard && Array.isArray(huntBoard.hidden) && huntBoard.hidden.includes(key);
	/** Whether you may use items on character C, as the game decides (its own permission check). */
	function mayTouch(/** @type {any} */ C) {
		try {
			return typeof w.ServerChatRoomGetAllowItem === 'function' && !!w.ServerChatRoomGetAllowItem(w.Player, C);
		} catch (e) {
			return false;
		}
	}
	/**
	 * The bounty on character C, if the targets are on: their open contract on the hunting board, or, when the game lets
	 * you use items on them, their escaped inmate's bounty or an Order bounty (not hidden). { id, text } for the target:
	 * the board entry it opens and its words on hover.
	 */
	function targetOf(/** @type {any} */ C) {
		if (!opts.huntTargets || !huntBoard || !C || !C.MemberNumber) {
			return null;
		}
		if (typeof w.ChatRoomHideIconState === 'number' && w.ChatRoomHideIconState > 0) {
			return null;
		}
		const n = C.MemberNumber;
		const contract = huntBoard.contracts.find((/** @type {any} */ x) => x.member === n && x.status === 'open');
		if (contract) {
			return { id: contract.code, text: `Bounty: ${credits(contract)}` };
		}
		const escaped = (huntBoard.escaped || []).find((/** @type {any} */ x) => x.member === n && !huntHidden(`vop:${x.code}`));
		const order = (huntBoard.order || []).find((/** @type {any} */ x) => x.member === n && !huntHidden(x.key));
		if ((!escaped && !order) || !mayTouch(C)) {
			return null;
		}
		return escaped
			? { id: `vop:${escaped.code}`, text: `Escaped: L$ ${(escaped.bounty || 0).toLocaleString('en-US')}` }
			: { id: order.key, text: `Order bounty${order.reward ? `: ${order.reward}` : ''}` };
	}
	/** Where the target sits: under the Void mark's spot, so the two never overlap. */
	const TARGET = { x: MARK.x, y: MARK.y + MARK.size + 6, size: MARK.size };
	const onTarget = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) =>
		typeof w.MouseIn === 'function' && w.MouseIn(x + TARGET.x * zoom, y + TARGET.y * zoom, TARGET.size * zoom, TARGET.size * zoom);
	/** @type {HTMLCanvasElement | null} The target, drawn once: red and white rings and a cross. */
	let targetImage = null;
	function drawTarget(/** @type {any} */ C, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) {
		const bounty = targetOf(C);
		const g = /** @type {HTMLCanvasElement | null} */ (document.getElementById('MainCanvas'))?.getContext('2d');
		if (!bounty || !g) {
			return;
		}
		if (!targetImage) {
			targetImage = document.createElement('canvas');
			targetImage.width = targetImage.height = 72;
			const t = /** @type {CanvasRenderingContext2D} */ (targetImage.getContext('2d'));
			for (const [r, color] of /** @type {[number, string][]} */ ([
				[32, '#ff4d4d'],
				[24, '#ffffff'],
				[16, '#ff4d4d'],
				[8, '#ffffff'],
				[4, '#ff4d4d'],
			])) {
				t.fillStyle = color;
				t.beginPath();
				t.arc(36, 36, r, 0, Math.PI * 2);
				t.fill();
			}
			t.strokeStyle = '#3a0a0a';
			t.lineWidth = 3;
			t.beginPath();
			t.moveTo(36, 0);
			t.lineTo(36, 72);
			t.moveTo(0, 36);
			t.lineTo(72, 36);
			t.stroke();
		}
		g.drawImage(targetImage, x + TARGET.x * zoom, y + TARGET.y * zoom, TARGET.size * zoom, TARGET.size * zoom);
		if (onTarget(x, y, zoom) && typeof w.DrawTextFit === 'function') {
			w.DrawTextFit(bounty.text, x + 250 * zoom, y + (TARGET.y + TARGET.size / 2) * zoom, 150 * zoom, '#ffb38a', 'black');
		}
	}
	/** A contract's reward in words: "1,500 credits", "1,500 credits + 100". */
	const credits = (/** @type {any} */ c) =>
		`${(c.reward || 0).toLocaleString('en-US')} credits${c.bonus ? ` + ${c.bonus.toLocaleString('en-US')}` : ''}`;
	/** The element id of a board entry (a contract's code, "vop:<prison number>" or an Order bounty's key). */
	const huntId = (/** @type {string} */ id) => `hunt-${id.replace(/[^A-Za-z0-9-]/g, '_')}`;
	/** Opens the board on one entry. */
	function showContract(/** @type {string} */ id) {
		huntFocus = id;
		delete drafts['h:filter'];
		openPanel('hunt');
		document.getElementById(huntId(id))?.scrollIntoView({ block: 'center' });
	}
	/** A link to the board's own page: only to the board's site. */
	function boardLink(/** @type {string} */ text, /** @type {string | null} */ href) {
		const base = new URL(huntBoard.url);
		let url = null;
		try {
			url = href ? new URL(href, base) : null;
		} catch (e) {
			url = null;
		}
		const a = make('a', '', text);
		a.href = url && url.origin === base.origin ? url.href : base.href;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		return a;
	}
	function drawHunt(/** @type {HTMLElement} */ body) {
		if (!huntBoard) {
			if (huntAsked && Date.now() - huntAsked > UNREACHABLE) {
				body.append(
					make('p', '', "The hunt board hasn't come in yet: the boards it reads may be down. Try again in a little while."),
					button(
						'Try again',
						() => {
							huntAsked = 0;
							render(true);
						},
						'b main',
					),
				);
				return;
			}
			body.append(make('p', 'dim', 'The Order’s server is reading the hunt board; it comes in a moment.'));
			if (!huntAsked) {
				huntAsked = Date.now();
				setTimeout(() => render(), UNREACHABLE + 500);
			}
			req({ t: 'hunt' });
			return;
		}
		const head = make('p', 'dim hunt-head');
		head.append(
			document.createTextNode(
				`A copy of the Void Order Prison’s public hunt board: every name on it volunteered. Updated ${fromNow(huntBoard.at)}. `,
			),
			boardLink('Open the board', huntBoard.url),
		);
		body.append(head);
		const filter = field('h:filter', '', 40);
		filter.placeholder = 'Find a name or member number';
		filter.addEventListener('input', () => render(true));
		body.append(filter);
		const q = String(drafts['h:filter'] || '').toLowerCase();
		const list = huntBoard.contracts
			.filter((/** @type {any} */ c) => !q || c.name.toLowerCase().includes(q) || String(c.member || '').includes(q))
			.sort(
				(/** @type {any} */ a, /** @type {any} */ b) =>
					Number(b.code === huntFocus) - Number(a.code === huntFocus) || Number(b.status === 'open') - Number(a.status === 'open'),
			);
		body.append(make('h3', '', `Hunting board (volunteers) · ${list.length}`));
		for (const c of list) {
			const box = make('div', `box contract${c.code === huntFocus ? ' focus' : ''}`);
			box.id = huntId(c.code);
			const row = make('div', 'row');
			const who = make('span', 'grow');
			who.append(make('b', '', c.name), make('span', 'dim', c.member ? ` BC #${c.member}` : ''));
			row.append(
				who,
				make('span', 'tag', c.code),
				make('span', 'tag', c.status === 'open' ? 'Open' : c.hunter ? `Hunted by ${c.hunter}` : 'Being hunted'),
			);
			if (c.tracking === 'live') {
				row.append(make('span', 'tag', 'Online now'));
			}
			box.append(row);
			const reward = make('div', 'reward', `💰 ${credits(c)}`);
			if (c.terms) {
				reward.append(make('span', 'dim', ` (${c.terms})`));
			}
			box.append(reward);
			if (c.quote) {
				box.append(make('div', 'quote', `“${c.quote}”`));
			}
			box.append(make('div', 'dim', 'Their wants and limits'), make('div', 'notes', c.notes || 'None written: ask them first.'));
			const foot = make('div', 'dim');
			foot.append(document.createTextNode(`Posted by ${c.postedBy || 'the prison'} · `), boardLink('On vo-p.com', c.url || `#${c.code}`));
			box.append(foot);
			body.append(box);
		}
		if (huntBoard.wanted.length) {
			body.append(
				make('h3', '', 'Most wanted'),
				make('p', 'dim', 'Escaped inmates of the prison. They have no member number on the board.'),
			);
			const THREAT = { CRITICAL: '#ff5c7a', HIGH: '#ff9a5c', MEDIUM: '#ffd38a', LOW: '#9be3a0' };
			for (const x of huntBoard.wanted) {
				const row = make('div', 'member');
				const who = make('span', 'grow');
				who.append(make('b', '', x.name), make('span', 'dim', ` ${x.code}`));
				const bits = [
					x.lastSeen ? `last seen in ${x.lastSeen}` : 'not seen since',
					x.escaped !== null ? `escaped ${plural(x.escaped, 'day')} ago` : '',
				];
				who.append(make('div', 'dim', bits.filter(Boolean).join(' · ')));
				row.append(who);
				if (x.threat) {
					const t = make('span', 'threat', x.threat);
					t.style.color = THREAT[x.threat] || 'var(--v-dim)';
					row.append(t);
				}
				if (x.bounty !== null) {
					row.append(make('span', 'tag', `L$ ${x.bounty.toLocaleString('en-US')}`));
				}
				body.append(row);
			}
		}
		drawEscaped(body, q);
		drawOrderBounties(body, q);
	}
	/** Hide / Show again, for the hierarchy's top: for players who asked out of character to be left alone. */
	function hideButton(/** @type {string} */ key) {
		const hidden = huntHidden(key);
		return button(hidden ? 'Show again' : 'Hide', () => act({ t: 'hidebounty', key, on: !hidden }));
	}
	/** Which bounties of a list you see: the hierarchy's top sees the hidden ones too, marked. */
	const huntShown = (/** @type {string} */ key) => !huntHidden(key) || (isMember() && isTop(state.me));
	/** The bounty board: the prison's escaped inmates, by bounty, with links to their files. */
	function drawEscaped(/** @type {HTMLElement} */ body, /** @type {string} */ q) {
		const all = (huntBoard.escaped || []).filter((/** @type {any} */ x) => huntShown(`vop:${x.code}`));
		const list = all.filter((/** @type {any} */ x) => !q || x.name.toLowerCase().includes(q) || String(x.member || '').includes(q));
		body.append(make('h3', '', `Bounty board (escaped) · ${list.length}`));
		body.append(
			make(
				'p',
				'dim',
				`Escaped inmates of the prison, highest bounty first.${huntBoard.escapedAt ? ` Updated ${fromNow(huntBoard.escapedAt)}.` : ''}`,
			),
		);
		const THREAT = { CRITICAL: '#ff5c7a', HIGH: '#ff9a5c', MEDIUM: '#ffd38a', LOW: '#9be3a0' };
		for (const x of list) {
			const key = `vop:${x.code}`;
			const box = make('div', `box contract${key === huntFocus ? ' focus' : ''}`);
			box.id = huntId(key);
			const row = make('div', 'row');
			const who = make('span', 'grow');
			who.append(make('b', '', x.name), make('span', 'dim', x.member ? ` BC #${x.member}` : ''));
			row.append(who, make('span', 'tag', x.code));
			if (x.threat) {
				const t = make('span', 'threat', x.threat);
				t.style.color = THREAT[x.threat] || 'var(--v-dim)';
				row.append(t);
			}
			if (huntHidden(key)) {
				row.append(make('span', 'tag', 'Hidden'));
			}
			box.append(row);
			if (x.bounty !== null) {
				box.append(make('div', 'reward', `💰 L$ ${x.bounty.toLocaleString('en-US')}`));
			}
			const bits = [x.escapedFor ? `out for ${x.escapedFor.toLowerCase()}` : '', x.lastSeen ? `last seen in ${x.lastSeen}` : ''];
			const foot = make('div', 'dim');
			foot.append(document.createTextNode(`${bits.filter(Boolean).join(' · ') || 'Escaped'} · `), boardLink('Their file', x.url));
			box.append(foot);
			if (isMember() && isTop(state.me)) {
				box.append(hideButton(key));
			}
			body.append(box);
		}
	}
	/** The Holy Order of Void's own bounties, from its sheet. */
	function drawOrderBounties(/** @type {HTMLElement} */ body, /** @type {string} */ q) {
		const all = (huntBoard.order || []).filter((/** @type {any} */ x) => huntShown(x.key));
		const list = all.filter((/** @type {any} */ x) => !q || x.name.toLowerCase().includes(q) || String(x.member).includes(q));
		body.append(make('h3', '', `${ORDER_NAME} bounties · ${list.length}`));
		body.append(make('p', 'dim', `Bounties the Order has put out.${huntBoard.orderAt ? ` Updated ${fromNow(huntBoard.orderAt)}.` : ''}`));
		for (const x of list) {
			const box = make('div', `box contract${x.key === huntFocus ? ' focus' : ''}`);
			box.id = huntId(x.key);
			const row = make('div', 'row');
			const who = make('span', 'grow');
			who.append(make('b', '', x.name), make('span', 'dim', ` BC #${x.member}`));
			row.append(who);
			if (x.expires) {
				row.append(make('span', 'tag', `Until ${x.expires}`));
			}
			if (huntHidden(x.key)) {
				row.append(make('span', 'tag', 'Hidden'));
			}
			box.append(row);
			if (x.reward) {
				box.append(make('div', 'reward', `💰 ${x.reward}`));
			}
			for (const [label, text] of [
				['Why', x.reason],
				['Last seen looking', x.look],
				['Orders', x.instructions],
				['Bring them to', x.where],
				['What they are like', x.personality],
			]) {
				if (text) {
					box.append(make('div', 'dim', label), make('div', 'notes', text));
				}
			}
			if (x.at) {
				box.append(make('div', 'dim', `Posted ${date(x.at)}`));
			}
			if (isMember() && isTop(state.me)) {
				box.append(hideButton(x.key));
			}
			body.append(box);
		}
	}
	/**
	 * Hooks the room's character overlay through the game's mod SDK (so other add-ons' marks keep working): draws the
	 * marks, and opens a card when one is clicked. A mark that fails to draw stops the marks, with one warning.
	 */
	function hookRoom() {
		const sdk = w.bcModSdk;
		if (!sdk || typeof sdk.registerMod !== 'function') {
			return;
		}
		let mod;
		try {
			mod = sdk.registerMod({
				name: 'VoidOrder',
				fullName: 'Oculus Nihili',
				version: VERSION,
				repository: 'https://github.com/Proudkiller0015/void-order',
			});
		} catch (e) {
			report(e, undefined, 'Mod registration');
			return;
		}
		let broken = false;
		let logosBroken = false;
		mod.hookFunction('ChatRoomCharacterViewDrawOverlay', 0, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) => {
			const r = next(args);
			if (!broken) {
				try {
					drawMark(args[0], args[1], args[2], args[3]);
					drawTarget(args[0], args[1], args[2], args[3]);
				} catch (e) {
					broken = true;
					report(e, undefined, 'Room marks');
				}
			}
			if (!logosBroken) {
				try {
					drawLogo(args[0], args[1], args[2], args[3]);
				} catch (e) {
					logosBroken = true;
					report(e, undefined, 'Add-on logos');
				}
			}
			return r;
		});
		mod.hookFunction('ChatRoomCharacterViewClickCharacter', 0, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) =>
			!broken && clickMark(args[0], args[1], args[2], args[3]) ? undefined : next(args),
		);
	}

	// ---- The add-on's logo over everyone in the room who runs Oculus Nihili (member or not), with their version: left of
	// SlimeBeep's slime (x 330, y 42), above the Void mark (x 330, y 80), never on either, and inside the screen.
	const LOGO = { x: 292, y: 42, size: 34 };
	/** The Oculus Nihili version a character runs, from their shared settings ('' when they don't). */
	function addOnVersion(/** @type {any} */ C) {
		if (C && w.Player && C.MemberNumber === w.Player.MemberNumber) {
			return VERSION;
		}
		const v = C && C.OnlineSharedSettings && C.OnlineSharedSettings.OculusNihili;
		return typeof v === 'string' && /^[\w.+-]{1,24}$/.test(v) ? v : '';
	}
	/** A version short enough to sit under the logo: a beta by its number ("2.0.0-beta.2.5" → "b2.5"), a release whole. */
	const shortVersion = (/** @type {string} */ v) => (/-beta\.(.+)$/.exec(v) || [])[1]?.replace(/^/, 'b') || v;
	/** @type {HTMLCanvasElement | null} The logo: the add-on's Void eye, drawn once. */
	let logoImage = null;
	/** Draws the logo over C at x, y with zoom; the full name and version while the mouse is on it. Not clickable. */
	function drawLogo(/** @type {any} */ C, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) {
		const v = addOnVersion(C);
		const g = /** @type {HTMLCanvasElement | null} */ (document.getElementById('MainCanvas'))?.getContext('2d');
		if (!opts.logos || !v || !g || (typeof w.ChatRoomHideIconState === 'number' && w.ChatRoomHideIconState > 0)) {
			return;
		}
		const size = LOGO.size * zoom;
		const left = x + LOGO.x * zoom;
		// The top row of a room starts at the screen's edge: the logo is kept below it.
		const top = Math.max(2, y + LOGO.y * zoom);
		logoImage ??= eyeCanvas();
		g.drawImage(logoImage, left, top, size, size);
		if (typeof w.DrawTextFit === 'function') {
			w.DrawTextFit(shortVersion(v), left + size / 2, top + size + 7 * zoom, size + 4 * zoom, '#c9a8ff', 'black');
			if (typeof w.MouseIn === 'function' && w.MouseIn(left, top, size, size)) {
				w.DrawTextFit(`Oculus Nihili ${v}`, left + size / 2, top - 10 * zoom, 200 * zoom, '#e8defc', 'black');
			}
		}
	}
	/** Looks up a roll shown in the room and plays it, if it is the sender's and fresh. */
	async function fetchRoll(/** @type {string} */ id, /** @type {number} */ sender) {
		const r = await req({ t: 'getroll', id });
		if (r.t !== 'roll' || !r.roll || r.roll.by !== sender || r.age > ROLL_FRESH) {
			return;
		}
		playRoll(r.roll, r.later > 0 ? `not ${r.roll.name}’s latest roll: they rolled again after it` : '');
	}

	// ---- Dice
	/** Most rolls waiting for the tray. */
	const DICE_QUEUE = 3;
	/** @type {{ roll: any, warn: string }[]} Rolls waiting for the tray, which plays one at a time. */
	const diceQueue = [];
	let diceBusy = false;
	/**
	 * Dice in words: "d20", "2d6+3", "3d6+d4-1" (groups in the order rolled).
	 * @param {number[]} sides
	 * @param {number} mod
	 */
	function diceSpec(sides, mod) {
		/** @type {Map<number, number>} */
		const count = new Map();
		for (const s of sides) {
			count.set(s, (count.get(s) || 0) + 1);
		}
		const parts = [...count].map(([s, k]) => `${k > 1 ? k : ''}d${s}`);
		return `${parts.join('+')}${mod > 0 ? `+${mod}` : mod < 0 ? `-${-mod}` : ''}`;
	}
	/** A roll's dice in words: "2d6+3". */
	const rollSpec = (/** @type {any} */ r) =>
		diceSpec(
			r.dice.map((/** @type {any} */ d) => d.s),
			r.mod,
		);
	/** A roll's dice grouped by kind in the order first rolled, as its spec names them ("2d6+d4": the d6s, then the d4). */
	const groupedDice = (/** @type {any} */ r) => {
		const kinds = [...new Set(r.dice.map((/** @type {any} */ d) => d.s))];
		return kinds.flatMap((k) => r.dice.filter((/** @type {any} */ d) => d.s === k));
	};
	/** A roll's faces and modifier added up: "4 + 6 + 3". */
	const rollSum = (/** @type {any} */ r) =>
		`${groupedDice(r)
			.map((/** @type {any} */ d) => d.v)
			.join(' + ')}${r.mod > 0 ? ` + ${r.mod}` : r.mod < 0 ? ` - ${-r.mod}` : ''}`;
	/** A roll in words: "2d6+3: 4 + 6 + 3 = 13", "d20: 17". */
	const rollText = (/** @type {any} */ r) =>
		r.dice.length === 1 && !r.mod ? `${rollSpec(r)}: ${r.total}` : `${rollSpec(r)}: ${rollSum(r)} = ${r.total}`;
	/**
	 * The Void dice line: the one format that posting and reading both use. It goes to the room as an Emote, so everyone
	 * reads "*Name rolls the Void dice: d20+2d6+3: 14 + 4 + 6 + 3 = 27*"; one die with no modifier reads "d6: 3". The
	 * dice are grouped by kind in the order first rolled, the faces follow in that order, then the modifier (" + 3" or
	 * " - 2") and the total. Any client may post this line (SlimeBeep's panel too): Oculus Nihili plays the dice from the
	 * text itself, for the message's sender, so the line proves nothing about who rolled it.
	 */
	const ROLL_LINE = 'rolls the Void dice: ';
	const rollLine = (/** @type {any} */ r) => `${ROLL_LINE}${rollText(r)}`;
	/**
	 * Reads a Void dice line (see ROLL_LINE): { dice: [{ s, v }], mod, total }, or null when it isn't one, doesn't add
	 * up, or is too long.
	 */
	function readRollLine(/** @type {string} */ text) {
		const str = String(text || '');
		const at = str.indexOf(ROLL_LINE);
		if (str.length > 300 || at < 0 || at > 60) {
			return null;
		}
		const m = /^([^:]+): (.+?)\*?\s*$/.exec(str.slice(at + ROLL_LINE.length));
		const spec = m && parseDice(m[1]);
		if (!m || !spec || !spec.dice) {
			return null;
		}
		const mod = spec.mod || 0;
		/** @type {number[]} */
		let faces;
		let total;
		if (/^\d+$/.test(m[2])) {
			if (spec.dice.length !== 1 || mod) {
				return null;
			}
			faces = [Number(m[2])];
			total = faces[0];
		} else {
			const sum = /^(\d+(?: \+ \d+)*)(?: - (\d+))? = (-?\d+)$/.exec(m[2]);
			if (!sum) {
				return null;
			}
			faces = sum[1].split(' + ').map(Number);
			const written = sum[2] ? -Number(sum[2]) : mod > 0 ? Number(faces.pop()) : 0;
			if (written !== mod) {
				return null;
			}
			total = Number(sum[3]);
		}
		const dice = spec.dice;
		if (faces.length !== dice.length || faces.some((v, i) => v < 1 || v > dice[i]) || faces.reduce((a, b) => a + b, mod) !== total) {
			return null;
		}
		return { dice: dice.map((sides, i) => ({ s: sides, v: faces[i] })), mod, total };
	}
	/**
	 * Dice notation: "d20", "2d6+3", "3d6+1d4-2", "d%" for d100. Returns the dice and modifier, or why it can't be rolled.
	 * @returns {{ dice?: number[], mod?: number, why?: string }}
	 */
	function parseDice(/** @type {string} */ text) {
		const s = String(text || '')
			.toLowerCase()
			.replace(/\s+/g, '');
		if (!s || !/^[+-]?(\d*d(\d+|%)|\d+)([+-](\d*d(\d+|%)|\d+))*$/.test(s)) {
			return { why: 'Write dice like d20, 2d6+3 or 3d6+1d4-2.' };
		}
		/** @type {number[]} */
		const dice = [];
		let mod = 0;
		for (const [, sign, count, sides, flat] of s.matchAll(/([+-]?)(?:(\d*)d(\d+|%)|(\d+))/g)) {
			if (flat) {
				mod += (sign === '-' ? -1 : 1) * Number(flat);
				continue;
			}
			const n = count ? Number(count) : 1;
			const sd = sides === '%' ? 100 : Number(sides);
			if (sign === '-' || !DICE.includes(sd)) {
				return { why: `The Void rolls d${DICE.join(', d')}.` };
			}
			for (let i = 0; i < n && dice.length <= LIMITS.dice; i++) {
				dice.push(sd);
			}
		}
		if (!dice.length || dice.length > LIMITS.dice) {
			return { why: `Roll 1 to ${LIMITS.dice} dice at once.` };
		}
		if (Math.abs(mod) > LIMITS.mod) {
			return { why: `The modifier goes from -${LIMITS.mod} to +${LIMITS.mod}.` };
		}
		return { dice, mod };
	}
	/**
	 * Rolls on the server, plays it, and in a chat room shows it to everyone: an emote anyone can read, and a hidden note
	 * with the roll's id so Void Order users see the same dice fall. Returns why it couldn't, or ''.
	 */
	async function roll(/** @type {number[]} */ dice, /** @type {number} */ mod) {
		const r = await req({ t: 'roll', dice, mod });
		if (r.t !== 'ok') {
			return r.why || 'The roll failed.';
		}
		playRoll(r.roll, '', true);
		recentRolls.unshift(r.roll);
		recentRolls.length = Math.min(recentRolls.length, 8);
		if (w.CurrentScreen === 'ChatRoom') {
			w.ServerSend('ChatRoomChat', { Content: rollLine(r.roll), Type: 'Emote' });
			w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ roll: r.roll.id }] });
		}
		render();
		drawRoller();
		return '';
	}
	/** @type {any[]} Your rolls in this session, newest first. */
	const recentRolls = [];
	/** @type {Map<string, number>} Rolls played lately (by sender, dice and faces), so a line and its note play once. */
	const playedRolls = new Map();
	const ONCE_FOR = 8000;
	/** Whether this roll from member n was played in the last few seconds; marks it played. */
	function playedLately(/** @type {any} */ r, /** @type {number} */ n) {
		const key = `${n}|${rollText(r)}`;
		const now = Date.now();
		for (const [k, at] of playedRolls) {
			if (now - at > ONCE_FOR) {
				playedRolls.delete(k);
			}
		}
		if (playedRolls.has(key)) {
			return true;
		}
		playedRolls.set(key, now);
		return false;
	}
	/** Queues a roll for the dice overlay: one at a time, a few waiting, your own always (dropping the oldest other). */
	function playRoll(/** @type {any} */ r, /** @type {string} */ warn, mine = false) {
		if (!mine && playedLately(r, r.by)) {
			return;
		}
		if (mine) {
			playedLately(r, r.by);
		}
		if (diceQueue.length >= DICE_QUEUE) {
			if (!mine) {
				return;
			}
			diceQueue.shift();
		}
		diceQueue.push({ roll: r, warn });
		if (!diceBusy) {
			nextRoll();
		}
	}
	function nextRoll() {
		const next = diceQueue.shift();
		diceBusy = !!next;
		if (next) {
			guard(() => showTray(next.roll, next.warn, nextRoll));
		}
	}
	/**
	 * A die drawn flat, around 0,0 with radius 1: its outline, and the edges inside it that make it read as a solid
	 * (d4 a pyramid, d8 a diamond, d10 a kite, d12 a pentagon in a pentagon, d20 a triangle in a hexagon).
	 * @returns {{ outline: number[][], edges: number[][][] }}
	 */
	function dieShape(/** @type {number} */ sides) {
		const ring = (/** @type {number} */ k, r = 1, turn = 0) =>
			Array.from({ length: k }, (_, i) => {
				const a = turn + (i * 2 * Math.PI) / k - Math.PI / 2;
				return [Math.cos(a) * r, Math.sin(a) * r];
			});
		switch (sides) {
			case 4: {
				const outline = ring(3).map(([x, y]) => [x, y + 0.15]);
				return { outline, edges: outline.map((p) => [p, [0, 0.25]]) };
			}
			case 6:
				return { outline: ring(4, 0.9, Math.PI / 4), edges: [] };
			case 8: {
				const outline = ring(4).map(([x, y]) => [x * 0.85, y]);
				return { outline, edges: [[outline[1], outline[3]]] };
			}
			case 10:
			case 100: {
				const kite = [
					[0, -1],
					[0.5, 0.3],
					[0, 0.55],
					[-0.5, 0.3],
					[0, -1],
				];
				return {
					outline: [
						[0, -1],
						[0.95, 0],
						[0.95, 0.3],
						[0, 1],
						[-0.95, 0.3],
						[-0.95, 0],
					],
					edges: [kite, [kite[1], [0.95, 0.3]], [kite[3], [-0.95, 0.3]], [kite[2], [0, 1]]],
				};
			}
			case 12: {
				const outline = ring(5);
				const inner = ring(5, 0.55);
				return { outline, edges: [[...inner, inner[0]], ...outline.map((p, i) => [p, inner[i]])] };
			}
			default: {
				const outline = ring(6);
				return { outline, edges: [[outline[0], outline[2], outline[4], outline[0]]] };
			}
		}
	}
	/** Traces a die's outline (closed) at `size`. */
	function traceDie(/** @type {CanvasRenderingContext2D} */ g, /** @type {{ outline: number[][] }} */ shape, /** @type {number} */ size) {
		g.beginPath();
		shape.outline.forEach(([x, y], i) => (i ? g.lineTo(x * size, y * size) : g.moveTo(x * size, y * size)));
		g.closePath();
	}
	/** Strokes a die's inner edges at `size`. */
	function strokeEdges(
		/** @type {CanvasRenderingContext2D} */ g,
		/** @type {{ edges: number[][][] }} */ shape,
		/** @type {number} */ size,
	) {
		for (const line of shape.edges) {
			g.beginPath();
			line.forEach(([x, y], i) => (i ? g.lineTo(x * size, y * size) : g.moveTo(x * size, y * size)));
			g.stroke();
		}
	}
	/**
	 * The dice overlay: over the whole game, never in the way (it takes no clicks), the roll's dice are thrown in from
	 * the side, bounce and settle on their faces (about 1.2 s); a small banner names the roller and the total, then it
	 * fades. With reduced motion the dice simply appear, settled. Esc closes it early.
	 */
	function showTray(/** @type {any} */ r, /** @type {string} */ warn, /** @type {() => void} */ done) {
		style();
		document.getElementById('void-dice')?.remove();
		const still = !!w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const tray = make('div', still ? 'still' : '');
		tray.id = 'void-dice';
		tray.dataset.roll = r.id || `line:${r.by}:${Date.now()}`;
		const ordered = groupedDice(r);
		tray.dataset.faces = ordered.map((/** @type {any} */ d) => d.v).join(',');
		const canvas = make('canvas');
		const banner = make('div', 'banner');
		const sum = make('div', 'sum');
		banner.append(make('div', 'who', `${r.name} rolls ${rollSpec(r)}`), sum);
		if (warn) {
			banner.append(make('div', 'warn', `⚠ ${warn}`));
		}
		tray.append(canvas, banner);
		document.body.append(tray);
		const W = innerWidth;
		const H = innerHeight;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
		g.scale(dpr, dpr);
		const n = ordered.length;
		const rows = n > 5 ? 2 : 1;
		const perRow = Math.ceil(n / rows);
		const size = Math.max(22, Math.min(46, (W * 0.7) / perRow / 2.5));
		const cy = H * 0.42;
		banner.style.top = `${cy + (rows === 2 ? size * 2.6 : size * 1.6) + 12}px`;
		const dice = ordered.map((/** @type {any} */ d, /** @type {number} */ i) => {
			const row = Math.floor(i / perRow);
			const inRow = row === rows - 1 ? n - perRow * (rows - 1) : perRow;
			const col = i - row * perRow;
			return {
				...d,
				x: W / 2 + (col - (inRow - 1) / 2) * size * 2.5,
				y: rows === 1 ? cy : cy + (row - 0.5) * size * 2.4,
				from: -size * 2 - Math.random() * W * 0.15,
				lift: 60 + Math.random() * 90,
				spin: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6),
				delay: i * 45,
			};
		});
		const start = performance.now();
		const ROLL = still ? 0 : 1150;
		let settled = false;
		let ended = false;
		const end = () => {
			if (ended) {
				return;
			}
			ended = true;
			tray.remove();
			done();
		};
		const frame = (/** @type {number} */ now) => {
			if (ended || !tray.isConnected) {
				return end();
			}
			const t = now - start;
			g.clearRect(0, 0, W, H);
			for (const d of dice) {
				const k = still ? 1 : Math.min(1, Math.max(0, (t - d.delay) / (ROLL - d.delay)));
				drawDie(g, d, k, size, t);
			}
			if (!settled && t >= ROLL + (still ? 0 : 100)) {
				settled = true;
				tray.dataset.settled = '1';
				sum.textContent = r.dice.length > 1 || r.mod ? rollSum(r) : '';
				sum.append(make('b', '', `= ${r.total}`));
			}
			if (t > ROLL + 2600) {
				tray.style.opacity = '0';
			}
			if (t > ROLL + 3000) {
				return end();
			}
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
	}
	/** One die at progress k (0 thrown, 1 settled): it flies in tumbling, bounces, and lands on its face. */
	function drawDie(
		/** @type {CanvasRenderingContext2D} */ g,
		/** @type {any} */ d,
		/** @type {number} */ k,
		/** @type {number} */ size,
		/** @type {number} */ t,
	) {
		const ease = 1 - (1 - k) ** 3;
		const x = d.from + (d.x - d.from) * ease;
		const bounce = Math.abs(Math.sin(k * Math.PI * 2.5)) * (1 - k) * d.lift;
		const y = d.y - bounce;
		const turn = d.spin * (1 - ease);
		// Tumbling: the face turns away and back (a squash across), slower and slower.
		const squash = k < 1 ? Math.max(0.25, Math.abs(Math.cos(turn * 1.7))) : 1;
		const face = k < 0.92 ? 1 + Math.floor(((t / 70 + d.x) * 7919) % d.s) : d.v;
		const shape = dieShape(d.s);
		g.save();
		g.translate(x, y);
		g.rotate(turn);
		g.scale(squash, 1);
		const glow = k >= 1 ? 18 + 6 * Math.sin(t / 200) : 10;
		g.shadowColor = k >= 1 ? '#e05cff' : '#8a4dff';
		g.shadowBlur = glow;
		const body = g.createRadialGradient(0, -size * 0.4, size * 0.1, 0, 0, size * 1.1);
		body.addColorStop(0, '#5b2bc4');
		body.addColorStop(0.6, '#24103f');
		body.addColorStop(1, '#0b0614');
		g.fillStyle = body;
		g.strokeStyle = '#c9a8ff';
		g.lineWidth = 1.6;
		traceDie(g, shape, size);
		g.fill();
		g.shadowBlur = 0;
		g.stroke();
		g.globalAlpha = 0.45;
		strokeEdges(g, shape, size);
		g.globalAlpha = 1;
		g.scale(1 / squash, 1);
		g.rotate(-turn);
		g.fillStyle = '#fff';
		g.shadowColor = '#e05cff';
		g.shadowBlur = k >= 1 ? 12 : 4;
		const digits = String(face).length;
		g.font = `600 ${Math.round(size * (digits > 2 ? 0.62 : digits > 1 ? 0.78 : 0.9))}px Georgia, serif`;
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		g.fillText(String(face), 0, d.s === 4 ? size * 0.2 : 1);
		g.restore();
	}

	// ---- The Order's group chat in SlimeBeep
	/** SlimeBeep's add-on API, when SlimeBeep runs here too. */
	const slimeBeep = () => (w.SlimeBeep && w.SlimeBeep.api && typeof w.SlimeBeep.api.joinGroup === 'function' ? w.SlimeBeep.api : null);
	/** The member this session already tried to put in the Order chat. */
	let chatTried = 0;
	/**
	 * Puts you in the Order's group chat in SlimeBeep: the server gets an invite from SlimeBeep's relay, and SlimeBeep
	 * joins with it. Remembered per account on this browser, so someone who later leaves the group isn't put back.
	 * @returns {Promise<{ joined: boolean, text: string }>}
	 */
	async function joinChat() {
		const api = slimeBeep();
		if (!api) {
			return { joined: false, text: 'SlimeBeep isn’t running here.' };
		}
		const n = state.me.n;
		const r = await req({ t: 'chat' });
		if (r.t !== 'ok') {
			return { joined: false, text: `⚠ ${r.why}` };
		}
		if (r.already || (typeof api.group === 'function' && api.group(r.gid))) {
			setPref(`chat.${n}`, true);
			return { joined: false, text: 'You’re in the Void Order chat in SlimeBeep already.' };
		}
		const res = await api.joinGroup(`SB-${r.gid}-${r.code}`);
		if (!res || !res.ok) {
			return { joined: false, text: `⚠ SlimeBeep couldn’t join the Order chat: ${(res && res.why) || 'no answer'}` };
		}
		setPref(`chat.${n}`, true);
		return { joined: true, text: 'You’re in the Void Order chat in SlimeBeep.' };
	}
	/** Once per session, a member running SlimeBeep who was never put in the Order chat on this browser is put in. */
	function chatTick() {
		if (!opts.autoChat || !isMember() || !slimeBeep() || chatTried === state.me.n || pref(`chat.${state.me.n}`, false)) {
			return;
		}
		chatTried = state.me.n;
		guard(async () => {
			const r = await joinChat();
			if (r.joined) {
				note(r.text);
			}
		});
	}

	// ---- The panel
	/** How long the server, or the hunt board, may take before the panel says it can't be reached (ms). */
	const UNREACHABLE = 12000;
	/** When the hunt board was first asked for and hasn't come (0: not waiting). */
	let huntAsked = 0;
	/** The first time the eye button shows in a session, a note that the add-on is on and how to open it. */
	function loadedNote() {
		try {
			if (sessionStorage.getItem('voidOrderLoadedNote')) {
				return;
			}
			sessionStorage.setItem('voidOrderLoadedNote', '1');
		} catch (e) {
			return;
		}
		toast('⸸ Oculus Nihili is on. Type /void or tap the eye button to open the Order.', () => openPanel());
	}
	/** On phones a hover tip never shows: a tap on something with one shows it for a moment. */
	function tapTips() {
		document.addEventListener(
			'click',
			(e) => {
				const t = /** @type {HTMLElement} */ (e.target);
				const el = t && t.closest ? /** @type {HTMLElement | null} */ (t.closest('#void-panel [title], #void-card [title]')) : null;
				if (!el || !el.title || el.closest('button, a, input, select, textarea, label, summary')) {
					return;
				}
				document.querySelector('.void-tip')?.remove();
				const tip = make('div', 'void-tip', el.title);
				const r = el.getBoundingClientRect();
				tip.style.left = `${Math.max(8, Math.min(innerWidth - 290, r.left))}px`;
				tip.style.top = `${Math.min(innerHeight - 60, r.bottom + 6)}px`;
				document.body.append(tip);
				setTimeout(() => tip.remove(), 3500);
			},
			true,
		);
	}
	let tab = 'orders';
	/** Unsaved form text, kept across re-renders. */
	const drafts = /** @type {Record<string, any>} */ ({});
	let lastMsg = '';
	function panelSay(/** @type {string} */ text) {
		lastMsg = text;
		const m = document.querySelector('#void-panel .msg');
		if (m) {
			m.textContent = text;
		}
	}
	/** The server's short refusals, in words a player understands. */
	const FRIENDLY = {
		'not allowed': "Your place in the Order doesn't allow that.",
		'bad form': "That choice isn't available.",
		'bad choice': "That choice isn't available.",
		'slow down': 'Too much at once: wait a few seconds and try again.',
		unknown: "The Order's server didn't understand that. Reload the game to get the newest Oculus Nihili.",
		'bad message': "The Order's server didn't understand that. Reload the game to get the newest Oculus Nihili.",
		'server error': "The Order's server hit a problem. Try again in a moment.",
		'sign in first': 'Still signing in to the Order: try again in a moment.',
		'not a member': 'Join the Order first.',
		'signed in with another key': "The Order doesn't recognise this device yet. Ask a branch leader or an admin for a reset code.",
		'no answer from the Order': "The Order's server didn't answer. Check your connection and try again.",
	};
	/** A server answer's reason as a sentence. */
	function friendly(/** @type {any} */ why) {
		const s = String(why || '');
		if (Object.prototype.hasOwnProperty.call(FRIENDLY, s)) {
			return /** @type {any} */ (FRIENDLY)[s];
		}
		const t = s.charAt(0).toUpperCase() + s.slice(1);
		return /[.!?]$/.test(t) ? t : `${t}.`;
	}
	/** Runs a request; its error shows in the panel, and `done` runs when it worked. */
	async function act(/** @type {Record<string, any>} */ x, /** @type {((r: any) => void) | undefined} */ done) {
		panelSay('');
		const r = await req(x);
		if (r.t === 'error') {
			panelSay(`⚠ ${friendly(r.why)}`);
		} else if (done) {
			done(r);
		}
		return r;
	}
	const closePanel = () => {
		document.getElementById('void-panel')?.remove();
		drawTab();
	};
	// ---- The panel's window: moved by its header, resized from its edges and corners, kept on screen. Where it is and how
	// big are kept per browser once moved or resized; until then it sits in the middle at its usual size.
	const WIN = { minW: 360, minH: 300, margin: 8 };
	/** The usual size: what the panel has before it is ever resized. */
	const usualSize = () => ({ w: Math.min(820, Math.round(innerWidth * 0.96)), h: Math.min(680, Math.round(innerHeight * 0.92)) });
	/** @type {{ x: number, y: number, w: number, h: number } | null} */
	let win = pref('win', null);
	const fit = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));
	/** Puts the panel where it was left, inside the window whatever its size or zoom now. */
	function placePanel() {
		const p = document.getElementById('void-panel');
		if (!p) {
			return;
		}
		if (!win) {
			p.classList.remove('placed');
			p.style.left = p.style.top = p.style.width = p.style.height = '';
			return;
		}
		const m = WIN.margin;
		const width = fit(win.w, Math.min(WIN.minW, innerWidth - 2 * m), innerWidth - 2 * m);
		const height = fit(win.h, Math.min(WIN.minH, innerHeight - 2 * m), innerHeight - 2 * m);
		p.classList.add('placed');
		p.style.left = `${fit(win.x, m, innerWidth - width - m)}px`;
		p.style.top = `${fit(win.y, m, innerHeight - height - m)}px`;
		p.style.width = `${width}px`;
		p.style.height = `${height}px`;
	}
	/** Keeps where the panel is (or null: back to the middle at its usual size) for next time. */
	function setWin(/** @type {{ x: number, y: number, w: number, h: number } | null} */ v) {
		win = v;
		setPref('win', v);
		placePanel();
	}
	/** The panel's resize edges and corners, added again after each redraw. */
	function addHandles(/** @type {HTMLElement} */ p) {
		for (const d of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
			const h = make('div', 'v-rs');
			h.dataset.rs = d;
			h.title = 'Drag to resize (double-click: usual size)';
			p.append(h);
		}
	}
	/** Moving and resizing by pointer (mouse, pen or touch), wired once on the panel. */
	function wirePanel(/** @type {HTMLElement} */ p) {
		/** @type {{ mode: string, x0: number, y0: number, r: DOMRect } | null} */
		let op = null;
		p.addEventListener('pointerdown', (e) => {
			const t = /** @type {HTMLElement} */ (e.target);
			const handle = /** @type {HTMLElement | null} */ (t.closest('.v-rs'));
			const head = t.closest('header');
			if (e.button !== 0 || (!handle && (!head || t.closest('button, input, select, a')))) {
				return;
			}
			e.preventDefault();
			op = { mode: handle ? handle.dataset.rs || 'se' : 'move', x0: e.clientX, y0: e.clientY, r: p.getBoundingClientRect() };
			try {
				p.setPointerCapture(e.pointerId);
			} catch (err) {
				/* works without capture */
			}
		});
		p.addEventListener('pointermove', (e) => {
			if (!op) {
				return;
			}
			const m = WIN.margin;
			const dx = fit(e.clientX, 0, innerWidth) - op.x0;
			const dy = fit(e.clientY, 0, innerHeight) - op.y0;
			const r = op.r;
			let { left, top, right, bottom } = r;
			if (op.mode === 'move') {
				left = fit(r.left + dx, m, innerWidth - r.width - m);
				top = fit(r.top + dy, m, innerHeight - r.height - m);
				right = left + r.width;
				bottom = top + r.height;
			} else {
				if (op.mode.includes('w')) {
					left = fit(r.left + dx, m, right - WIN.minW);
				}
				if (op.mode.includes('e')) {
					right = fit(r.right + dx, left + WIN.minW, innerWidth - m);
				}
				if (op.mode.includes('n')) {
					top = fit(r.top + dy, m, bottom - WIN.minH);
				}
				if (op.mode.includes('s')) {
					bottom = fit(r.bottom + dy, top + WIN.minH, innerHeight - m);
				}
			}
			win = { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
			placePanel();
		});
		const end = () => {
			if (op) {
				op = null;
				setWin(win);
			}
		};
		p.addEventListener('pointerup', end);
		p.addEventListener('pointercancel', end);
		p.addEventListener('lostpointercapture', end);
		p.addEventListener('dblclick', (e) => {
			if (/** @type {HTMLElement} */ (e.target).closest('.v-rs')) {
				const r = p.getBoundingClientRect();
				setWin({ x: Math.round(r.left), y: Math.round(r.top), ...usualSize() });
			}
		});
	}
	/** Puts the side tab where it was dragged along its edge. */
	function placeTab() {
		const t = document.getElementById('void-tab');
		if (t) {
			t.style.top = `${fit(pref('tabY', 0.5), 0.06, 0.94) * 100}%`;
		}
	}
	/** The side tab: a click opens the panel, a drag moves it up or down its edge. */
	function wireTab(/** @type {HTMLElement} */ t) {
		/** @type {{ y0: number, moved: boolean } | null} */
		let drag = null;
		t.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) {
				return;
			}
			drag = { y0: e.clientY, moved: false };
			try {
				t.setPointerCapture(e.pointerId);
			} catch (err) {
				/* works without capture */
			}
		});
		t.addEventListener('pointermove', (e) => {
			if (!drag || (!drag.moved && Math.abs(e.clientY - drag.y0) < 8)) {
				return;
			}
			drag.moved = true;
			t.classList.add('dragging');
			setPref('tabY', fit(e.clientY / innerHeight, 0.06, 0.94));
			placeTab();
		});
		const end = (/** @type {boolean} */ open) => {
			if (!drag) {
				return;
			}
			const moved = drag.moved;
			drag = null;
			t.classList.remove('dragging');
			if (open && !moved) {
				guard(() => openPanel());
			}
		};
		t.addEventListener('pointerup', () => end(true));
		t.addEventListener('pointercancel', () => end(false));
	}
	addEventListener('resize', () => {
		placePanel();
		placeTab();
	});

	/** Opens the panel, on a tab if given ('admin:<view>' opens one of the Admin tab's views). */
	function openPanel(/** @type {string | undefined} */ which) {
		style();
		withUs = true;
		if (which) {
			const [t, view] = which.split(':');
			tab = t;
			if (t === 'admin' && view) {
				adminView = view;
			}
		}
		if (!document.getElementById('void-panel')) {
			const p = make('div');
			p.id = 'void-panel';
			keepKeys(p);
			wirePanel(p);
			document.body.append(p);
			lastMsg = '';
		}
		render(true);
		placePanel();
	}
	// ---- Settings: one list for the panel's ⚙ tab and the game's Settings > Extensions page
	/** Accent colours to pick from. */
	const ACCENTS = [
		['#b48cff', 'Violet'],
		['#e05cff', 'Orchid'],
		['#7fd4ff', 'Ice'],
		['#f0d08a', 'Gold'],
		['#ff7a8c', 'Crimson'],
	];
	/**
	 * Every setting: its key, group, label (short: the Extensions page draws it on the game's canvas), kind, default and
	 * an optional hint. Kept per browser, except `server` ones: who sees your room is about what others see, so the
	 * server keeps it (members only).
	 * @type {{ k: string, group: string, label: string, kind: 'bool' | 'choice' | 'key', dflt?: any, choices?: [any, string][], hint?: string, server?: boolean }[]}
	 */
	const SETTINGS = [
		{ k: 'toasts', group: 'Notifications', label: 'Pop-ups for new orders and reminders', kind: 'bool', dflt: true },
		{
			k: 'remind',
			group: 'Notifications',
			label: 'Session reminder',
			kind: 'choice',
			dflt: 15,
			choices: [
				[0, 'Off'],
				[5, '5 min before'],
				[15, '15 min before'],
				[30, '30 min before'],
				[60, '1 hour before'],
			],
		},
		{ k: 'remindNow', group: 'Notifications', label: 'Remind me when a session starts', kind: 'bool', dflt: true },
		{ k: 'sound', group: 'Notifications', label: 'A soft sound with pop-ups', kind: 'bool', dflt: false },
		{
			k: 'dnd',
			group: 'Notifications',
			label: 'Do not disturb',
			kind: 'bool',
			dflt: false,
			hint: 'No pop-ups or sounds; everything is still listed.',
		},
		{ k: 'roomBadges', group: 'Rooms', label: 'Void mark over members in my room', kind: 'bool', dflt: true },
		{
			k: 'logos',
			group: 'Rooms',
			label: 'Oculus Nihili logo over its users',
			kind: 'bool',
			dflt: true,
			hint: 'Over everyone in the room who runs the add-on, with their version.',
		},
		{ k: 'roomCards', group: 'Rooms', label: 'Open ID cards shown in my room', kind: 'bool', dflt: true },
		{ k: 'roomDice', group: 'Rooms', label: 'Play dice others roll in my room', kind: 'bool', dflt: true },
		{
			k: 'huntTargets',
			group: 'Rooms',
			label: 'A target over people with a bounty',
			kind: 'bool',
			dflt: true,
			hint: 'An open contract on the Void Order Prison’s hunt board; click the target to read it.',
		},
		{ k: 'bubble', group: 'Panel', label: 'Show the Void bubble', kind: 'bool', dflt: true },
		{
			k: 'bubbleSize',
			group: 'Panel',
			label: 'Bubble size',
			kind: 'choice',
			dflt: 'normal',
			choices: [
				['normal', 'Normal'],
				['small', 'Small'],
			],
		},
		{ k: 'sideTab', group: 'Panel', label: 'Show the side tab', kind: 'bool', dflt: false },
		{
			k: 'tabSide',
			group: 'Panel',
			label: 'Side tab position',
			kind: 'choice',
			dflt: 'left',
			choices: [
				['left', 'Left'],
				['right', 'Right'],
			],
		},
		{ k: 'hotkey', group: 'Panel', label: 'Open/close key', kind: 'key', dflt: '', hint: 'A plain letter is left alone while you type.' },
		{
			k: 'look',
			group: 'Panel',
			label: 'Look',
			kind: 'choice',
			dflt: 'dark',
			choices: [
				['dark', 'Void dark'],
				['light', 'Light'],
			],
		},
		{ k: 'accent', group: 'Panel', label: 'Accent colour', kind: 'choice', dflt: ACCENTS[0][0], choices: ACCENTS },
		{
			k: 'autoChat',
			group: 'SlimeBeep',
			label: 'Join the Order chat in SlimeBeep',
			kind: 'bool',
			dflt: true,
			hint: 'Once per browser, when you sign in as a member.',
		},
		{
			k: 'roomFor',
			group: 'Privacy',
			label: 'Who sees my public room',
			kind: 'choice',
			server: true,
			choices: [
				['all', 'Everyone in the Order'],
				['over', 'Only those over me'],
				['none', 'Nobody'],
			],
		},
	];
	const settingOf = (/** @type {string} */ k) => /** @type {(typeof SETTINGS)[number]} */ (SETTINGS.find((s) => s.k === k));
	/** The settings in this browser: saved ones, else what older versions kept one by one, else the defaults. */
	const opts = /** @type {Record<string, any>} */ ({});
	{
		const saved = pref('opts', null);
		for (const s of SETTINGS) {
			if (s.server) {
				continue;
			}
			const v = saved && s.k in saved ? saved[s.k] : pref(s.k, s.dflt);
			const ok =
				s.kind === 'bool' ? typeof v === 'boolean' : s.kind === 'key' ? typeof v === 'string' : (s.choices || []).some(([c]) => c === v);
			opts[s.k] = ok ? v : s.dflt;
		}
	}
	/** Whether a setting is shown: the server ones to members only. */
	const shownSetting = (/** @type {(typeof SETTINGS)[number]} */ s) => !s.server || isMember();
	const getSetting = (/** @type {(typeof SETTINGS)[number]} */ s) => (s.server ? state.me[s.k] : opts[s.k]);
	/** A setting's value in words ("15 min before", "F2", "none"). */
	function settingText(/** @type {(typeof SETTINGS)[number]} */ s) {
		const v = getSetting(s);
		if (s.kind === 'key') {
			return pickingKey ? 'press a key… (Esc: none)' : v || 'none';
		}
		return ((s.choices || []).find(([c]) => c === v) || ['', String(v)])[1];
	}
	/** Changes a setting: saved in this browser (or on the server), and applied at once. */
	function setSetting(/** @type {(typeof SETTINGS)[number]} */ s, /** @type {any} */ v) {
		if (s.server) {
			return act({ t: 'profile', [s.k]: v });
		}
		opts[s.k] = v;
		setPref('opts', opts);
		applyLook();
		drawTab();
		render(true);
	}
	/** The lighter look, and the accent colour, over the Void dark one. */
	const LIGHT_CSS = `
		#void-panel, .void-toast, #void-dice { --v-bg: #f7f3fd; --v-bg2: #ece4f8; --v-line: #cdbbe8; --v-text: #23162f; --v-dim: #5e5078; --v-hot: #a3189f; --v-bad: #c0263f; }
		#void-panel { background: linear-gradient(180deg, #ffffff 0%, #f1eafb 100%); box-shadow: 0 0 0 1px #0002, 0 20px 60px #0005; }
		#void-panel h2 { color: #2a1648; text-shadow: none; }
		#void-panel h3 { color: #6a3fc4; }
		#void-panel input, #void-panel textarea, #void-panel select { background: #ffffff; }
		#void-panel .box, #void-panel button.b { background: #ffffffb0; }
		#void-panel button.b.on { background: #b48cff40; }
		#void-panel .member:hover { background: #2a164812; }
		#void-panel .when { color: #9a2fa0; }
		#void-panel .code { color: #23162f; }
		#void-panel a { color: #6a3fc4; }
		#void-panel main > .msg { box-shadow: 0 4px 12px #0002; }
		.void-toast { background: #fbf8ffee; color: #23162f; border-color: #b48cff; box-shadow: 0 8px 30px #0004; }
	`;
	function applyLook() {
		style();
		let el = document.getElementById('void-look');
		if (!el) {
			el = document.createElement('style');
			el.id = 'void-look';
			document.head.append(el);
		}
		const accent = isColor(opts.accent) ? opts.accent : ACCENTS[0][0];
		el.textContent = `#void-panel, #void-card, .void-toast, #void-tab, #void-dice, #void-bubble { --v-accent: ${accent}; }${opts.look === 'light' ? LIGHT_CSS : ''}`;
	}
	/** @type {AudioContext | null} */
	let audio = null;
	/** A soft two-note chime. */
	function chime() {
		try {
			audio = audio || new AudioContext();
			const t = audio.currentTime;
			const o = audio.createOscillator();
			const g = audio.createGain();
			o.type = 'sine';
			o.frequency.setValueAtTime(660, t);
			o.frequency.exponentialRampToValueAtTime(990, t + 0.18);
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
			o.connect(g).connect(audio.destination);
			o.start(t);
			o.stop(t + 0.5);
		} catch (e) {
			/* no sound here */
		}
	}
	/** True while the open/close key is being picked. */
	let pickingKey = false;
	/**
	 * A key press as 'Ctrl+Alt+Shift+B': letters and digits by where they are on the keyboard (so Shift or a keyboard
	 * layout doesn't change them), other keys by name. Null for a modifier on its own.
	 */
	function comboOf(/** @type {KeyboardEvent} */ e) {
		if (!e.key || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) {
			return null;
		}
		const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
		let k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
		if (m) {
			k = m[1] || m[2];
		} else if (e.key === ' ') {
			k = 'Space';
		}
		return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
	}
	/** The open/close key, and picking it. A plain letter or digit is left alone while you type in a text box. */
	function hotkeyDown(/** @type {KeyboardEvent} */ e) {
		if (pickingKey) {
			const combo = e.key === 'Escape' ? '' : comboOf(e);
			if (combo === null) {
				return;
			}
			e.preventDefault();
			e.stopImmediatePropagation();
			pickingKey = false;
			setSetting(settingOf('hotkey'), combo);
			return;
		}
		if (!opts.hotkey || e.repeat || comboOf(e) !== opts.hotkey) {
			return;
		}
		const t = e.target instanceof HTMLElement ? e.target : null;
		const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
		if (typing && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
			return;
		}
		e.preventDefault();
		e.stopImmediatePropagation();
		if (document.getElementById('void-panel')) {
			closePanel();
		} else {
			openPanel();
		}
	}
	/** One setting's control in the panel: a checkbox, a choice or the key picker, with its hint. */
	function settingControl(/** @type {(typeof SETTINGS)[number]} */ s) {
		const row = make('div', 'setting');
		const v = getSetting(s);
		if (s.kind === 'bool') {
			row.append(check(` ${s.label}`, !!v, (on) => setSetting(s, on)));
		} else {
			row.append(make('span', 'grow', s.label));
			if (s.kind === 'key') {
				row.append(
					button(settingText(s), () => {
						pickingKey = !pickingKey;
						render(true);
					}),
				);
			} else {
				const choices = s.choices || [];
				row.append(
					select(
						choices.map(([c, text]) => [String(c), text]),
						String(v),
						(text) => setSetting(s, (choices.find(([c]) => String(c) === text) || [s.dflt])[0]),
					),
				);
			}
		}
		if (s.hint) {
			row.append(make('div', 'dim hint', s.hint));
		}
		return row;
	}
	function drawSettings(/** @type {HTMLElement} */ body) {
		for (const group of [...new Set(SETTINGS.map((s) => s.group))]) {
			const items = SETTINGS.filter((s) => s.group === group && shownSetting(s));
			if (items.length) {
				body.append(make('h3', '', group));
				for (const s of items) {
					body.append(settingControl(s));
				}
			}
		}
		for (const f of moduleSettings) {
			guard(() => f(body), panelSay);
		}
		body.append(
			button('Reset window position', () => {
				setWin(null);
				setPref('tabY', null);
				placeTab();
			}),
		);
		body.append(
			make(
				'p',
				'dim',
				'Kept in this browser, except who sees your room, which the Order keeps. Settings › Extensions in the game opens this tab.',
			),
			make(
				'p',
				'dim',
				`Oculus Nihili ${VERSION}. /void opens this panel; /void card <member number> opens someone's card; /void roll 2d6+3 rolls dice.`,
			),
		);
	}
	/** The Void eye as a picture's address: the add-on's picture on the game's Extensions page. */
	const eyeIcon = () => eyeCanvas().toDataURL('image/png');
	/** The Void eye, drawn on a 64 px canvas: the add-on's picture, and its logo in rooms. */
	function eyeCanvas() {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		g.fillStyle = '#12091f';
		g.beginPath();
		g.arc(32, 32, 31, 0, Math.PI * 2);
		g.fill();
		g.strokeStyle = '#b48cff';
		g.lineWidth = 3;
		g.beginPath();
		g.moveTo(8, 32);
		g.quadraticCurveTo(32, 8, 56, 32);
		g.quadraticCurveTo(32, 56, 8, 32);
		g.stroke();
		g.fillStyle = '#e05cff';
		g.beginPath();
		g.arc(32, 32, 9, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = '#000';
		g.beginPath();
		g.arc(32, 32, 4.5, 0, Math.PI * 2);
		g.fill();
		return c;
	}
	/**
	 * Registers the add-on in the game's Settings > Extensions. Choosing it opens the panel's ⚙ Settings tab and leaves the
	 * game on its list of extensions, so the settings live in one place.
	 */
	/** The game's Settings > Extensions entries: a global binding of the game's scripts, never a property of window. */
	const extensionEntries = () =>
		// eslint-disable-next-line no-undef
		typeof PreferenceExtensionsSettings === 'object' && PreferenceExtensionsSettings ? PreferenceExtensionsSettings : null;
	function registerExtension() {
		if (typeof w.PreferenceRegisterExtensionSetting !== 'function') {
			return;
		}
		if (extensionEntries()?.OculusNihili) {
			return;
		}
		/** Back to the game's list of extensions, once the game has finished choosing this one. */
		const back = () => setTimeout(() => guard(() => w.PreferenceSubscreenExtensionsClear?.()), 0);
		w.PreferenceRegisterExtensionSetting({
			Identifier: 'OculusNihili',
			ButtonText: 'Oculus Nihili',
			Image: eyeIcon(),
			load: () => {
				guard(() => openPanel('settings'));
				back();
			},
			// Only for the moment before the game goes back to its list.
			run: () => {},
			click: back,
			exit: () => true,
		});
	}

	/** Whether you may manage anyone: the Founder, admins and branch leaders. */
	const manages = () => isMember() && (isTop(state.me) || leadsAny(state.me));
	/**
	 * The tabs along the top, in order. Managing (members, bringing people in, the about page, reports) sits under one
	 * Admin tab for those who may; My card and ⚙ Settings are in the header.
	 */
	function tabs() {
		/** @type {[string, string][]} */
		const extra = moduleTabs.filter((x) => !x.admin && guarded(x.show, false)).map((x) => [x.id, x.label]);
		/** @type {[string, string][]} */
		const admin = adminViews().length ? [['admin', '🛡 Admin']] : [];
		if (!isMember()) {
			return [['join', state && state.meta ? 'The Order' : 'Found'], ['hunt', '🎯 Hunt board'], ...extra, ...admin];
		}
		return [
			['orders', 'Orders'],
			['members', 'Members'],
			['order', 'The Order'],
			['armory', 'Armory'],
			['hunt', '🎯 Hunt board'],
			...extra,
			...admin,
		];
	}
	/** The parts of the Admin tab you may use: [id, label]. */
	function adminViews() {
		/** @type {[string, string][]} */
		const v = [];
		if (isMember() && manages()) {
			v.push(['manage', 'Manage'], ['bring', 'Bring in']);
		}
		if (isMember() && isTop(state.me)) {
			v.push(['about', 'About page'], ['log', 'Recent changes']);
		}
		for (const x of moduleTabs) {
			if (x.admin && guarded(x.show, false)) {
				v.push([x.id, x.label]);
			}
		}
		return v;
	}
	/** Whether a redraw waits for the field being typed in to lose focus. */
	let redrawLater = false;
	/**
	 * Draws the panel again (after a change), keeping what is typed and where it is scrolled. While you type in a
	 * field, changes from the server wait until you click elsewhere (`force` draws anyway).
	 */
	function render(force = false) {
		const p = document.getElementById('void-panel');
		if (!p) {
			drawTab();
			return;
		}
		if (tab === 'admin' && adminView === 'reports') {
			unseenReports = 0;
		}
		const active = document.activeElement;
		if (!force && active && p.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
			if (!redrawLater) {
				redrawLater = true;
				active.addEventListener(
					'blur',
					() =>
						setTimeout(() => {
							redrawLater = false;
							render();
						}, 0),
					{ once: true },
				);
			}
			return;
		}
		const main = p.querySelector('main');
		const scroll = main ? main.scrollTop : 0;
		const kept = new Map(
			[...p.querySelectorAll('[data-keep]')].map((el) => [/** @type {HTMLElement} */ (el).dataset.keep, [el.scrollTop, el.scrollLeft]]),
		);
		const open = [...p.querySelectorAll('details[data-k]')]
			.filter((d) => /** @type {any} */ (d).open)
			.map((d) => /** @type {any} */ (d).dataset.k);
		p.replaceChildren();
		const x = make('button', 'x', '✕');
		x.title = 'Close';
		x.addEventListener('click', closePanel);
		const head = make('header');
		head.append(make('h2', '', state && state.meta ? ORDER_NAME : 'Oculus Nihili'));
		const go = (/** @type {string} */ id) => {
			tab = id;
			lastMsg = '';
			render(true);
		};
		if (isMember()) {
			// Your place, behind your initial: it opens your card.
			const me = make('button', `me-chip${tab === 'me' ? ' on' : ''}`);
			me.title = 'My card';
			me.append(avatar(state.me), make('span', 'status', statusLine()));
			me.addEventListener('click', () => go('me'));
			head.append(me);
		} else {
			head.append(make('span', 'status', statusLine()));
		}
		const dice = make('button', `icon${document.getElementById('void-roller') ? ' on' : ''}`, '🎲');
		dice.title = 'Roll the Void dice';
		dice.dataset.roller = '1';
		dice.addEventListener('click', () => guard(() => toggleRoller(dice)));
		head.append(dice);
		const gear = make('button', `icon${tab === 'settings' ? ' on' : ''}`, '⚙');
		gear.title = 'Settings';
		gear.addEventListener('click', () => go('settings'));
		head.append(gear, x);
		p.append(head);
		const list = tabs();
		if (!list.some(([id]) => id === tab) && tab !== 'settings' && !(tab === 'me' && isMember())) {
			tab = list[0][0];
		}
		const nav = make('nav');
		nav.dataset.keep = 'nav';
		for (const [id, label] of list) {
			const b = make('button', id === tab ? 'on' : '', label);
			const count = id === 'orders' ? openOrders() : id === 'admin' ? unplacedFor().length : 0;
			if (count) {
				b.append(make('span', 'badge', String(count)));
			}
			b.addEventListener('click', () => go(id));
			nav.append(b);
		}
		p.append(nav);
		const body = make('main');
		guard(() => {
			if (!state) {
				if (tryingSince && Date.now() - tryingSince > UNREACHABLE) {
					body.append(
						make('p', '', "Can't reach the Order's server. Oculus Nihili keeps trying; check your connection, or try again now."),
						button(
							'Try again',
							() => {
								tryingSince = Date.now();
								setTimeout(() => render(), UNREACHABLE + 500);
								reconnect();
								render(true);
							},
							'b main',
						),
					);
				} else {
					body.append(make('p', 'dim', ws ? 'Signing in…' : 'Connecting to the Order…'));
				}
			} else {
				const draw = {
					orders: drawOrders,
					members: drawMembers,
					order: drawOrder,
					admin: drawAdmin,
					me: drawMe,
					join: drawJoin,
					settings: drawSettings,
					hunt: drawHunt,
					armory: drawArmory,
				};
				const fromModule = moduleTabs.find((x) => x.id === tab);
				(fromModule ? fromModule.draw : draw[tab])(body);
			}
		}, panelSay);
		// Above the view, so a confirmation or an error shows where you are, however far down you scrolled.
		const msg = make('div', 'msg', lastMsg);
		body.prepend(msg);
		p.append(body);
		for (const d of body.querySelectorAll('details[data-k]')) {
			if (open.includes(/** @type {any} */ (d).dataset.k)) {
				/** @type {any} */ (d).open = true;
			}
		}
		body.scrollTop = scroll;
		for (const el of p.querySelectorAll('[data-keep]')) {
			const k = kept.get(/** @type {HTMLElement} */ (el).dataset.keep);
			if (k) {
				[el.scrollTop, el.scrollLeft] = k;
			}
		}
		addHandles(p);
		drawTab();
	}
	const openOrders = () => [...orders.values()].filter(waitsForMe).length;
	/** Members waiting for a place that you may place. */
	const unplacedFor = () =>
		isMember() && manages()
			? state.members.filter(
					(/** @type {any} */ m) => !m.places.length && !m.mon && !isTop(m) && (topOver(state.me, m) || placesNew(state.me, m)),
				)
			: [];
	/** Your place in a few words, for the panel's header. */
	function statusLine() {
		if (!state) {
			return 'offline';
		}
		if (!isMember()) {
			return { guest: 'Not a member', invited: 'Invited', mismatch: 'Device not recognised' }[state.status] || '';
		}
		return placeSummary(state.me);
	}
	/** An input bound to drafts[k]. */
	function field(/** @type {string} */ k, /** @type {string} */ value, /** @type {number} */ max, tag = 'input') {
		const el = make(tag);
		el.maxLength = max;
		el.value = k in drafts ? drafts[k] : value;
		el.addEventListener('input', () => {
			drafts[k] = el.value;
		});
		return el;
	}
	/** Forgets a form's drafts: the keys `form:…`. */
	const forget = (/** @type {string} */ form) => {
		for (const k of Object.keys(drafts)) {
			if (k.startsWith(`${form}:`)) {
				delete drafts[k];
			}
		}
	};
	/** @type {Map<string, number>} When each "click again to…" was asked. */
	const confirms = new Map();
	/**
	 * Whether `key` was clicked once already in the last 8 seconds; if not, asks for a second click with `ask`.
	 * @param {string} key
	 * @param {string} ask
	 */
	const confirmed = (key, ask) => {
		if (Date.now() - (confirms.get(key) || 0) < 8000) {
			confirms.delete(key);
			return true;
		}
		confirms.set(key, Date.now());
		panelSay(ask);
		return false;
	};
	const label = (/** @type {string} */ text) => make('label', '', text);
	/** A branch's name with its symbols, in its colour. */
	function branchTitle(/** @type {any} */ b, cls = 'branch', extra = '') {
		const h = make('div', cls, `${withSym(b)}${extra}`);
		if (isColor(b.color)) {
			h.style.color = b.color;
		}
		return h;
	}

	// -- Orders
	function drawOrders(/** @type {HTMLElement} */ body) {
		if (mayOrder()) {
			body.append(drawNewOrder());
		}
		const list = [...orders.values()].sort((a, b) => {
			// Unanswered first, then newest.
			const oa = waitsForMe(a) ? 0 : 1;
			const ob = waitsForMe(b) ? 0 : 1;
			return oa - ob || b.at - a.at;
		});
		if (isMember() && !state.me.places.length && !state.me.mon && !isTop(state.me)) {
			const box = make('div', 'box');
			box.append(
				make('b', '', `You're in the ${ORDER_NAME}.`),
				make(
					'p',
					'dim',
					'A branch leader will place you in a branch soon. Until then, orders for new members show here, and your ID card is under your name at the top.',
				),
			);
			body.append(box);
		}
		body.append(make('h3', '', 'Orders and sessions'));
		if (!list.length) {
			body.append(make('p', 'dim', 'Nothing from the hierarchy yet.'));
		}
		for (const o of list) {
			body.append(drawOrderBox(o));
		}
	}
	/** An order group in words: "Paladin", "Paladin - Knight", "Paladin: Salvatoris", "Monsignors". */
	function groupName(/** @type {string} */ g) {
		if (g === 'monsignor') {
			return `${structure().monsignor.name}s`;
		}
		if (g === 'unplaced') {
			return `${NEOPHYTE}s`;
		}
		const [, id, sep, rest] = /^([a-z0-9-]+)(?:([/:])([a-z0-9-]+))?$/.exec(g) || [];
		const b = branchOf(id);
		if (!b) {
			return 'a removed group';
		}
		if (sep === '/') {
			return `${b.name} - ${tierLabel(b.tiers[Number(rest) - 1])}`;
		}
		if (sep === ':') {
			return `${b.name}: ${b.chapters.find((/** @type {any} */ c) => c.id === rest)?.name || 'a removed chapter'}`;
		}
		return b.name;
	}
	/** Who an order goes to, in words. */
	function toWords(/** @type {any} */ to) {
		if (to.all) {
			return 'everyone below';
		}
		return [...(to.groups || []).map(groupName), ...(to.members || []).map((/** @type {number} */ n) => memberOf(n)?.name || `#${n}`)].join(
			', ',
		);
	}
	function drawOrderBox(/** @type {any} */ o) {
		const open = waitsForMe(o);
		const box = make('div', `box order${open ? ' open' : ''}`);
		const head = make('div', 'head');
		head.append(make('span', '', KIND_ICON[o.kind]), make('span', 'title', o.title), make('span', 'dim', fromNow(o.at)));
		box.append(head);
		box.append(make('div', 'dim', `${KIND_NAME[o.kind]} from ${o.byName} to ${toWords(o.to)}`));
		if (o.kind === 'session') {
			box.append(make('div', 'when', `🕰 ${dateTime(o.when)} (${fromNow(o.when)})`));
		}
		if (o.body) {
			box.append(linked('div', 'body', o.body));
		}
		const row = make('div', 'row');
		if (isForMe(o)) {
			const mine = myAck(o);
			for (const a of ACKS[o.kind]) {
				const b = button(ACK_LABEL[a], () => act({ t: 'ack', id: o.id, a }));
				if (mine && mine.a === a) {
					b.classList.add('on');
				}
				row.append(b);
			}
		}
		row.append(make('span', 'grow'));
		const author = memberOf(o.by);
		if (o.by === state.me.n || (author ? commands(state.me, author) : isTop(state.me))) {
			row.append(
				button(
					'Take down',
					() => {
						if (confirmed(`unorder:${o.id}`, `Click "Take down" again to remove "${o.title}" for everyone.`)) {
							return act({ t: 'unorder', id: o.id });
						}
					},
					'b bad',
				),
			);
		}
		box.append(row);
		if (o.acks) {
			box.append(drawAcks(o));
		}
		return box;
	}
	/** The answers to an order, for its author and those over them. */
	function drawAcks(/** @type {any} */ o) {
		const wrap = make('div', 'dim');
		const by = /** @type {Record<string, string[]>} */ ({});
		for (const [n, a] of Object.entries(o.acks)) {
			(by[/** @type {any} */ (a).a] = by[/** @type {any} */ (a).a] || []).push(memberOf(Number(n))?.name || `#${n}`);
		}
		const parts = ACKS[o.kind].filter((a) => by[a]).map((a) => `${ACK_LABEL[a]} (${by[a].length}): ${by[a].join(', ')}`);
		wrap.textContent = parts.length ? parts.join(' · ') : 'No answers yet.';
		wrap.style.marginTop = '6px';
		return wrap;
	}
	/** The groups you may send orders to: every one for the Founder and admins, inside your branch for a leader. */
	function addressable() {
		const me = state.me;
		const top = isTop(me);
		/** @type {[string, string][]} */
		const out = [];
		for (const b of top ? structure().branches : ledBy(me)) {
			const mine = top ? TIERS + 1 : tierOf(me, b.id);
			out.push([b.id, `${withSym(b)}`]);
			for (let t = TIERS; t >= 1; t--) {
				if (t < mine) {
					out.push([`${b.id}/${t}`, groupName(`${b.id}/${t}`)]);
				}
			}
			for (const c of b.chapters) {
				out.push([`${b.id}:${c.id}`, groupName(`${b.id}:${c.id}`)]);
			}
		}
		if (top) {
			out.push(['monsignor', groupName('monsignor')], ['unplaced', groupName('unplaced')]);
		}
		return out;
	}
	function drawNewOrder() {
		const box = make('div', 'box');
		if (!drafts['n:open']) {
			box.append(
				button('＋ New order, session or notice', () => {
					drafts['n:open'] = '1';
					render(true);
				}),
			);
			return box;
		}
		const kind = drafts['n:kind'] || 'order';
		const kinds = make('div', 'row');
		for (const k of Object.keys(KIND_NAME)) {
			const b = button(`${KIND_ICON[k]} ${KIND_NAME[k]}`, () => {
				drafts['n:kind'] = k;
				render(true);
			});
			if (k === kind) {
				b.classList.add('on');
			}
			kinds.append(b);
		}
		box.append(
			kinds,
			label('Title'),
			field('n:title', '', LIMITS.orderTitle),
			label('Details'),
			field('n:body', '', LIMITS.orderText, 'textarea'),
		);
		if (kind === 'session') {
			const when = field('n:when', '', 20);
			when.type = 'datetime-local';
			box.append(label('When (your time)'), when);
		}
		// Who it goes to: everyone below you, or groups and members below you.
		box.append(label('For'));
		const to = drafts['n:to'] || 'all';
		const pickTo = make('div', 'row');
		for (const [k, text] of [
			['all', 'Everyone below you'],
			['groups', 'Branches, ranks and chapters'],
			['members', 'Members'],
		]) {
			const b = button(text, () => {
				drafts['n:to'] = k;
				render(true);
			});
			if (k === to) {
				b.classList.add('on');
			}
			pickTo.append(b);
		}
		box.append(pickTo);
		const chosen = new Set(
			String(drafts[`n:pick-${to}`] || '')
				.split(',')
				.filter(Boolean),
		);
		if (to !== 'all') {
			const pick = make('div', 'pick');
			const items =
				to === 'groups'
					? addressable()
					: state.members.filter((/** @type {any} */ m) => commands(state.me, m)).map((/** @type {any} */ m) => [String(m.n), m.name]);
			for (const [id, text] of items) {
				const b = button(text, () => {
					if (chosen.has(id)) {
						chosen.delete(id);
					} else {
						chosen.add(id);
					}
					drafts[`n:pick-${to}`] = [...chosen].join(',');
					render(true);
				});
				if (chosen.has(id)) {
					b.classList.add('on');
				}
				pick.append(b);
			}
			box.append(pick);
		}
		const row = make('div', 'row');
		row.style.marginTop = '10px';
		row.append(
			button(
				'Send',
				() => {
					/** @type {Record<string, any>} */
					const dest = to === 'all' ? { all: true } : to === 'groups' ? { groups: [...chosen] } : { members: [...chosen].map(Number) };
					const when = kind === 'session' ? new Date(drafts['n:when'] || '').getTime() : undefined;
					if (kind === 'session' && !(when > Date.now())) {
						panelSay('⚠ Pick when the session is, in the future.');
						return;
					}
					return act({ t: 'order', kind, title: drafts['n:title'] || '', body: drafts['n:body'] || '', to: dest, when }, () => {
						forget('n');
						render(true);
					});
				},
				'b main',
			),
			button('Cancel', () => {
				forget('n');
				render(true);
			}),
		);
		box.append(row);
		return box;
	}

	// -- Members: the Founder and Monsignors, then each branch by rank from 5 down to 1, then the Neophytes
	function drawMembers(/** @type {HTMLElement} */ body) {
		const s = structure();
		const on = state.members.filter((/** @type {any} */ m) => m.on).length;
		body.append(make('p', 'dim', `${plural(state.members.length, 'member')}, ${on} online. Click someone for their ID card.`));
		const byName = (/** @type {any} */ a, /** @type {any} */ b) => Number(!!b.on) - Number(!!a.on) || a.name.localeCompare(b.name);
		const all = [...state.members].sort(byName);
		const keeper = all.filter(isKeeper);
		if (keeper.length) {
			body.append(branchTitle(KEEPER));
			for (const m of keeper) {
				body.append(drawMemberRow(m, ''));
			}
		}
		const founder = all.filter((/** @type {any} */ m) => m.n === founderN() && !isKeeper(m));
		if (founder.length) {
			body.append(branchTitle(s.founder));
			for (const m of founder) {
				body.append(drawMemberRow(m, ''));
			}
		} else if (isTop(state.me)) {
			body.append(make('p', 'dim', `${s.founder.name}: not yet handed over`));
		}
		const mons = all.filter((/** @type {any} */ m) => m.mon);
		if (mons.length) {
			body.append(branchTitle(s.monsignor, 'branch', ` · ${mons.length}`));
			if (s.monsignor.about) {
				body.append(make('div', 'dim', s.monsignor.about));
			}
			for (const m of mons) {
				body.append(drawMemberRow(m, m.places.map((/** @type {any} */ p) => placeText(p, m)).join(' · ')));
			}
		}
		for (const b of s.branches) {
			const inB = all.filter((/** @type {any} */ m) => tierOf(m, b.id) > 0);
			if (!inB.length) {
				continue;
			}
			body.append(branchTitle(b, 'branch', ` · ${inB.length}`));
			if (b.about) {
				body.append(make('div', 'dim', b.about));
			}
			for (let t = TIERS; t >= 1; t--) {
				const at = inB.filter((/** @type {any} */ m) => tierOf(m, b.id) === t);
				if (!at.length) {
					continue;
				}
				body.append(make('div', 'tier', tierLabel(b.tiers[t - 1])));
				for (const m of at) {
					const p = m.places.find((/** @type {any} */ x) => x.b === b.id);
					const c = chapterName(p);
					body.append(drawMemberRow(m, `${rankName(p, m)}${c ? ` · ${c}` : ''}`));
				}
			}
		}
		const waiting = all.filter((/** @type {any} */ m) => !m.places.length && !m.mon && m.n !== founderN() && !isKeeper(m));
		if (waiting.length) {
			body.append(make('div', 'branch', `${NEOPHYTE} · ${waiting.length}`));
			for (const m of waiting) {
				body.append(drawMemberRow(m, ''));
			}
		}
	}
	function drawMemberRow(/** @type {any} */ m, /** @type {string} */ rank) {
		const row = make('div', 'member');
		row.append(make('span', `dot${m.on ? ' on' : ''}`));
		const name = make('span', 'grow');
		name.append(make('span', '', m.name), make('span', 'dim', ` #${m.n}`));
		if (rank) {
			name.append(make('span', 'dim', ` · ${rank}`));
		}
		row.append(name);
		const title = hybridTitle(m);
		if (title) {
			row.append(make('span', 'tag', title));
		}
		if (m.admin) {
			row.append(make('span', 'tag', 'Admin'));
		}
		if (m.invited) {
			row.append(make('span', 'tag', 'Invited'));
		}
		if (m.on && m.room) {
			row.append(make('span', 'tag', `📍 ${m.room}`));
		}
		row.addEventListener('click', () => guard(() => openCard(m.n), panelSay));
		return row;
	}

	// -- The Order: about, the branches and their ranks, the hybrid titles, and leaving
	function drawOrder(/** @type {HTMLElement} */ body) {
		const meta = state.meta;
		body.append(make('h3', '', 'About'), linked('p', '', meta.about || 'No about text yet.'));
		body.append(make('p', 'dim', `Founded ${date(meta.founded)}. Joining is ${meta.open ? 'open' : 'closed'}.`));
		drawStructure(body);
		if (meta.founder === state.me.n) {
			body.append(drawHandOver());
			return;
		}
		body.append(make('h3', '', 'Leave'));
		body.append(
			button(
				'Leave the Order',
				() => {
					if (confirmed('leave', 'Click again to leave. You can join again, but you will need to be placed again.')) {
						return act({ t: 'leave' });
					}
				},
				'b bad',
			),
		);
	}
	/** The branches with their ranks (5 at the top) and chapters, Monsignor, and the hybrid titles. */
	function drawStructure(/** @type {HTMLElement} */ body) {
		const s = structure();
		body.append(make('h3', '', 'The branches'));
		for (const b of s.branches) {
			body.append(branchTitle(b));
			if (b.about) {
				body.append(make('div', 'dim', b.about));
			}
			const ranks = [];
			for (let t = TIERS; t >= 1; t--) {
				ranks.push(`${t}. ${tierLabel(b.tiers[t - 1])}`);
			}
			body.append(make('div', '', ranks.join(' · ')));
			for (const c of b.chapters) {
				const own = c.tiers.map((/** @type {any} */ x, /** @type {number} */ i) => (x ? `${i + 1}. ${tierLabel(x)}` : '')).filter(Boolean);
				body.append(make('div', 'dim', `Chapter ${c.name}${own.length ? ` (its own ranks: ${own.join(', ')})` : ''}`));
			}
		}
		body.append(make('p', 'dim', `Chapters are open from rank ${CHAPTER_FROM}. Ranks ${LEADS_FROM} and ${TIERS} lead their branch.`));
		body.append(branchTitle(s.monsignor));
		if (s.monsignor.about) {
			body.append(make('div', 'dim', s.monsignor.about));
		}
		body.append(make('h3', '', 'Hybrids: members of two branches'));
		for (const [i, a] of s.branches.entries()) {
			for (const b of s.branches.slice(i + 1)) {
				const forms = s.hybrids[[a.id, b.id].sort().join('+')];
				body.append(make('div', '', `${a.name} + ${b.name}: ${forms ? tierLabel(forms) : '—'}`));
			}
		}
	}
	/** The Founder hands their place to another member (they can't leave without doing this first). */
	function drawHandOver() {
		const wrap = make('div');
		wrap.append(
			make('h3', '', 'Hand the Founder’s place over'),
			make('p', 'dim', 'There is one Founder. They can only leave after handing their place to someone else. You keep your branches.'),
		);
		const others = state.members.filter((/** @type {any} */ m) => m.n !== state.me.n && !m.invited);
		if (!others.length) {
			wrap.append(make('p', 'dim', 'There is nobody to hand it to yet.'));
			return wrap;
		}
		const sel = select(
			others.map((/** @type {any} */ m) => [String(m.n), `${m.name} #${m.n}`]),
			String(others[0].n),
			() => {},
		);
		const row = make('div', 'row');
		row.append(
			sel,
			button(
				'Hand it over',
				() => {
					const m = memberOf(Number(sel.value));
					if (m && confirmed(`founder:${m.n}`, `Click again to make ${m.name} the Founder. Only they can give it back.`)) {
						return act({ t: 'founder', member: m.n });
					}
				},
				'b bad',
			),
		);
		wrap.append(row);
		return wrap;
	}

	// -- Joining (and founding, and join or reset codes)
	function drawJoin(/** @type {HTMLElement} */ body) {
		if (!state.meta) {
			if (!state.canFound) {
				body.append(make('p', '', `The ${ORDER_NAME} has not been founded yet.`));
				return;
			}
			body.append(
				make('h3', '', 'Found the Order'),
				make(
					'p',
					'',
					'You run the app. Enter the founding code. You are its Founder until you hand that place to the Order’s own founder (under The Order); as the app admin you keep every power after.',
				),
				label('About'),
				field('f:about', '', LIMITS.about, 'textarea'),
				label('Founding code'),
				field('f:code', '', 64),
				button(
					'Found the Order',
					() =>
						act(
							{
								t: 'found',
								about: drafts['f:about'] || '',
								code: drafts['f:code'] || '',
								myName: nick(w.Player),
							},
							() => forget('f'),
						),
					'b main',
				),
			);
			return;
		}
		const meta = state.meta;
		body.append(make('h3', '', 'About'), linked('p', '', meta.about || ''));
		body.append(make('p', 'dim', `${plural(state.count, 'member')} · founded ${date(meta.founded)}`));
		if (state.members.length) {
			body.append(make('h3', '', 'Who leads'));
			for (const m of state.members) {
				const line = make('div', 'member');
				const lines = idLines(m, m.n === meta.founder).filter((l) => l.cls !== 'motto' && l.cls !== 'chapter');
				line.append(make('span', 'grow', `${m.name} #${m.n}`), make('span', 'dim', lines.map((l) => l.text).join(' · ')));
				line.addEventListener('click', () => guard(() => openCard(m.n), panelSay));
				body.append(line);
			}
		}
		if (state.status === 'mismatch' || state.status === 'invited') {
			const invited = state.status === 'invited';
			body.append(make('h3', '', invited ? 'Welcome to the Order' : 'Your key'));
			body.append(
				make(
					'p',
					'',
					invited
						? "You are already in the Order: someone from the hierarchy added you. Enter the join code they sent you (by whisper or beep) and you're in."
						: 'This member number is in the Order with a different key (another browser before the account synced, or a wiped account). Ask someone over you for a reset code and enter it here.',
				),
				label(invited ? 'Join code' : 'Reset code'),
				field('reset:code', '', 10),
				button(
					'Use the code',
					() => {
						resetCode = String(drafts['reset:code'] || '')
							.trim()
							.toUpperCase();
						forget('reset');
						panelSay('Signing in with the code…');
						reconnect();
					},
					'b main',
				),
			);
			return;
		}
		body.append(make('h3', '', 'Join'));
		if (!meta.open) {
			body.append(make('p', 'dim', 'Joining is closed right now.'));
			return;
		}
		body.append(
			make('p', '', 'Join now; an admin or a branch leader then gives you your place in a branch.'),
			button(
				'Join the Order',
				() => act({ t: 'join', name: nick(w.Player) }, () => note(`Welcome to the ${ORDER_NAME}. A branch leader will place you soon.`)),
				'b main',
			),
		);
	}

	// -- The dice roller: a small pop-up from the 🎲 in the panel's header (or /void roll): dice, modifier, Roll, history
	/** A die's outline as a small picture. */
	function dieIcon(/** @type {number} */ sides) {
		const icon = make('canvas');
		icon.width = icon.height = 52;
		const g = /** @type {CanvasRenderingContext2D} */ (icon.getContext('2d'));
		g.translate(26, 26);
		g.strokeStyle = '#c9a8ff';
		g.lineWidth = 3;
		const shape = dieShape(sides);
		traceDie(g, shape, 20);
		g.stroke();
		g.lineWidth = 1.5;
		g.globalAlpha = 0.6;
		strokeEdges(g, shape, 20);
		return icon;
	}
	/**
	 * Opens the roller by `anchor` (under it, kept on screen), or near the bottom of the screen without one; closes it
	 * when it is open.
	 */
	function toggleRoller(/** @type {HTMLElement | null} */ anchor) {
		const open = document.getElementById('void-roller');
		if (open) {
			open.remove();
			render();
			return;
		}
		style();
		const box = make('div');
		box.id = 'void-roller';
		keepKeys(box);
		document.body.append(box);
		withUs = true;
		drawRoller();
		const r = box.getBoundingClientRect();
		const a = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
		const x = a ? a.right - r.width : (innerWidth - r.width) / 2;
		const y = a ? a.bottom + 6 : innerHeight - r.height - 90;
		box.style.left = `${Math.max(6, Math.min(innerWidth - r.width - 6, x))}px`;
		box.style.top = `${Math.max(6, Math.min(innerHeight - r.height - 6, y))}px`;
		render();
	}
	/** Draws the roller's insides again (after a pick or a roll), if it is open. */
	function drawRoller(say = '') {
		const box = document.getElementById('void-roller');
		if (!box) {
			return;
		}
		const pool = /** @type {number[]} */ (drafts['d:pool'] ? JSON.parse(drafts['d:pool']) : []);
		const mod = Number(drafts['d:mod'] || 0);
		const redraw = (/** @type {string} */ text = '') => guard(() => drawRoller(text));
		box.replaceChildren();
		const top = make('div', 'top');
		const x = make('button', 'x', '✕');
		x.title = 'Close';
		x.addEventListener('click', () => toggleRoller(null));
		top.append(make('b', '', '🎲 The Void dice'), x);
		const dice = make('div', 'dice');
		for (const sides of DICE) {
			const d = make('button');
			d.title = `Add a d${sides}`;
			d.dataset.die = String(sides);
			d.append(dieIcon(sides), make('span', '', sides === 100 ? 'd%' : `d${sides}`));
			d.addEventListener('click', () => {
				if (pool.length >= LIMITS.dice) {
					return redraw(`${LIMITS.dice} dice at most.`);
				}
				drafts['d:pool'] = JSON.stringify([...pool, sides]);
				redraw();
			});
			dice.append(d);
		}
		const row = make('div', 'row');
		const setMod = (/** @type {number} */ v) => {
			drafts['d:mod'] = String(Math.max(-LIMITS.mod, Math.min(LIMITS.mod, v)));
			redraw();
		};
		const down = make('button', 'b step', '−');
		down.title = 'Modifier −1';
		down.addEventListener('click', () => setMod(mod - 1));
		const up = make('button', 'b step', '+');
		up.title = 'Modifier +1';
		up.addEventListener('click', () => setMod(mod + 1));
		const go = make('button', 'b main', 'Roll');
		go.addEventListener('click', () =>
			guard(async () => {
				if (!pool.length) {
					return redraw('Add some dice first.');
				}
				const why = await roll(pool, mod);
				drawRoller(why ? `⚠ ${why}` : w.CurrentScreen === 'ChatRoom' ? '' : 'Not in a chat room: only you saw it.');
			}),
		);
		const clear = make('button', 'b', 'Clear');
		clear.addEventListener('click', () => {
			delete drafts['d:pool'];
			delete drafts['d:mod'];
			redraw();
		});
		row.append(
			make('span', 'dim', 'Mod'),
			down,
			make('span', 'mod', mod > 0 ? `+${mod}` : String(mod)),
			up,
			make('span', 'grow'),
			clear,
			go,
		);
		box.append(top, dice, make('div', 'pool', pool.length ? diceSpec(pool, mod) : 'Pick dice'), row, make('div', 'msg', say));
		if (recentRolls.length) {
			const hist = make('div', 'hist');
			for (const r of recentRolls.slice(0, 6)) {
				hist.append(make('div', '', `${fromNow(r.at)} · ${rollText(r)}`));
			}
			box.append(hist);
		}
	}

	// -- Manage: placing members, bringing people in, and for the Founder and admins the about page and the ranks
	/** @type {Map<number, { code: string, hours: number }>} Reset and join codes made in this session, by member. */
	const resetCodes = new Map();
	/** @type {{ codes: { n: number, name: string, code: string }[], days: number } | null} The join codes just made. */
	let broughtIn = null;
	/** A member's initial in a circle, in the colour of their first branch. */
	function avatar(/** @type {any} */ m, size = 0) {
		const a = make('span', 'av');
		a.dataset.i = (String(m.name || '?').trim()[0] || '?').toUpperCase();
		const b = m.places && m.places[0] && branchOf(m.places[0].b);
		if (b && isColor(b.color)) {
			a.style.setProperty('--c', b.color);
		}
		if (size) {
			a.style.width = a.style.height = `${size}px`;
			a.style.fontSize = `${Math.round(size * 0.45)}px`;
		}
		return a;
	}
	/** A member's place as coloured pills: Keeper or Founder, Monsignor, hybrid title, each branch's rank and chapter. */
	function memberPills(/** @type {any} */ m) {
		const row = make('span', 'pills');
		const pill = (/** @type {string} */ text, /** @type {string} */ color, cls = '') => {
			const x = make('span', `pill${cls ? ` ${cls}` : ''}`, text);
			if (isColor(color)) {
				x.style.setProperty('--c', color);
			}
			row.append(x);
		};
		const s = structure();
		if (isKeeper(m)) {
			pill(`${KEEPER.sym} ${KEEPER.name}`, KEEPER.color);
		} else if (m.n === founderN()) {
			pill(`${s.founder.sym} ${s.founder.name}`, s.founder.color);
		}
		if (m.mon) {
			pill(`${s.monsignor.sym} ${s.monsignor.name}`, s.monsignor.color);
		}
		const title = hybridTitle(m);
		if (title) {
			pill(title, '', 'hybrid');
		}
		for (const p of m.places) {
			const b = branchOf(p.b);
			if (b) {
				pill(`${b.sym} ${rankName(p, m)}`, b.color);
				if (p.c) {
					pill(chapterName(p), b.color, 'soft');
				}
			}
		}
		if (m.rank) {
			pill(orderRank(m), NEOPHYTE_COLOR, 'soft');
		} else if (!m.places.length && !m.mon && m.n !== founderN() && !isKeeper(m)) {
			pill(NEOPHYTE, NEOPHYTE_COLOR);
		}
		if (m.admin) {
			pill('Admin', '', 'soft');
		}
		if (m.invited) {
			pill('Invited', '', 'soft');
		}
		return row;
	}
	/** Branches as big tiles to tap: `pick` gets the branch id ('' for the `none` tile, when given). */
	function branchTiles(/** @type {any[]} */ list, /** @type {string} */ on, /** @type {(id: string) => any} */ pick, none = '') {
		const wrap = make('div', 'tiles');
		const tile = (/** @type {string} */ id, /** @type {string} */ sym, /** @type {string} */ name, /** @type {string} */ color) => {
			const t = make('button', `tile${id === on ? ' on' : ''}`);
			t.dataset.branch = id;
			t.append(make('span', 'sym', sym), make('span', 'nm', name));
			if (isColor(color)) {
				t.style.setProperty('--c', color);
			}
			t.addEventListener('click', () => guard(() => pick(id), panelSay));
			wrap.append(t);
		};
		if (none) {
			tile('', '·', none, '');
		}
		for (const b of list) {
			tile(b.id, b.sym || '⸸', b.name, b.color);
		}
		return wrap;
	}
	/** Rank 1 to 5 in branch b as steps to tap, with − and +; only the ranks in `tiers` can be picked. */
	function rankStepper(
		/** @type {any} */ b,
		/** @type {number[]} */ tiers,
		/** @type {number} */ t,
		/** @type {any} */ m,
		/** @type {string} */ c,
		/** @type {(t: number) => any} */ change,
	) {
		const wrap = make('div', 'stepper');
		const i = tiers.indexOf(t);
		const down = button('−', () => change(tiers[i - 1]), 'b step');
		down.disabled = i <= 0;
		down.title = 'Lower rank';
		const up = button('+', () => change(tiers[i + 1]), 'b step');
		up.disabled = i < 0 || i >= tiers.length - 1;
		up.title = 'Higher rank';
		const steps = make('div', 'steps');
		for (let k = 1; k <= 5; k++) {
			const name = word(tierForms(b, k, k >= CHAPTER_FROM ? c : ''), m.form, m.el);
			const st = make('button', `st${k === t ? ' on' : ''}${k < t ? ' below' : ''}`, String(k));
			st.dataset.t = String(k);
			st.title = `${k}. ${name}`;
			st.disabled = !tiers.includes(k);
			st.addEventListener('click', () => guard(() => change(k), panelSay));
			steps.append(st);
		}
		const name = t ? word(tierForms(b, t, t >= CHAPTER_FROM ? c : ''), m.form, m.el) : '';
		wrap.append(down, steps, up, make('span', 'rank-name', name));
		return wrap;
	}
	/** Branch b's chapters as chips (from rank CHAPTER_FROM on). */
	function chapterChips(/** @type {any} */ b, /** @type {number} */ t, /** @type {string} */ c, /** @type {(c: string) => any} */ pick) {
		const wrap = make('div', 'chips');
		if (t < CHAPTER_FROM) {
			wrap.append(make('span', 'dim', `Chapters come from rank ${CHAPTER_FROM}.`));
			return wrap;
		}
		for (const [id, name] of [['', 'No chapter'], ...b.chapters.map((/** @type {any} */ x) => [x.id, x.name])]) {
			const ch = make('button', `chip${id === c ? ' on' : ''}`, name);
			ch.dataset.chapter = id;
			ch.addEventListener('click', () => guard(() => pick(id), panelSay));
			wrap.append(ch);
		}
		return wrap;
	}

	// The Admin tab's Manage: a list of the members you may manage; a click opens their sheet.
	/** The part of the Admin tab shown. */
	let adminView = 'manage';
	/** The member whose sheet is open in Manage (0: the list). */
	let sheetFor = 0;
	/** @typedef {{ places: { b: string, t: number, c: string }[], mon: boolean, rank: number }} Place what the sheet saves */
	/** @type {(Place & { n: number }) | null} Changes to the open sheet's place, not saved yet. */
	let sheetDraft = null;
	/** @type {{ n: number, undo: Record<string, any>[], until: number } | null} The last save, undone for a few seconds. */
	let lastSave = null;
	const UNDO_FOR = 8000;
	/** @type {Map<number, any>} Members' cards, for the commendations in their sheet. */
	const sheetCards = new Map();
	/** The member whose sheet shows the weapon picker. */
	let issuing = 0;
	/**
	 * The requests that take a member from one place to another: out of branches first, then into ranks, then Monsignor,
	 * then their Order rank.
	 */
	function placeSteps(/** @type {number} */ n, /** @type {Place} */ from, /** @type {Place} */ to) {
		/** @type {Record<string, any>[]} */
		const steps = [];
		for (const p of from.places) {
			if (!to.places.some((x) => x.b === p.b)) {
				steps.push({ t: 'unplace', member: n, branch: p.b });
			}
		}
		for (const p of to.places) {
			const o = from.places.find((x) => x.b === p.b);
			const c = p.t >= CHAPTER_FROM ? p.c : '';
			if (!o || o.t !== p.t || o.c !== c) {
				steps.push({ t: 'place', member: n, branch: p.b, tier: p.t, chapter: c });
			}
		}
		if (from.mon !== to.mon) {
			steps.push({ t: 'monsignor', member: n, on: to.mon });
		}
		if (from.rank !== to.rank) {
			steps.push({ t: 'rank', member: n, rank: to.rank });
		}
		return steps;
	}
	/** Runs requests in turn; stops at the first refused (its reason shows). Whether all went through. */
	async function runSteps(/** @type {Record<string, any>[]} */ steps) {
		for (const x of steps) {
			if ((await act(x)).t === 'error') {
				return false;
			}
		}
		return true;
	}
	const placeOf = (/** @type {any} */ m) => ({
		places: m.places.map((/** @type {any} */ p) => ({ b: p.b, t: p.t, c: p.c || '' })),
		mon: !!m.mon,
		rank: m.rank || 0,
	});
	/** Saves the sheet's changes to member m; for a few seconds they can be undone. */
	async function saveSheet(/** @type {any} */ m) {
		if (!sheetDraft) {
			return;
		}
		const before = placeOf(m);
		const after = { places: sheetDraft.places, mon: sheetDraft.mon, rank: sheetDraft.rank };
		const ok = await runSteps(placeSteps(m.n, before, after));
		if (!ok) {
			return;
		}
		sheetDraft = null;
		lastSave = { n: m.n, undo: placeSteps(m.n, after, before), until: Date.now() + UNDO_FOR };
		setTimeout(() => {
			if (lastSave && Date.now() >= lastSave.until) {
				lastSave = null;
				render();
			}
		}, UNDO_FOR + 50);
		render(true);
	}
	/** A titled section of a member's sheet. */
	function sheetSection(/** @type {HTMLElement} */ body, /** @type {string} */ title, cls = '') {
		const sec = make('section', `sec${cls ? ` ${cls}` : ''}`);
		sec.append(make('h3', '', title));
		body.append(sec);
		return sec;
	}
	/** One member's sheet: their ID as it will read, then only what you may do: place, roles, armory, honours, access. */
	function drawSheet(/** @type {HTMLElement} */ body, /** @type {any} */ m) {
		const me = state.me;
		if (sheetDraft && sheetDraft.n !== m.n) {
			sheetDraft = null;
		}
		const d = sheetDraft || { n: m.n, ...placeOf(m) };
		const edit = (/** @type {(x: Place & { n: number }) => void} */ f) => {
			const next = sheetDraft || { n: m.n, ...placeOf(m) };
			f(next);
			sheetDraft = placeSteps(m.n, placeOf(m), next).length ? next : null;
			render(true);
		};
		const head = make('div', 'sheet-head');
		head.append(
			button(
				'‹ Back',
				() => {
					sheetFor = 0;
					sheetDraft = null;
					issuing = 0;
					render(true);
				},
				'b back',
			),
			avatar(m, 44),
		);
		const who = make('div', 'grow');
		who.append(make('div', 'nm', m.name), make('div', 'dim', `#${m.n}${m.n === me.n ? ' · you' : ''}`));
		head.append(who);
		body.append(head);
		const preview = { ...m, places: d.places, mon: d.mon ? 1 : 0, rank: d.rank };
		const idCard = idBlock(idLines(preview, m.n === founderN()), 'idprev');
		if (sheetDraft) {
			idCard.prepend(make('div', 'dim', 'Their ID card, once saved'));
		}
		body.append(idCard);

		// Place: each branch's rank and chapter, a branch to add, Monsignor.
		const open = structure().branches.filter(
			(/** @type {any} */ b) => !d.places.some((p) => p.b === b.id) && givableTiers(me, m, b.id).length,
		);
		const mayMon = topOver(me, m);
		const anyPlace = d.places.some((p) => givableTiers(me, m, p.b).length) || open.length || mayMon;
		if (anyPlace || d.places.length) {
			const sec = sheetSection(body, 'Place');
			for (const [i, p] of d.places.entries()) {
				const b = branchOf(p.b);
				if (!b) {
					continue;
				}
				const tiers = givableTiers(me, m, b.id);
				const box = make('div', 'pl');
				box.dataset.branch = b.id;
				const top = make('div', 'row');
				top.append(branchTitle(b, 'branch sm'), make('span', 'grow'));
				if (tiers.length) {
					top.append(button('Take out', () => edit((x) => x.places.splice(i, 1)), 'b bad sm'));
				}
				box.append(top);
				if (!tiers.length) {
					box.append(make('div', 'dim', `${rankName(p, m)}${p.c ? ` · ${chapterName(p)}` : ''}: not yours to change.`));
				} else {
					box.append(
						rankStepper(b, tiers, p.t, m, p.c, (t) =>
							edit((x) => {
								x.places[i].t = t;
								if (t < CHAPTER_FROM) {
									x.places[i].c = '';
								}
							}),
						),
						chapterChips(b, p.t, p.c, (c) => edit((x) => (x.places[i].c = c))),
					);
				}
				sec.append(box);
			}
			if (d.places.length < PLACES && open.length) {
				sec.append(
					make('div', 'dim', d.places.length ? 'Add a second branch (makes a hybrid):' : 'Choose their branch:'),
					branchTiles(open, '', (id) => edit((x) => x.places.push({ b: id, t: givableTiers(me, m, id)[0], c: '' }))),
				);
			}
			const roles = make('div', 'chips');
			if (mayMon) {
				const mon = structure().monsignor;
				const t = make('button', `chip toggle${d.mon ? ' on' : ''}`, `${mon.sym} ${mon.name}`);
				t.dataset.toggle = 'monsignor';
				t.addEventListener('click', () => edit((x) => (x.mon = !x.mon)));
				roles.append(t);
			}
			roles.append(
				make('span', 'dim', `Rank names in the ${{ f: 'feminine', m: 'masculine' }[m.form] || 'neutral'} form (their own choice).`),
			);
			sec.append(roles);
			const ranks = structure().ranks;
			if (mayMon && Array.isArray(ranks) && m.n !== founderN()) {
				const wrap = make('div', 'chips');
				wrap.append(make('span', 'dim', 'Order rank:'));
				ranks.forEach((/** @type {string} */ name, /** @type {number} */ i) => {
					const ch = make('button', `chip${i === d.rank ? ' on' : ''}`, name);
					ch.dataset.rank = String(i);
					ch.addEventListener('click', () => edit((x) => (x.rank = i)));
					wrap.append(ch);
				});
				sec.append(wrap);
			}
			if (sheetDraft) {
				const row = make('div', 'row save');
				row.append(
					button('Save', () => saveSheet(m), 'b main'),
					button('Discard', () => {
						sheetDraft = null;
						render(true);
					}),
				);
				sec.append(row);
			} else if (lastSave && lastSave.n === m.n && Date.now() < lastSave.until) {
				const row = make('div', 'row save');
				const undo = lastSave.undo;
				row.append(
					make('span', 'dim', 'Saved.'),
					button('Undo', async () => {
						lastSave = null;
						await runSteps(undo);
						render(true);
					}),
				);
				sec.append(row);
			}
		}

		// Roles: admin and a personal badge.
		const mayAdmin = (me.n === founderN() || me.n === state.appAdmin) && m.n !== state.appAdmin && m.n !== founderN() && !m.invited;
		if (mayAdmin || topOver(me, m)) {
			const sec = sheetSection(body, 'Roles');
			const chips = make('div', 'chips');
			if (mayAdmin) {
				const t = make('button', `chip toggle${m.admin ? ' on' : ''}`, 'Admin: every power');
				t.dataset.toggle = 'admin';
				t.addEventListener('click', () => guard(() => act({ t: 'admin', member: m.n, on: !m.admin }), panelSay));
				chips.append(t);
			}
			sec.append(chips);
			if (topOver(me, m)) {
				loadBadges();
				if (badges && badges.length) {
					const pick = make('div', 'chips');
					for (const [id, name] of [['', 'No badge'], ...badges.map((b) => [b.id, b.name])]) {
						const ch = make('button', `chip${(m.badge || '') === id ? ' on' : ''}`, name);
						ch.dataset.badge = id;
						ch.addEventListener('click', () => guard(() => act({ t: 'badge', member: m.n, badge: id }), panelSay));
						pick.append(ch);
					}
					sec.append(make('div', 'dim', 'Personal badge on their card:'), pick);
				}
			}
		}

		if (topOver(me, m) || m.places.some((/** @type {any} */ p) => leaderOver(me, m, p.b))) {
			sheetArmory(sheetSection(body, 'Armory'), m);
		}
		if (mayCommend(me, m)) {
			sheetHonours(sheetSection(body, 'Honours'), m);
		}
		if (mayReset(me, m)) {
			const sec = sheetSection(body, 'Access');
			const reset = resetCodes.get(m.n);
			if (reset) {
				const row = make('div', 'row');
				row.append(
					make('span', 'code', reset.code),
					button('Copy', () => navigator.clipboard?.writeText(reset.code)),
				);
				sec.append(
					make('div', 'dim', `${m.invited ? 'Join' : 'Reset'} code, valid ${spellHours(reset.hours)}. They open /void and enter it.`),
					row,
				);
			} else {
				sec.append(
					make(
						'div',
						'dim',
						m.invited ? 'They haven’t joined with their code yet.' : 'A reset code lets them sign in again on a new device.',
					),
				);
			}
			sec.append(
				button(m.invited ? 'New join code' : 'Reset code', () =>
					act({ t: 'reset', member: m.n }, (r) => {
						resetCodes.set(m.n, { code: r.code, hours: r.hours });
						render(true);
					}),
				),
			);
		}
		if (mayRemove(me, m)) {
			const sec = sheetSection(body, 'Danger zone', 'danger');
			sec.append(
				button(
					'Remove from the Order',
					() => {
						if (confirmed(`kick:${m.n}`, `Click "Remove from the Order" again to take ${m.name} out of the Order.`)) {
							return act({ t: 'kick', member: m.n }, () => {
								sheetFor = 0;
								render(true);
							});
						}
					},
					'b bad',
				),
			);
		}
	}
	/** A sheet's Armory: their weapons as tiles, and Issue, which opens a picker of the rest by kind. */
	function sheetArmory(/** @type {HTMLElement} */ sec, /** @type {any} */ m) {
		if (!catalog && catalogFailed) {
			return catalogDown(sec);
		}
		if (!catalog) {
			sec.append(make('div', 'dim', 'Opening the Armory…'));
			guard(loadCatalog, panelSay);
			return;
		}
		const has = armsOf(m);
		const tiles = make('div', 'wtiles');
		if (m.n === state.appAdmin) {
			sec.append(make('div', 'dim', 'Every weapon (early access).'));
		} else {
			for (const x of has) {
				const t = make('div', 'wtile');
				t.dataset.id = String(x.id);
				t.style.setProperty('--c', RARITY[x.rarity] || '#c9c4d8');
				const off = button('✕', () => act({ t: 'issue', member: m.n, weapon: x.id, on: false }), 'off');
				off.title = `Take back ${x.name}`;
				t.append(sprite(x, 48), make('span', 'nm', x.name), off);
				tiles.append(t);
			}
			if (!has.length) {
				sec.append(make('div', 'dim', 'No weapons yet.'));
			}
			sec.append(tiles);
		}
		const others = catalog.filter((x) => !has.includes(x));
		if (!others.length || m.n === state.appAdmin) {
			return;
		}
		if (issuing !== m.n) {
			sec.append(
				button('＋ Issue a weapon', () => {
					issuing = m.n;
					render(true);
				}),
			);
			return;
		}
		const pick = make('div', 'picker');
		pick.dataset.keep = 'picker';
		const row = make('div', 'row');
		const q = field('iss:q', '', 40);
		q.placeholder = 'Find a weapon';
		q.classList.add('grow');
		q.style.width = 'auto';
		q.addEventListener('input', () => render(true));
		row.append(
			q,
			button('Done', () => {
				issuing = 0;
				forget('iss');
				render(true);
			}),
		);
		pick.append(row);
		const text = String(drafts['iss:q'] || '').toLowerCase();
		const shown = others.filter((x) => !text || x.name.toLowerCase().includes(text) || kindOf(x).toLowerCase().includes(text));
		for (const k of [...new Set(shown.map(kindOf))]) {
			pick.append(make('div', 'kind', k));
			const grid = make('div', 'wtiles');
			for (const x of shown.filter((y) => kindOf(y) === k)) {
				const t = make('button', 'wtile pickable');
				t.dataset.id = String(x.id);
				t.title = `${x.name} (${x.rarity})${statsLine(x) ? `\n${statsLine(x)}` : ''}`;
				t.style.setProperty('--c', RARITY[x.rarity] || '#c9c4d8');
				t.append(sprite(x, 40), make('span', 'nm', x.name));
				t.addEventListener('click', () =>
					guard(() => act({ t: 'issue', member: m.n, weapon: x.id }, () => panelSay(`Issued ${x.name} to ${m.name}.`)), panelSay),
				);
				grid.append(t);
			}
			pick.append(grid);
		}
		if (!shown.length) {
			pick.append(make('div', 'dim', 'No weapon matches.'));
		}
		sec.append(pick);
	}
	/** A sheet's Honours: their commendations (from their card), each taken back where you may, and Commend. */
	function sheetHonours(/** @type {HTMLElement} */ sec, /** @type {any} */ m) {
		const card = sheetCards.get(m.n);
		if (card === undefined) {
			sheetCards.set(m.n, null);
			guard(async () => {
				const r = await req({ t: 'card', member: m.n });
				sheetCards.set(m.n, r.t === 'card' && r.card ? r.card : { medals: [] });
				render();
			});
		}
		const medals = (card && card.medals) || [];
		if (!card) {
			sec.append(make('div', 'dim', 'Looking up their commendations…'));
		} else if (!medals.length) {
			sec.append(make('div', 'dim', 'No commendations yet.'));
		}
		for (const md of medals) {
			const line = make('div', 'commend');
			const text = make('div', 'grow');
			text.append(
				make('b', '', md.name),
				linked('span', '', md.reason ? ` · ${md.reason}` : ''),
				make('div', 'dim', `from ${md.byName}, ${date(md.at)}`),
			);
			line.append(medalSvg(md.icon, 26), text);
			if (md.by === state.me.n || topOver(state.me, m)) {
				line.append(
					button('Take back', () =>
						act({ t: 'unaward', member: m.n, id: md.id }, () => {
							sheetCards.delete(m.n);
							render(true);
						}),
					),
				);
			}
			sec.append(line);
		}
		sec.append(drawCommend(m));
	}
	/** Commending a member: a button that opens the form (a picture, a name and a reason). */
	function drawCommend(/** @type {any} */ m) {
		const k = `md:${m.n}`;
		const wrap = make('div');
		if (!drafts[`${k}:open`]) {
			const open = button('🎖 Commend', () => {
				drafts[`${k}:open`] = '1';
				render(true);
			});
			open.style.marginTop = '6px';
			wrap.append(open);
			return wrap;
		}
		const icon = drafts[`${k}:icon`] || MEDAL_KEYS[0];
		const pick = make('div', 'medal-pick');
		for (const id of MEDAL_KEYS) {
			const b = make('button', id === icon ? 'on' : '');
			b.title = MEDAL_ICONS[id].name;
			b.dataset.icon = id;
			b.append(medalSvg(id, 30));
			b.addEventListener('click', () => {
				drafts[`${k}:icon`] = id;
				render(true);
			});
			pick.append(b);
		}
		const name = field(`${k}:name`, '', LIMITS.medalName);
		name.placeholder = 'Name, e.g. Shield of the Void';
		const reason = field(`${k}:reason`, '', LIMITS.medalReason);
		reason.placeholder = 'Why (optional)';
		const row = make('div', 'row');
		row.append(
			button(
				'Award',
				() =>
					act({ t: 'award', member: m.n, icon, name: drafts[`${k}:name`] || '', reason: drafts[`${k}:reason`] || '' }, () => {
						forget(k);
						sheetCards.delete(m.n);
						panelSay(`Commended ${m.name}.`);
						render(true);
					}),
				'b main',
			),
			button('Cancel', () => {
				forget(k);
				render(true);
			}),
		);
		wrap.append(label(`Commend ${m.name}`), pick, name, reason, row);
		return wrap;
	}
	/** The Admin tab: its parts as chips on top (Manage, Bring in, the about page, recent changes, reports). */
	function drawAdmin(/** @type {HTMLElement} */ body) {
		const views = adminViews();
		if (!views.some(([id]) => id === adminView)) {
			adminView = views[0][0];
		}
		const sheet = adminView === 'manage' && sheetFor ? memberOf(sheetFor) : null;
		if (!sheet) {
			sheetFor = 0;
			const sub = make('div', 'chips subnav');
			for (const [id, label] of views) {
				const b = make('button', `chip${id === adminView ? ' on' : ''}`, label);
				const count = id === 'manage' ? unplacedFor().length : 0;
				if (count) {
					b.append(make('span', 'badge', String(count)));
				}
				b.addEventListener('click', () => {
					adminView = id;
					lastMsg = '';
					render(true);
				});
				sub.append(b);
			}
			body.append(sub);
		}
		if (sheet) {
			drawSheet(body, sheet);
		} else if (adminView === 'manage') {
			drawManage(body);
		} else if (adminView === 'bring') {
			body.append(drawBringIn());
		} else if (adminView === 'about') {
			drawAboutAdmin(body);
		} else if (adminView === 'log') {
			drawLog(body);
		} else {
			moduleTabs.find((x) => x.id === adminView)?.draw(body);
		}
	}
	/** Manage: the members you may manage, one row each, Neophytes first; a search and filter chips on top. */
	function drawManage(/** @type {HTMLElement} */ body) {
		const me = state.me;
		const top = isTop(me);
		const waiting = unplacedFor();
		const mine = state.members
			.filter(
				(/** @type {any} */ m) =>
					!waiting.includes(m) &&
					(topOver(me, m) || m.places.some((/** @type {any} */ p) => leaderOver(me, m, p.b))) &&
					(m.places.length || m.mon || m.n === me.n),
			)
			.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
		const filter = field('m:filter', '', 40);
		filter.placeholder = 'Find a member by name or number';
		filter.addEventListener('input', () => render(true));
		body.append(filter);
		const show = drafts['m:show'] || 'all';
		const chips = make('div', 'chips');
		const chip = (/** @type {string} */ id, /** @type {string} */ text, /** @type {string} */ color = '') => {
			const c = make('button', `chip${id === show ? ' on' : ''}`, text);
			c.dataset.show = id;
			if (isColor(color)) {
				c.style.setProperty('--c', color);
			}
			c.addEventListener('click', () => {
				drafts['m:show'] = id;
				render(true);
			});
			chips.append(c);
		};
		chip('all', 'All');
		chip('neo', `${NEOPHYTE}s · ${waiting.length}`, NEOPHYTE_COLOR);
		for (const b of top ? structure().branches : ledBy(me)) {
			chip(b.id, `${b.sym} ${b.name}`, b.color);
		}
		body.append(chips);
		const q = String(drafts['m:filter'] || '').toLowerCase();
		const shown = (/** @type {any} */ m) =>
			(!q || m.name.toLowerCase().includes(q) || String(m.n).includes(q)) &&
			(show === 'all' || show === 'neo' || m.places.some((/** @type {any} */ p) => p.b === show));
		const row = (/** @type {any} */ m) => {
			const r = make('button', 'mrow');
			r.dataset.n = String(m.n);
			const who = make('span', 'who');
			who.append(make('span', 'nm', m.name), make('span', 'num', ` #${m.n}${m.n === me.n ? ' (you)' : ''}`));
			r.append(avatar(m), who, memberPills(m), make('span', 'go', '›'));
			r.addEventListener('click', () => {
				sheetFor = m.n;
				sheetDraft = null;
				issuing = 0;
				lastMsg = '';
				render(true);
			});
			return r;
		};
		const list = make('div', 'mlist');
		const neo = show === 'all' || show === 'neo' ? waiting.filter(shown) : [];
		if (show === 'all' || show === 'neo') {
			list.append(make('h3', '', `${NEOPHYTE}s (not yet in a branch) · ${neo.length}`));
			if (!neo.length) {
				list.append(make('p', 'dim', `No ${NEOPHYTE}s waiting for a branch.`));
			}
			for (const m of neo) {
				list.append(row(m));
			}
		}
		if (show !== 'neo') {
			const rest = mine.filter(shown);
			list.append(make('h3', '', top ? 'Members' : 'Members of your branch below you'));
			if (!rest.length) {
				list.append(make('p', 'dim', 'Nobody here.'));
			}
			for (const m of rest) {
				list.append(row(m));
			}
		}
		body.append(list);
	}
	/** The about page and whether joining is open (the Founder and admins). */
	function drawAboutAdmin(/** @type {HTMLElement} */ body) {
		const meta = state.meta;
		const isOpen = 'a:open' in drafts ? drafts['a:open'] === '1' : meta.open;
		const box = make('div', 'box form');
		const toggle = make('button', `chip toggle${isOpen ? ' on' : ''}`, isOpen ? 'Joining is open' : 'Joining is closed');
		toggle.dataset.toggle = 'open';
		toggle.addEventListener('click', () => {
			drafts['a:open'] = isOpen ? '0' : '1';
			render(true);
		});
		box.append(
			label('What everyone reads on The Order tab'),
			field('a:about', meta.about, LIMITS.about, 'textarea'),
			make('div', 'dim', 'Open: anyone running the add-on can join, as a Neophyte. Closed: only with a join code.'),
			toggle,
		);
		const row = make('div', 'row save');
		row.append(
			button(
				'Save the about page',
				() =>
					act({ t: 'about', about: drafts['a:about'] ?? meta.about, open: isOpen }, () => {
						forget('a');
						panelSay('Saved.');
					}),
				'b main',
			),
		);
		box.append(row);
		body.append(box);
	}
	/** The hierarchy's recent changes, newest first. */
	function drawLog(/** @type {HTMLElement} */ body) {
		const log = state.log || [];
		if (!log.length) {
			body.append(make('p', 'dim', 'Nothing changed yet.'));
		}
		const list = make('div', 'log');
		for (const l of [...log].reverse()) {
			const line = make('div', 'logline');
			line.append(make('span', 'when', dateTime(l.at)), make('span', '', l.text));
			list.append(line);
		}
		body.append(list);
	}
	/**
	 * Bringing in members the Order had before the add-on: one per line, "member number, name", all at one place. Each
	 * gets a join code to send them.
	 */
	function drawBringIn() {
		const me = state.me;
		const top = isTop(me);
		const wrap = make('div', 'box form');
		wrap.append(
			make(
				'p',
				'dim',
				'For members the Order had before the add-on, placed at once. Each gets a join code; send it to them by whisper or beep, and they enter it under /void.',
			),
		);
		const list = field('in:list', '', 4000, 'textarea');
		list.placeholder = '123456, Kikuri\n234567, Summer';
		const branches = top ? structure().branches : ledBy(me);
		const bId = drafts['in:b'] ?? (top ? '' : branches[0].id);
		const b = branchOf(bId);
		const tiers = b ? (top ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5].filter((t) => t < tierOf(me, b.id))) : [];
		const t = tiers.includes(Number(drafts['in:t'])) ? Number(drafts['in:t']) : tiers[0] || 0;
		const c = b && t >= CHAPTER_FROM ? drafts['in:c'] || '' : '';
		const since = field('in:since', '', 10);
		since.type = 'date';
		since.classList.add('auto');
		wrap.append(
			label('People: one per line, member number, name'),
			list,
			label('Their branch'),
			branchTiles(
				branches,
				bId,
				(v) => {
					drafts['in:b'] = v;
					render(true);
				},
				top ? 'No branch yet' : '',
			),
		);
		if (b) {
			const nobody = { form: 'n', el: '' };
			wrap.append(
				label('Rank'),
				rankStepper(b, tiers, t, nobody, c, (v) => {
					drafts['in:t'] = String(v);
					render(true);
				}),
				chapterChips(b, t, c, (v) => {
					drafts['in:c'] = v;
					render(true);
				}),
			);
		}
		if (top) {
			const mon = structure().monsignor;
			const on = drafts['in:mon'] === '1';
			const tg = make('button', `chip toggle${on ? ' on' : ''}`, `${mon.sym} ${mon.name}s`);
			tg.dataset.toggle = 'monsignor';
			tg.addEventListener('click', () => {
				drafts['in:mon'] = on ? '0' : '1';
				render(true);
			});
			const roles = make('div', 'chips');
			roles.append(tg);
			wrap.append(roles);
		}
		wrap.append(label('In the Order since (optional, the same for all of them)'), since);
		const row = make('div', 'row save');
		row.append(
			button(
				'Bring them in',
				() => {
					/** @type {{ member: number, name: string }[]} */
					const people = [];
					const lines = String(drafts['in:list'] || '')
						.split('\n')
						.map((l) => l.trim())
						.filter(Boolean);
					for (const [i, text] of lines.entries()) {
						const [num, ...name] = text.split(/\s*[,\t]\s*/);
						const member = Number(String(num).replace(/^#/, ''));
						if (!Number.isInteger(member) || member <= 0 || !name.join(', ')) {
							panelSay(`⚠ Line ${i + 1} needs a member number and a name: "${text}"`);
							return;
						}
						people.push({ member, name: name.join(', ') });
					}
					if (!people.length) {
						panelSay('⚠ Add at least one person.');
						return;
					}
					const day = drafts['in:since'] ? new Date(drafts['in:since']).getTime() : 0;
					return act(
						{
							t: 'add',
							people,
							...(b ? { branch: b.id, tier: t, chapter: c } : {}),
							mon: drafts['in:mon'] === '1',
							...(day ? { since: day } : {}),
						},
						(r) => {
							broughtIn = { codes: r.codes, days: r.days };
							forget('in');
							render(true);
						},
					);
				},
				'b main',
			),
		);
		wrap.append(row);
		if (broughtIn) {
			wrap.append(make('p', 'dim', `Join codes, valid ${plural(broughtIn.days, 'day')}. Send each person theirs:`));
			for (const x of broughtIn.codes) {
				const line = make('div', 'row');
				line.append(make('span', 'grow', `${x.name} #${x.n}`), make('span', 'code', x.code));
				wrap.append(line);
			}
		}
		return wrap;
	}
	// -- My card
	/** Whether you have a picture on your card (null until your card came). */
	let hasPic = /** @type {boolean | null} */ (null);
	let picAsked = false;
	function drawMe(/** @type {HTMLElement} */ body) {
		if (state && state.me) {
			setPref('medalsSeen', state.me.medalCount || 0);
		}
		const me = state.me;
		body.append(make('h3', '', 'Your ID card'));
		const row = make('div', 'row');
		row.append(
			button('Preview my card', () => openCard(me.n)),
			button('Show my ID in this room', () => {
				const why = showMyIdInRoom();
				panelSay(why || 'Shown. Everyone sees the emote; Void Order users get your card.');
			}),
		);
		body.append(row);
		// The form of your rank names, shown with your own ranks.
		const sample = me.places[0] ? (/** @type {string} */ f) => ` (${rankName(me.places[0], { ...me, form: f })})` : () => '';
		body.append(
			label('Your rank names'),
			select(
				Object.entries(FORM_NAME).map(([f, name]) => [f, `${name}${sample(f)}`]),
				me.form,
				(form) => act({ t: 'profile', form }, () => panelSay('Saved.')),
			),
		);
		const needsElement = me.places.some((/** @type {any} */ p) => {
			const b = branchOf(p.b);
			return b && /\*/.test(Object.values(tierForms(b, p.t, p.c)).join(''));
		});
		const elements = [...new Set(structure().branches.flatMap((/** @type {any} */ b) => b.elements))];
		if (needsElement && elements.length) {
			body.append(
				label('Your element'),
				select([['', 'None yet'], ...elements.map((/** @type {string} */ e) => [e, e])], me.el, (el) =>
					act({ t: 'profile', el }, () => panelSay('Saved.')),
				),
			);
		}
		body.append(label(`Bio (up to ${LIMITS.bio} characters)`), field('bio', me.bio, LIMITS.bio, 'textarea'));
		body.append(
			button(
				'Save bio',
				() =>
					act({ t: 'profile', bio: drafts.bio ?? me.bio }, () => {
						delete drafts.bio;
						panelSay('Bio saved.');
					}),
				'b main',
			),
		);
		body.append(label('Picture'));
		const file = make('input');
		file.type = 'file';
		file.accept = 'image/*';
		file.addEventListener('change', () =>
			guard(async () => {
				const f = file.files && file.files[0];
				if (!f) {
					return;
				}
				const pic = await shrink(f);
				await act({ t: 'profile', pic }, () => {
					hasPic = true;
					panelSay('Picture saved.');
				});
			}, panelSay),
		);
		const picRow = make('div', 'row');
		picRow.append(file);
		if (hasPic === null && !picAsked) {
			// Whether you have a picture comes with your card.
			picAsked = true;
			req({ t: 'card', member: me.n }).then((r) => {
				hasPic = !!(r && r.card && r.card.pic);
				render();
			});
		}
		if (hasPic) {
			picRow.append(
				button(
					'Remove picture',
					() =>
						act({ t: 'profile', pic: '' }, () => {
							hasPic = false;
							panelSay('Picture removed.');
						}),
					'b bad',
				),
			);
		}
		body.append(picRow);

		if (slimeBeep()) {
			body.append(
				make('h3', '', 'SlimeBeep'),
				button('Join the Order chat in SlimeBeep', async () => panelSay((await joinChat()).text)),
			);
		}
	}
	/**
	 * A picture file as a small square data URL that fits LIMITS.pic.
	 * @param {Blob} f
	 * @returns {Promise<string>}
	 */
	async function shrink(f) {
		const img = await createImageBitmap(f);
		for (const size of [160, 128, 96, 72]) {
			const c = document.createElement('canvas');
			c.width = c.height = size;
			const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
			const s = Math.min(img.width, img.height);
			g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
			for (const q of [0.85, 0.7, 0.55, 0.4]) {
				for (const type of ['image/webp', 'image/jpeg']) {
					const url = c.toDataURL(type, q);
					if (url.startsWith(`data:${type}`) && url.length <= LIMITS.pic) {
						return url;
					}
				}
			}
		}
		throw new Error('that picture is too detailed to fit, try another');
	}

	// ---- The side tab, the room, and the clock
	// ---- The Void bubble: a round button over the game (on every screen but the login one) that opens and closes the
	// panel. It is dragged anywhere and kept on screen; where it was left is kept in this browser. It starts on the right,
	// above SlimeBeep's slime, and never on top of it.
	/** Problem reports that came in while you (the app admin) weren't looking at them. */
	let unseenReports = 0;
	const between = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));
	/** Commendations you haven't seen on your card yet (none the first time: those were there before the bubble). */
	function newMedals() {
		const count = (state && state.me && state.me.medalCount) || 0;
		const seen = pref('medalsSeen', null);
		if (seen === null && state && state.me) {
			setPref('medalsSeen', count);
			return 0;
		}
		return Math.max(0, count - (seen || 0));
	}
	/** What the bubble's badge counts: orders waiting for you, new problem reports and new commendations. */
	const bubbleCount = () => (isMember() ? openOrders() + newMedals() : 0) + unseenReports;
	function drawBubble() {
		const want = !!w.Player && !!w.Player.MemberNumber && opts.bubble && !!w.CurrentScreen && w.CurrentScreen !== 'Login';
		let b = document.getElementById('void-bubble');
		if (!want) {
			b?.remove();
			return;
		}
		if (!b) {
			style();
			b = make('button');
			b.id = 'void-bubble';
			b.title = 'Oculus Nihili (drag to move)';
			const eye = eyeCanvas();
			eye.className = 'eye';
			b.append(eye);
			wireBubble(b);
			document.body.append(b);
			loadedNote();
		}
		b.classList.toggle('small', opts.bubbleSize === 'small');
		const n = bubbleCount();
		let badge = b.querySelector('.badge');
		if (n && !badge) {
			badge = make('span', 'badge');
			b.append(badge);
		}
		if (badge) {
			if (n) {
				badge.textContent = n > 99 ? '99+' : String(n);
			} else {
				badge.remove();
			}
		}
		placeBubble();
	}
	/** Puts the bubble where it was left, inside the window; the first time on the right, clear of SlimeBeep's slime. */
	function placeBubble() {
		const b = document.getElementById('void-bubble');
		if (!b) {
			return;
		}
		const size = b.offsetWidth || 52;
		const pos = pref('bubble', null);
		let x = innerWidth - size - 14;
		let y = innerHeight - size - 84;
		if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
			x = pos.x * innerWidth;
			y = pos.y * innerHeight;
		} else {
			const slime = document.getElementById('sb-toggle')?.getBoundingClientRect();
			for (let i = 0; i < 8 && slime && slime.width; i++) {
				const clear = x + size <= slime.left || x >= slime.right || y + size <= slime.top || y >= slime.bottom;
				if (clear) {
					break;
				}
				y = slime.top - size - 10;
			}
		}
		b.style.left = `${between(x, 0, innerWidth - size)}px`;
		b.style.top = `${between(y, 0, innerHeight - size)}px`;
	}
	/** A click opens or closes the panel; a drag (by mouse, pen or touch) moves the bubble, and doesn't open it. */
	function wireBubble(/** @type {HTMLElement} */ b) {
		/** @type {{ dx: number, dy: number, x0: number, y0: number, moved: boolean } | null} */
		let drag = null;
		b.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) {
				return;
			}
			const r = b.getBoundingClientRect();
			drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
			try {
				b.setPointerCapture(e.pointerId);
			} catch (err) {
				/* works without capture */
			}
		});
		b.addEventListener('pointermove', (e) => {
			if (!drag) {
				return;
			}
			const x = between(e.clientX, 0, innerWidth);
			const y = between(e.clientY, 0, innerHeight);
			if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 8) {
				return;
			}
			drag.moved = true;
			b.classList.add('dragging');
			const size = b.offsetWidth || 52;
			setPref('bubble', {
				x: between(x - drag.dx, 0, innerWidth - size) / innerWidth,
				y: between(y - drag.dy, 0, innerHeight - size) / innerHeight,
			});
			placeBubble();
		});
		const end = (/** @type {boolean} */ click) => {
			if (!drag) {
				return;
			}
			const moved = drag.moved;
			drag = null;
			b.classList.remove('dragging');
			if (click && !moved) {
				guard(() => (document.getElementById('void-panel') ? closePanel() : openPanel()));
			}
		};
		b.addEventListener('pointerup', () => end(true));
		b.addEventListener('pointercancel', () => end(false));
		b.addEventListener('lostpointercapture', () => end(false));
	}
	addEventListener('resize', placeBubble);
	function drawTab() {
		drawBubble();
		const want =
			!!w.Player && !!w.Player.MemberNumber && opts.sideTab && !document.getElementById('void-panel') && w.CurrentScreen === 'ChatRoom';
		let t = document.getElementById('void-tab');
		if (!want) {
			t?.remove();
			return;
		}
		if (!t) {
			style();
			t = make('button', '', '⸸');
			t.id = 'void-tab';
			t.title = 'Oculus Nihili (/void; drag to move it)';
			wireTab(t);
			document.body.append(t);
		}
		placeTab();
		t.classList.toggle('right', opts.tabSide === 'right');
		const n = openOrders();
		t.textContent = n ? `⸸${n}` : '⸸';
	}
	/** Tells the server when your public room changes. */
	function roomTick(force = false) {
		const room = publicRoom();
		if ((room !== toldRoom || force) && ws && ws.readyState === 1 && state) {
			toldRoom = room;
			ws.send(JSON.stringify({ t: 'room', room }));
		}
	}
	function tick() {
		guard(() => {
			if (!w.Player || !w.Player.MemberNumber) {
				return;
			}
			// Another account logged in: sign in again as them.
			if (signedAs && signedAs !== w.Player.MemberNumber) {
				key = null;
				resetCode = '';
				closePanel();
				reconnect();
				return;
			}
			if (!ws) {
				connect();
			}
			roomTick();
			remindTick();
			chatTick();
			hereTick();
			drawTab();
		});
	}

	/** /void, /void card <member number>, /void id, /void roll <dice> */
	function command(/** @type {string} */ text) {
		const [sub, ...rest] = String(text || '')
			.trim()
			.split(/\s+/);
		const arg = rest.join('');
		if (sub === 'card') {
			const n = Number(arg);
			if (!Number.isInteger(n) || n <= 0) {
				note('Use /void card <member number>.');
				return;
			}
			openCard(n, note);
			return;
		}
		if (sub === 'diag') {
			diag();
			return;
		}
		if (sub === 'id') {
			const why = showMyIdInRoom();
			if (why) {
				note(why);
			}
			return;
		}
		if (sub === 'roll') {
			if (!arg) {
				if (!document.getElementById('void-roller')) {
					toggleRoller(null);
				}
				return;
			}
			const r = parseDice(arg);
			if (!r.dice) {
				note(r.why || '');
				return;
			}
			guard(async () => {
				const why = await roll(r.dice || [], r.mod || 0);
				if (why) {
					note(why);
				}
			});
			return;
		}
		openPanel();
	}

	// ---- Modules: the add-on's other parts (src/<name>.js next to assets/), loaded in order as the page starts.
	/** The modules' folder (a test page sets VoidOrderSrc). */
	const SRC = w.VoidOrderSrc || ASSETS.replace(/assets\/?$/, 'src/');
	const MODULES = ['guard', 'reports', 'items', 'overflow', 'actions'];
	/** Problems hit before the reporter is in: [feature, error, when], sent on to it once it loads. */
	const early = /** @type {[string, any, number][]} */ ([]);
	/** @type {((t: any) => void)[]} */
	const serverListeners = [];
	/** @type {{ id: string, label: string, admin?: boolean, show: () => boolean, draw: (body: HTMLElement) => void }[]} A tab with `admin` sits under the Admin tab. */
	const moduleTabs = [];
	/** @type {((body: HTMLElement) => void)[]} */
	const moduleSettings = [];
	/** f(), or `dflt` if it throws. */
	const guarded = (/** @type {() => any} */ f, /** @type {any} */ dflt) => {
		try {
			return f();
		} catch (e) {
			return dflt;
		}
	};
	/** @type {(() => void)[]} */
	const signInListeners = [];
	let signedIn = false;
	/**
	 * What every module is given. `report(feature, error)` notes a feature that failed: until src/reports.js loads it
	 * queues them (reports.js takes over the queue), then it is reports.js's own.
	 */
	const ctx = {
		w,
		VERSION,
		base: ASSETS.replace(/assets\/?$/, ''),
		src: SRC,
		assets: ASSETS,
		guard,
		toast,
		note,
		escapeHtml,
		req,
		pref,
		setPref,
		openPanel: (/** @type {string | undefined} */ which) => openPanel(which),
		render: (force = false) => render(force),
		state: () => state,
		me: () => (w.Player && w.Player.MemberNumber) || null,
		isMember,
		appAdmin: () => !!state && !!w.Player && state.appAdmin === w.Player.MemberNumber,
		/** Calls f once signed in to the Order's server (at once if already). */
		onSignIn: (/** @type {() => void} */ f) => (signedIn ? guard(f) : signInListeners.push(f)),
		/** Calls f with every message from the server. */
		onServer: (/** @type {(x: any) => void} */ f) => serverListeners.push(f),
		/** A panel tab from a module: { id, label, show() (whether you have it), draw(body) }. */
		addTab: (/** @type {(typeof moduleTabs)[number]} */ t) => moduleTabs.push(t),
		/** A section a module adds at the end of ⚙ Settings: f(body). */
		addSettings: (/** @type {(body: HTMLElement) => void} */ f) => moduleSettings.push(f),
		make,
		style,
		/** Rolls Void dice everyone in the room sees: (dice sides, modifier) → '' or why it didn't. */
		roll: (/** @type {number[]} */ dice, /** @type {number} */ mod) => roll(dice, mod),
		/** The same, answering { why, roll } with the roll itself (its total) when it went through. */
		rollFull: async (/** @type {number[]} */ dice, /** @type {number} */ mod) => {
			const why = await roll(dice, mod);
			return { why, roll: why ? null : recentRolls[0] || null };
		},
		early,
		report: (/** @type {string} */ feature, /** @type {any} */ error) => {
			console.warn(`[Oculus Nihili] ${feature}:`, error);
			if (early.length < 30) {
				early.push([String(feature), error, Date.now()]);
			}
		},
		/** @type {Record<string, any>} */
		modules: {},
	};
	/** Loads one module by a script tag (so its errors name its file) and resolves with its factory, or null. */
	function loadModule(/** @type {string} */ name) {
		return new Promise((resolve) => {
			const slots = (w.VoidOrderModules = w.VoidOrderModules || {});
			if (typeof slots[name] === 'function') {
				resolve(slots[name]);
				return;
			}
			const s = document.createElement('script');
			s.src = `${SRC}${name}.js?v=${encodeURIComponent(VERSION)}`;
			s.onload = () => resolve(typeof slots[name] === 'function' ? slots[name] : null);
			s.onerror = () => resolve(null);
			document.head.append(s);
		});
	}
	/** Loads the modules in order; one that fails to load or throws is null in ctx.modules and is reported. */
	async function loadModules() {
		for (const name of MODULES) {
			let api = null;
			try {
				const make = await loadModule(name);
				if (!make) {
					throw new Error(`src/${name}.js did not load`);
				}
				api = (await make(ctx)) || null;
			} catch (e) {
				ctx.report(`Module ${name}`, e);
			}
			ctx.modules[name] = api;
		}
		if (!ctx.modules.reports && early.length) {
			toast('Oculus Nihili: some features are switched off after a game change. Reload to try again.');
		}
	}
	problem = (feature, e) => ctx.report(feature, e);
	/** For other add-ons and tests: the version, and report(feature, error) to note a feature that failed. */
	w.VoidOrder = Object.freeze({
		version: VERSION,
		report: (/** @type {string} */ feature, /** @type {any} */ e) => ctx.report(feature, e),
	});
	loadModules();

	/** /void diag: what the add-on is running, as local notes the player can copy and send. */
	function diag() {
		const lines = [`Oculus Nihili ${VERSION} on ${w.GameVersion || '?'}; signed in: ${state ? state.status : 'no'}`];
		lines.push(`Modules: ${MODULES.map((m) => `${m} ${ctx.modules[m] ? 'on' : m in ctx.modules ? 'OFF' : 'loading'}`).join(', ')}`);
		const g = ctx.modules.guard;
		const off = g && g.problems && typeof g.problems.values === 'function' ? [...g.problems.values()] : [];
		lines.push(off.length ? `Switched off: ${off.map((p) => `${p.feature} (${p.message})`).join('; ')}` : 'Switched off: nothing');
		const reports = ctx.modules.reports;
		const seen =
			reports && typeof reports.problems === 'function'
				? reports.problems()
				: early.map(([feature, e]) => ({ feature, error: String((e && e.message) || e) }));
		lines.push(seen.length ? `Problems: ${seen.map((p) => `${p.feature}: ${p.error}`).join('; ')}` : 'Problems: none');
		const items = ctx.modules.items;
		const held = items && w.Player ? items.held(w.Player) : null;
		lines.push(
			`Holding: ${held ? `${held.item} / ${held.weapon && held.weapon.name}, carry ${held.position} (${held.carry || '-'})` : 'no Armory weapon'}`,
		);
		const actions = ctx.modules.actions;
		if (actions && typeof actions.diag === 'function') {
			const d = actions.diag();
			lines.push(
				`Actions ${d.on ? 'on' : 'off in settings'}: on someone ${d.onOther.join(', ') || 'none'}; on your hands ${d.onHands.join(', ') || 'none'}`,
			);
		}
		for (const l of lines) {
			note(l);
		}
	}

	// ---- Start: once the game is ready.
	const start = setInterval(() => {
		if (!w.Player || !w.Player.MemberNumber || typeof w.CommandCombine !== 'function' || typeof w.ServerSend !== 'function') {
			return;
		}
		clearInterval(start);
		guard(() => {
			w.CommandCombine([
				{
					Tag: 'void',
					Description:
						': Oculus Nihili, the Void Order’s add-on (orders, members, ID cards, dice). /void card <number>, /void id, /void roll 2d6+3',
					Action: (/** @type {string} */ args) => guard(() => command(args)),
				},
			]);
			if (typeof w.ChatRoomRegisterMessageHandler === 'function') {
				guard(
					() =>
						w.ChatRoomRegisterMessageHandler({
							Description: 'Oculus Nihili: ID cards, dice and marks',
							Priority: -150,
							Callback: onRoomMessage,
						}),
					undefined,
					'Room messages',
				);
			}
			addEventListener('keydown', escapeFromPage, true);
			addEventListener('pointerdown', pointerDown, true);
			document.addEventListener('keydown', hotkeyDown, true);
			tapTips();
			applyLook();
			guard(hookRoom, undefined, 'Room hooks');
			guard(registerExtension, undefined, 'Extensions page');
			connect();
			setInterval(tick, 2000);
		});
	}, 500);
})();
