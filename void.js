// The Void Order: a Bondage Club add-on for the members of the Void Order.
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
	const VERSION = '2.0.0';
	/** The Order's server (a test page sets VoidOrderServer before loading this). */
	const SERVER = w.VoidOrderServer || 'wss://void-order.slimebeep-relay.workers.dev/ws';
	/** Where the key is kept in the account (Player.ExtensionSettings), synced to every device. */
	const SETTINGS_KEY = 'VoidOrder';
	/** Content of the hidden room messages that show an ID card or a dice roll to the room's Void Order users. */
	const HIDDEN = 'VoidOrder';
	/** Minutes before a session that the reminder comes. */
	const REMIND_MIN = 15;
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
	};
	/** Ranks in a branch, the lowest rank that joins a chapter and that leads the branch, and branches per member. */
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
	 */
	function guard(fn, say) {
		try {
			const r = fn();
			if (r && typeof r.catch === 'function') {
				r.catch((/** @type {any} */ e) => report(e, say));
			}
		} catch (e) {
			report(e, say);
		}
	}
	function report(/** @type {any} */ e, /** @type {((text: string) => void) | undefined} */ say) {
		const text = `⚠ The Void Order hit a problem: ${(e && e.message) || e}`;
		if (say) {
			say(text);
		} else {
			console.warn(text);
		}
	}

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

	/** The current room, if it is public and you share it; else ''. */
	function publicRoom() {
		const d = w.ChatRoomData;
		if (w.CurrentScreen !== 'ChatRoom' || !d || !d.Name || !pref('shareRoom', true)) {
			return '';
		}
		const pub = Array.isArray(d.Visibility) ? d.Visibility.length === 1 && d.Visibility[0] === 'All' : !d.Private;
		return pub ? String(d.Name).slice(0, LIMITS.room) : '';
	}

	function connect() {
		if (ws || !w.Player || !w.Player.MemberNumber) {
			return;
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
		if (x.t === 'state') {
			state = x;
			if (resetCode && x.status === 'member') {
				resetCode = '';
				note('Your key is in. Welcome to the Order.');
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
		if (founder) {
			lines.push({ text: s.founder.name, sym: s.founder.sym, color: s.founder.color });
		}
		if (m.mon) {
			lines.push({ text: s.monsignor.name, sym: s.monsignor.sym, color: s.monsignor.color });
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
		if (!founder && !m.mon && !m.places.length) {
			lines.push({ text: 'Awaiting placement', cls: 'chapter' });
		}
		return lines;
	}

	/** A member's place in a few words: "Founder · Monsignor", "Warmage", "Paladin - Knight", "Awaiting placement". */
	function placeSummary(/** @type {any} */ m) {
		const s = structure();
		const parts = [];
		if (m.n === founderN()) {
			parts.push(s.founder.name);
		}
		if (m.mon) {
			parts.push(s.monsignor.name);
		}
		const title = hybridTitle(m);
		parts.push(...(title ? [title] : m.places.map((/** @type {any} */ p) => placeText(p, m))));
		return parts.join(' · ') || 'Awaiting placement';
	}

	// ---- Who stands where (the server decides; this only shows what you may do)
	const isMember = () => !!state && state.status === 'member';
	const founderN = () => (state && state.meta ? state.meta.founder : 0);
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
			const stage = left <= 0 && left > -30 * 60000 ? 'now' : left > 0 && left <= REMIND_MIN * 60000 ? 'soon' : '';
			if (stage && seen[o.id] !== stage && !(stage === 'soon' && seen[o.id] === 'now')) {
				seen[o.id] = stage;
				changed = true;
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
		#void-panel, #void-card, .void-toast, #void-tab, #void-dice { --v-bg: #0c0714; --v-bg2: #160d24; --v-line: #3d2a5c; --v-text: #e8defc; --v-dim: #a597c4; --v-accent: #b48cff; --v-hot: #e05cff; --v-bad: #ff7a90;
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
		#void-panel .msg { min-height: 1.3em; color: var(--v-hot); font-size: 13px; margin-top: 6px; white-space: pre-wrap; }
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
		#void-card .bio { margin-top: 10px; white-space: pre-wrap; font-size: 13px; color: #d6cdee; }
		#void-card .foot { margin-top: 12px; font-size: 11px; color: var(--v-dim); border-top: 1px solid #ffffff14; padding-top: 8px; display: flex; gap: 8px; align-items: center; justify-content: center; }
		#void-card .copy { border: 1px solid #5b3d8f; border-radius: 999px; background: none; color: var(--v-dim); font-size: 11px; padding: 1px 8px; cursor: pointer; }
		.void-toast { position: fixed; z-index: 2147483003; right: 16px; width: 300px; padding: 10px 14px; border-radius: 12px; cursor: pointer;
			border: 1px solid #7a52c4; background: #12091fee; box-shadow: 0 8px 30px #000c; transition: opacity .4s; }
		#void-tab { position: fixed; z-index: 2147483000; left: 0; top: 50%; transform: translateY(-50%); width: 26px; height: 54px; border: 1px solid #5b3d8f; border-left: 0;
			border-radius: 0 10px 10px 0; background: #12091fdd; color: #c9a8ff; font: 600 16px Georgia, serif; cursor: pointer; padding: 0; text-shadow: 0 0 8px #9b59ff; }
		#void-dice { position: fixed; z-index: 2147483004; left: 50%; bottom: 14vh; transform: translateX(-50%); width: min(380px, 94vw); border-radius: 20px; padding: 0 0 10px; cursor: pointer;
			border: 1px solid #7a52c4; background: radial-gradient(120% 100% at 50% 40%, #2a1250 0%, #0e0619 70%); box-shadow: 0 16px 50px #000d, 0 0 50px #8a4dff55; transition: opacity .4s; text-align: center; }
		#void-dice canvas { position: static; margin: 0; display: block; width: 100%; height: 190px; }
		#void-dice .who { font: 600 14px Georgia, serif; letter-spacing: 1px; color: #e9dcff; padding: 0 12px; }
		#void-dice .sum { font: 600 13px system-ui, sans-serif; color: var(--v-dim); min-height: 18px; padding: 0 12px; }
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
	/** Keys typed in the panel stay out of the game. */
	const keepKeys = (/** @type {HTMLElement} */ el) => {
		for (const t of ['keydown', 'keyup', 'keypress']) {
			el.addEventListener(t, (e) => {
				if (/** @type {KeyboardEvent} */ (e).key !== 'Escape') {
					e.stopPropagation();
				}
			});
		}
	};
	/** A short message at the bottom right that goes away by itself; clicking it runs `click`. */
	function toast(/** @type {string} */ text, /** @type {(() => void) | undefined} */ click) {
		style();
		const t = make('div', 'void-toast', text);
		const others = document.querySelectorAll('.void-toast').length;
		t.style.bottom = `${16 + others * 64}px`;
		t.addEventListener('click', () => {
			t.remove();
			if (click) {
				guard(click);
			}
		});
		document.body.append(t);
		setTimeout(() => {
			t.style.opacity = '0';
			setTimeout(() => t.remove(), 500);
		}, 9000);
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
		}
		const lines = idLines(c, c.founder);
		const id = make('div', 'id');
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
		card.append(
			x,
			make('div', 'org', c.order || 'The Void Order'),
			pic,
			make('div', 'nm', c.name),
			make('div', 'num', `Member #${c.n}`),
			id,
		);
		if (c.bio) {
			card.append(make('div', 'bio', c.bio));
		}
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
		w.ServerSend('ChatRoomChat', { Content: `shows their ID card of ${state.meta.name}.`, Type: 'Emote' });
		w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ card: true }] });
		return '';
	}
	/** @type {Map<number, number>} When each person's card shown in the room was last opened (once a minute at most). */
	const roomCards = new Map();
	/** @type {Map<number, number>} When each person's last roll shown in the room came. */
	const roomRolls = new Map();
	/**
	 * A hidden Void Order note in the room: someone showing their card, or a dice roll. The card or roll comes from the
	 * server, not the note, and a roll only counts if it is the sender's own and fresh.
	 */
	function onRoomMessage(/** @type {any} */ data, /** @type {any} */ sender) {
		guard(() => {
			if (!data || data.Type !== 'Hidden' || data.Content !== HIDDEN || !sender || !sender.MemberNumber || !ws || !state) {
				return;
			}
			const d = Array.isArray(data.Dictionary) ? data.Dictionary[0] : null;
			const n = sender.MemberNumber;
			if (d && d.card === true && pref('roomCards', true)) {
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
			} else if (d && typeof d.roll === 'string' && n !== w.Player.MemberNumber && pref('roomDice', true)) {
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
		if (!C || !C.MemberNumber || !isMember() || !pref('roomBadges', true)) {
			return null;
		}
		if (typeof w.ChatRoomHideIconState === 'number' && w.ChatRoomHideIconState > 0) {
			return null;
		}
		const n = C.MemberNumber;
		const m = memberOf(n);
		return m && !m.invited && (n === w.Player.MemberNumber || roomVoid.has(n)) ? m : null;
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
	/** A member's mark: the Founder's, a Monsignor's, their main branch's, or the Order's ⸸ while they wait for a place. */
	function markOf(/** @type {any} */ m) {
		const s = structure();
		const b = m.places[0] && branchOf(m.places[0].b);
		const x = m.n === founderN() ? s.founder : m.mon ? s.monsignor : b || { sym: '⸸', color: '#b48cff' };
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
		g.drawImage(markImage(sym, color), x + MARK.x * zoom, y + MARK.y * zoom, MARK.size * zoom, MARK.size * zoom);
		if (onMark(x, y, zoom) && typeof w.DrawTextFit === 'function') {
			w.DrawTextFit(placeSummary(m), x + 250 * zoom, y + (MARK.y + MARK.size / 2) * zoom, 150 * zoom, color, 'black');
		}
	}
	/** A click on someone's mark opens their ID card; returns whether it was one. */
	function clickMark(/** @type {any} */ C, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ zoom) {
		const m = markedMember(C);
		if (!m || !onMark(x, y, zoom)) {
			return false;
		}
		guard(() => openCard(m.n, note));
		return true;
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
		const mod = sdk.registerMod({
			name: 'VoidOrder',
			fullName: 'The Void Order',
			version: VERSION,
			repository: 'https://github.com/Proudkiller0015/void-order',
		});
		let broken = false;
		mod.hookFunction('ChatRoomCharacterViewDrawOverlay', 0, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) => {
			const r = next(args);
			if (!broken) {
				try {
					drawMark(args[0], args[1], args[2], args[3]);
				} catch (e) {
					broken = true;
					report(e);
				}
			}
			return r;
		});
		mod.hookFunction('ChatRoomCharacterViewClickCharacter', 0, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) =>
			!broken && clickMark(args[0], args[1], args[2], args[3]) ? undefined : next(args),
		);
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
	/** A roll's faces and modifier added up: "4 + 6 + 3". */
	const rollSum = (/** @type {any} */ r) =>
		`${r.dice.map((/** @type {any} */ d) => d.v).join(' + ')}${r.mod > 0 ? ` + ${r.mod}` : r.mod < 0 ? ` - ${-r.mod}` : ''}`;
	/** A roll in words: "2d6+3: 4 + 6 + 3 = 13", "d20: 17". */
	const rollText = (/** @type {any} */ r) =>
		r.dice.length === 1 && !r.mod ? `${rollSpec(r)}: ${r.total}` : `${rollSpec(r)}: ${rollSum(r)} = ${r.total}`;
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
			w.ServerSend('ChatRoomChat', { Content: `rolls the Void dice: ${rollText(r.roll)}`, Type: 'Emote' });
			w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ roll: r.roll.id }] });
		}
		render();
		return '';
	}
	/** @type {any[]} Your rolls in this session, newest first. */
	const recentRolls = [];
	/** Queues a roll for the tray: one at a time, a few waiting, your own always (dropping the oldest other). */
	function playRoll(/** @type {any} */ r, /** @type {string} */ warn, mine = false) {
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
	 * The dice tray: the roll's dice tumble in and settle on their faces (about 1.2 s), the total glows, then it fades.
	 * Drawn on a canvas, no pictures. Clicking it closes it.
	 */
	function showTray(/** @type {any} */ r, /** @type {string} */ warn, /** @type {() => void} */ done) {
		style();
		document.getElementById('void-dice')?.remove();
		const tray = make('div');
		tray.id = 'void-dice';
		tray.dataset.roll = r.id;
		tray.dataset.faces = r.dice.map((/** @type {any} */ d) => d.v).join(',');
		const canvas = make('canvas');
		const who = make('div', 'who', `${r.name} rolls ${rollSpec(r)}`);
		const sum = make('div', 'sum');
		tray.append(canvas, who, sum);
		if (warn) {
			tray.append(make('div', 'warn', `⚠ ${warn}`));
		}
		document.body.append(tray);
		const W = 380;
		const H = 190;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
		g.scale(dpr, dpr);
		const n = r.dice.length;
		const rows = n > 5 ? 2 : 1;
		const perRow = Math.ceil(n / rows);
		const size = Math.min(30, (W - 40) / perRow / 2.4, rows === 2 ? 28 : 30);
		const dice = r.dice.map((/** @type {any} */ d, /** @type {number} */ i) => {
			const row = Math.floor(i / perRow);
			const inRow = row === rows - 1 ? n - perRow * (rows - 1) : perRow;
			const col = i - row * perRow;
			return {
				...d,
				x: W / 2 + (col - (inRow - 1) / 2) * size * 2.5,
				y: rows === 1 ? H / 2 + 6 : H / 2 + 6 + (row - 0.5) * size * 2.4,
				from: -60 - Math.random() * 80,
				lift: 30 + Math.random() * 50,
				spin: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6),
				delay: i * 45,
			};
		});
		const start = performance.now();
		const ROLL = 1150;
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
		tray.addEventListener('click', end);
		const frame = (/** @type {number} */ now) => {
			if (ended || !tray.isConnected) {
				return end();
			}
			const t = now - start;
			g.clearRect(0, 0, W, H);
			drawBackdrop(g, W, H, t);
			for (const d of dice) {
				const k = Math.min(1, Math.max(0, (t - d.delay) / (ROLL - d.delay)));
				drawDie(g, d, k, size, t);
			}
			if (!settled && t >= ROLL + 100) {
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
	/** The tray behind the dice: a slow ring of runes around the Void's eye. */
	function drawBackdrop(
		/** @type {CanvasRenderingContext2D} */ g,
		/** @type {number} */ W,
		/** @type {number} */ H,
		/** @type {number} */ t,
	) {
		const cx = W / 2;
		const cy = H / 2 + 6;
		g.save();
		// The eye: an almond, its iris and the dark pupil, breathing.
		const open = 0.75 + 0.25 * Math.sin(t / 380);
		g.globalAlpha = 0.22;
		g.strokeStyle = '#b48cff';
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(cx - 70, cy);
		g.quadraticCurveTo(cx, cy - 60 * open, cx + 70, cy);
		g.quadraticCurveTo(cx, cy + 60 * open, cx - 70, cy);
		g.stroke();
		const iris = g.createRadialGradient(cx, cy, 2, cx, cy, 26);
		iris.addColorStop(0, '#000');
		iris.addColorStop(0.45, '#000');
		iris.addColorStop(0.5, '#e05cff');
		iris.addColorStop(1, '#3a1d6600');
		g.fillStyle = iris;
		g.beginPath();
		g.arc(cx, cy, 26 * open, 0, Math.PI * 2);
		g.fill();
		// The rune ring.
		g.globalAlpha = 0.35;
		g.fillStyle = '#c9a8ff';
		g.font = '13px Georgia, serif';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		const runes = '⸸☿✦≈☨✙⸸ᚱᚢᚾᛖ✦☿≈⸸ᛟᚦ';
		for (let i = 0; i < runes.length; i++) {
			const a = (i / runes.length) * Math.PI * 2 + t / 2600;
			g.fillText(runes[i], cx + Math.cos(a) * (W / 2 - 24), cy + Math.sin(a) * (H / 2 - 22));
		}
		g.restore();
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
		if (!isMember() || !slimeBeep() || chatTried === state.me.n || pref(`chat.${state.me.n}`, false)) {
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
	/** Runs a request; its error shows in the panel, and `done` runs when it worked. */
	async function act(/** @type {Record<string, any>} */ x, /** @type {((r: any) => void) | undefined} */ done) {
		panelSay('');
		const r = await req(x);
		if (r.t === 'error') {
			panelSay(`⚠ ${r.why}`);
		} else if (done) {
			done(r);
		}
		return r;
	}
	const closePanel = () => {
		document.getElementById('void-panel')?.remove();
		drawTab();
	};
	function openPanel(/** @type {string | undefined} */ which) {
		style();
		if (which) {
			tab = which;
		}
		if (!document.getElementById('void-panel')) {
			const p = make('div');
			p.id = 'void-panel';
			keepKeys(p);
			document.body.append(p);
			lastMsg = '';
		}
		render(true);
	}
	/** Whether you may manage anyone: the Founder, admins and branch leaders. */
	const manages = () => isMember() && (isTop(state.me) || leadsAny(state.me));
	/** The tabs you have, in order. */
	function tabs() {
		if (!isMember()) {
			return [
				['join', state && state.meta ? 'The Order' : 'Found'],
				['dice', 'Dice'],
			];
		}
		/** @type {[string, string][]} */
		const t = [
			['orders', 'Orders'],
			['members', 'Members'],
			['order', 'The Order'],
			['dice', 'Dice'],
		];
		if (manages()) {
			t.push(['manage', 'Manage']);
		}
		t.push(['me', 'My card']);
		return t;
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
		const open = [...p.querySelectorAll('details[data-k]')]
			.filter((d) => /** @type {any} */ (d).open)
			.map((d) => /** @type {any} */ (d).dataset.k);
		p.replaceChildren();
		const x = make('button', 'x', '✕');
		x.title = 'Close';
		x.addEventListener('click', closePanel);
		const head = make('header');
		head.append(make('h2', '', (state && state.meta && state.meta.name) || 'The Void Order'), make('span', 'status', statusLine()), x);
		p.append(head);
		const list = tabs();
		if (!list.some(([id]) => id === tab)) {
			tab = list[0][0];
		}
		const nav = make('nav');
		for (const [id, label] of list) {
			const b = make('button', id === tab ? 'on' : '', label);
			const count = id === 'orders' ? openOrders() : id === 'manage' ? unplacedFor().length : 0;
			if (count) {
				b.append(make('span', 'badge', String(count)));
			}
			b.addEventListener('click', () => {
				tab = id;
				lastMsg = '';
				render(true);
			});
			nav.append(b);
		}
		p.append(nav);
		const body = make('main');
		guard(() => {
			if (!state) {
				body.append(make('p', 'dim', ws ? 'Signing in…' : 'Connecting to the Order…'));
			} else {
				const draw = {
					orders: drawOrders,
					members: drawMembers,
					order: drawOrder,
					dice: drawDice,
					manage: drawManage,
					me: drawMe,
					join: drawJoin,
				};
				draw[tab](body);
			}
		}, panelSay);
		const msg = make('div', 'msg', lastMsg);
		body.append(msg);
		p.append(body);
		for (const d of body.querySelectorAll('details[data-k]')) {
			if (open.includes(/** @type {any} */ (d).dataset.k)) {
				/** @type {any} */ (d).open = true;
			}
		}
		body.scrollTop = scroll;
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
			return { guest: 'Not a member', invited: 'Invited', mismatch: 'Key not recognised' }[state.status] || '';
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
			return 'Awaiting placement';
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
			box.append(make('div', 'body', o.body));
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

	// -- Members: the Founder and Monsignors, then each branch by rank from 5 down to 1, then those awaiting a place
	function drawMembers(/** @type {HTMLElement} */ body) {
		const s = structure();
		const on = state.members.filter((/** @type {any} */ m) => m.on).length;
		body.append(make('p', 'dim', `${plural(state.members.length, 'member')}, ${on} online. Click someone for their ID card.`));
		const byName = (/** @type {any} */ a, /** @type {any} */ b) => Number(!!b.on) - Number(!!a.on) || a.name.localeCompare(b.name);
		const all = [...state.members].sort(byName);
		const founder = all.filter((/** @type {any} */ m) => m.n === founderN());
		if (founder.length) {
			body.append(branchTitle(s.founder));
			for (const m of founder) {
				body.append(drawMemberRow(m, ''));
			}
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
		const waiting = all.filter((/** @type {any} */ m) => !m.places.length && !m.mon && m.n !== founderN());
		if (waiting.length) {
			body.append(make('div', 'branch', `Awaiting placement · ${waiting.length}`));
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
		body.append(make('h3', '', 'About'), make('p', '', meta.about || 'No about text yet.'));
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
				body.append(make('p', '', 'The Void Order has not been founded yet.'));
				return;
			}
			body.append(
				make('h3', '', 'Found the Order'),
				make(
					'p',
					'',
					'You run the app. Name the Order and enter the founding code. You are its Founder until you hand that place to the Order’s own founder (under The Order); as the app admin you keep every power after.',
				),
				label('Name'),
				field('f:name', 'The Void Order', LIMITS.name),
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
								name: drafts['f:name'] || 'The Void Order',
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
		body.append(make('h3', '', 'About'), make('p', '', meta.about || ''));
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
				() => act({ t: 'join', name: nick(w.Player) }, () => note(`Welcome to ${meta.name}. A branch leader will place you soon.`)),
				'b main',
			),
		);
	}

	// -- Dice
	function drawDice(/** @type {HTMLElement} */ body) {
		body.append(
			make('h3', '', 'The Void dice'),
			make(
				'p',
				'dim',
				'Click dice to add them, then roll. The Order’s server rolls them, so nobody can fake a roll; in a chat room everyone sees it, and Void Order users watch the dice fall.',
			),
		);
		const pool = /** @type {number[]} */ (drafts['d:pool'] ? JSON.parse(drafts['d:pool']) : []);
		const pick = make('div', 'dice-pick');
		for (const s of DICE) {
			const d = make('button', 'die');
			d.title = `Add a d${s}`;
			const icon = make('canvas');
			icon.width = icon.height = 60;
			const g = /** @type {CanvasRenderingContext2D} */ (icon.getContext('2d'));
			g.translate(30, 30);
			g.strokeStyle = '#c9a8ff';
			g.lineWidth = 3;
			const shape = dieShape(s);
			traceDie(g, shape, 24);
			g.stroke();
			g.lineWidth = 1.5;
			g.globalAlpha = 0.6;
			strokeEdges(g, shape, 24);
			d.append(icon, make('span', '', s === 100 ? 'd%' : `d${s}`));
			d.addEventListener('click', () =>
				guard(() => {
					if (pool.length >= LIMITS.dice) {
						panelSay(`⚠ ${LIMITS.dice} dice at most.`);
						return;
					}
					drafts['d:pool'] = JSON.stringify([...pool, s]);
					render(true);
				}, panelSay),
			);
			pick.append(d);
		}
		body.append(pick);
		const mod = Number(drafts['d:mod'] || 0);
		body.append(make('div', 'pool', pool.length ? diceSpec(pool, mod) : 'No dice yet'));
		const row = make('div', 'row');
		const modIn = make('input', 'auto');
		modIn.type = 'number';
		modIn.min = String(-LIMITS.mod);
		modIn.max = String(LIMITS.mod);
		modIn.value = String(mod);
		modIn.style.width = '80px';
		modIn.addEventListener('input', () => {
			drafts['d:mod'] = modIn.value;
		});
		modIn.addEventListener('change', () => render(true));
		row.append(
			make('span', 'dim', 'Modifier'),
			modIn,
			button(
				'🎲 Roll',
				async () => {
					const m = Number(drafts['d:mod'] || 0);
					if (!pool.length) {
						panelSay('⚠ Add some dice first.');
						return;
					}
					if (!Number.isInteger(m) || Math.abs(m) > LIMITS.mod) {
						panelSay(`⚠ The modifier goes from -${LIMITS.mod} to +${LIMITS.mod}.`);
						return;
					}
					const why = await roll(pool, m);
					panelSay(why ? `⚠ ${why}` : w.CurrentScreen === 'ChatRoom' ? '' : 'Not in a chat room: only you saw it.');
				},
				'b main',
			),
			button('Clear', () => {
				delete drafts['d:pool'];
				delete drafts['d:mod'];
				render(true);
			}),
		);
		body.append(row);
		body.append(make('p', 'dim', 'Or type /void roll 2d6+3, /void roll d20 in the chat.'));
		if (recentRolls.length) {
			body.append(make('h3', '', 'Your rolls'));
			for (const r of recentRolls) {
				body.append(make('div', '', `${fromNow(r.at)} · ${rollText(r)}`));
			}
		}
	}

	// -- Manage: placing members, bringing people in, and for the Founder and admins the about page and the ranks
	/** @type {Map<number, { code: string, hours: number }>} Reset and join codes made in this session, by member. */
	const resetCodes = new Map();
	/** @type {{ codes: { n: number, name: string, code: string }[], days: number } | null} The join codes just made. */
	let broughtIn = null;
	/** Options for a rank select: the ranks given, named as member m would hold them. */
	const tierOptions = (/** @type {any} */ b, /** @type {number[]} */ tiers, /** @type {any} */ m, c = '') =>
		/** @type {[string, string][]} */ (
			tiers.map((t) => [String(t), `${t}. ${word(tierForms(b, t, t >= CHAPTER_FROM ? c : ''), m.form, m.el)}`])
		);
	const chapterOptions = (/** @type {any} */ b) =>
		/** @type {[string, string][]} */ ([['', 'No chapter'], ...b.chapters.map((/** @type {any} */ c) => [c.id, c.name])]);
	/** One member's box: their places (rank and chapter you may change), adding a branch, Monsignor, admin, codes. */
	function memberBox(/** @type {any} */ m) {
		const me = state.me;
		const box = make('div', 'box');
		const head = make('div', 'row');
		head.append(make('span', 'grow', `${m.name} #${m.n}${m.n === me.n ? ' (you)' : ''}`));
		const title = hybridTitle(m);
		if (title) {
			head.append(make('span', 'tag', title));
		}
		if (m.invited) {
			head.append(make('span', 'tag', 'Invited'));
		}
		if (topOver(me, m)) {
			head.append(check(` ${structure().monsignor.name}`, !!m.mon, (on) => act({ t: 'monsignor', member: m.n, on })));
		}
		if ((me.n === founderN() || me.n === state.appAdmin) && m.n !== state.appAdmin && m.n !== founderN() && !m.invited) {
			head.append(check(' Admin', !!m.admin, (on) => act({ t: 'admin', member: m.n, on })));
		}
		box.append(head);
		for (const p of m.places) {
			const b = branchOf(p.b);
			if (!b) {
				continue;
			}
			const line = make('div', 'place');
			line.append(branchTitle(b, ''));
			const tiers = givableTiers(me, m, b.id);
			if (!tiers.length) {
				line.append(make('span', '', rankName(p, m)), make('span', 'dim', chapterName(p)), make('span', ''));
			} else {
				const place = (/** @type {number} */ t, /** @type {string} */ c) =>
					act({ t: 'place', member: m.n, branch: b.id, tier: t, chapter: t >= CHAPTER_FROM ? c : '' });
				const ch = select(chapterOptions(b), p.c, (c) => place(p.t, c), '');
				ch.disabled = p.t < CHAPTER_FROM;
				line.append(
					select(tierOptions(b, tiers, m, p.c), String(p.t), (t) => place(Number(t), p.c), ''),
					ch,
					button('Take out', () => act({ t: 'unplace', member: m.n, branch: b.id }), 'b bad'),
				);
			}
			box.append(line);
		}
		const open = structure().branches.filter((/** @type {any} */ b) => tierOf(m, b.id) === 0 && givableTiers(me, m, b.id).length);
		if (m.places.length < PLACES && open.length) {
			const k = `add:${m.n}`;
			const b = branchOf(drafts[`${k}:b`]) || open[0];
			const tiers = givableTiers(me, m, b.id);
			const t = tiers.includes(Number(drafts[`${k}:t`])) ? Number(drafts[`${k}:t`]) : tiers[0];
			const c = t >= CHAPTER_FROM ? drafts[`${k}:c`] || '' : '';
			const line = make('div', 'place');
			const ch = select(
				chapterOptions(b),
				c,
				(v) => {
					drafts[`${k}:c`] = v;
					render(true);
				},
				'',
			);
			ch.disabled = t < CHAPTER_FROM;
			line.append(
				select(
					open.map((/** @type {any} */ x) => [x.id, withSym(x)]),
					b.id,
					(v) => {
						drafts[`${k}:b`] = v;
						render(true);
					},
					'',
				),
				select(
					tierOptions(b, tiers, m, c),
					String(t),
					(v) => {
						drafts[`${k}:t`] = v;
						render(true);
					},
					'',
				),
				ch,
				button(
					m.places.length ? 'Add branch' : 'Place',
					() => act({ t: 'place', member: m.n, branch: b.id, tier: t, chapter: c }, () => forget(k)),
					'b main',
				),
			);
			box.append(line);
		}
		const row = make('div', 'row');
		row.style.marginTop = '6px';
		row.append(make('span', 'grow'));
		if (mayReset(me, m)) {
			row.append(
				button(m.invited ? 'New join code' : 'Reset code', () =>
					act({ t: 'reset', member: m.n }, (r) => {
						resetCodes.set(m.n, { code: r.code, hours: r.hours });
						render(true);
					}),
				),
			);
		}
		if (mayRemove(me, m)) {
			row.append(
				button(
					'Remove from the Order',
					() => {
						if (confirmed(`kick:${m.n}`, `Click "Remove from the Order" again to take ${m.name} out of the Order.`)) {
							return act({ t: 'kick', member: m.n });
						}
					},
					'b bad',
				),
			);
		}
		box.append(row);
		const reset = resetCodes.get(m.n);
		if (reset) {
			box.append(
				make(
					'div',
					'dim',
					`${m.invited ? 'Join' : 'Reset'} code for ${m.name}, valid ${spellHours(reset.hours)}. They open /void and enter it:`,
				),
				make('div', 'code', reset.code),
			);
		}
		return box;
	}
	function drawManage(/** @type {HTMLElement} */ body) {
		const me = state.me;
		const top = isTop(me);
		const led = ledBy(me);
		body.append(
			make(
				'p',
				'dim',
				top
					? 'You have every power: place anyone, in any branch, at any rank. Members still waiting come first; every pick saves at once.'
					: `You lead ${led.map((/** @type {any} */ b) => b.name).join(' and ')}: you place members below your own rank there, and place those still waiting. Every pick saves at once.`,
			),
		);
		const filter = field('m:filter', '', 40);
		filter.placeholder = 'Find a member by name or number';
		filter.addEventListener('input', () => render(true));
		body.append(filter);
		const q = String(drafts['m:filter'] || '').toLowerCase();
		const shown = (/** @type {any} */ m) => !q || m.name.toLowerCase().includes(q) || String(m.n).includes(q);
		const waiting = unplacedFor().filter(shown);
		body.append(make('h3', '', `Awaiting placement · ${waiting.length}`));
		if (!waiting.length) {
			body.append(make('p', 'dim', 'Nobody is waiting for a place.'));
		}
		for (const m of waiting) {
			body.append(memberBox(m));
		}
		const mine = state.members
			.filter(
				(/** @type {any} */ m) =>
					!waiting.includes(m) && (topOver(me, m) || m.places.some((/** @type {any} */ p) => leaderOver(me, m, p.b))),
			)
			.filter((/** @type {any} */ m) => (m.places.length || m.mon || m.n === me.n) && shown(m))
			.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
		body.append(make('h3', '', top ? 'Members' : 'Members of your branch below you'));
		if (!mine.length) {
			body.append(make('p', 'dim', 'Nobody here yet.'));
		}
		for (const m of mine) {
			body.append(memberBox(m));
		}
		body.append(drawBringIn());
		if (!top) {
			return;
		}
		const meta = state.meta;
		body.append(
			make('h3', '', 'About page and joining'),
			label('Name'),
			field('a:name', meta.name, LIMITS.name),
			label('About'),
			field('a:about', meta.about, LIMITS.about, 'textarea'),
			check(' Joining open', 'a:open' in drafts ? drafts['a:open'] === '1' : meta.open, (on) => {
				drafts['a:open'] = on ? '1' : '0';
			}),
		);
		body.append(
			make('div'),
			button(
				'Save the about page',
				() =>
					act(
						{
							t: 'about',
							name: drafts['a:name'] ?? meta.name,
							about: drafts['a:about'] ?? meta.about,
							open: 'a:open' in drafts ? drafts['a:open'] === '1' : meta.open,
						},
						() => {
							forget('a');
							panelSay('Saved.');
						},
					),
				'b main',
			),
		);
		if (state.log && state.log.length) {
			body.append(make('h3', '', 'Recent changes'));
			for (const l of [...state.log].reverse()) {
				body.append(make('div', 'dim', `${dateTime(l.at)} — ${l.text}`));
			}
		}
	}
	/**
	 * Bringing in members the Order had before the add-on: one per line, "member number, name", all at one place. Each
	 * gets a join code to send them.
	 */
	function drawBringIn() {
		const me = state.me;
		const top = isTop(me);
		const wrap = make('div');
		wrap.append(
			make('h3', '', 'Bring in existing members'),
			make(
				'p',
				'dim',
				'For members the Order had before the add-on, placed at once. One per line: member number, name. Each gets a join code; send it to them by whisper or beep, and they enter it under /void.',
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
		const line = make('div', 'place');
		line.append(
			select(
				[...(top ? [['', 'No branch yet']] : []), ...branches.map((/** @type {any} */ x) => [x.id, withSym(x)])],
				bId,
				(v) => {
					drafts['in:b'] = v;
					render(true);
				},
				'',
			),
		);
		if (b) {
			const ch = select(
				chapterOptions(b),
				c,
				(v) => {
					drafts['in:c'] = v;
					render(true);
				},
				'',
			);
			ch.disabled = t < CHAPTER_FROM;
			line.append(
				select(
					tiers.map((x) => [String(x), `${x}. ${tierLabel(tierForms(b, x, c))}`]),
					String(t),
					(v) => {
						drafts['in:t'] = v;
						render(true);
					},
					'',
				),
				ch,
			);
		}
		const since = field('in:since', '', 10);
		since.type = 'date';
		wrap.append(label('People'), list, label('Their place'), line);
		if (top) {
			wrap.append(check(` ${structure().monsignor.name}s`, drafts['in:mon'] === '1', (on) => (drafts['in:mon'] = on ? '1' : '0')));
		}
		wrap.append(label('In the Order since (optional, the same for all of them)'), since);
		wrap.append(
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
		if (broughtIn) {
			wrap.append(make('p', 'dim', `Join codes, valid ${plural(broughtIn.days, 'day')}. Send each person theirs:`));
			for (const x of broughtIn.codes) {
				const row = make('div', 'row');
				row.append(make('span', 'grow', `${x.name} #${x.n}`), make('span', 'code', x.code));
				wrap.append(row);
			}
		}
		return wrap;
	}
	// -- My card
	function drawMe(/** @type {HTMLElement} */ body) {
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
				(form) => act({ t: 'profile', form }),
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
				select([['', 'None yet'], ...elements.map((/** @type {string} */ e) => [e, e])], me.el, (el) => act({ t: 'profile', el })),
			);
		}
		body.append(label(`Bio (up to ${LIMITS.bio} characters)`), field('bio', me.bio, LIMITS.bio, 'textarea'));
		body.append(button('Save bio', () => act({ t: 'profile', bio: drafts.bio ?? me.bio }, () => delete drafts.bio), 'b main'));
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
				await act({ t: 'profile', pic }, () => panelSay('Picture saved.'));
			}, panelSay),
		);
		const picRow = make('div', 'row');
		picRow.append(
			file,
			button('Remove picture', () => act({ t: 'profile', pic: '' }), 'b bad'),
		);
		body.append(picRow);

		if (slimeBeep()) {
			body.append(
				make('h3', '', 'SlimeBeep'),
				button('Join the Order chat in SlimeBeep', async () => panelSay((await joinChat()).text)),
			);
		}
		body.append(make('h3', '', 'Settings (this browser)'));
		for (const [k, text, dflt] of [
			['shareRoom', 'Show the Order which public room I am in', true],
			['roomCards', 'Open ID cards people show in my room', true],
			['roomDice', 'Play the Void dice people roll in my room', true],
			['roomBadges', 'Show the Void mark over members in my room', true],
			['sideTab', 'Show the ⸸ tab on the left of the screen', true],
		]) {
			const l = check(` ${text}`, pref(String(k), dflt), (on) => {
				setPref(String(k), on);
				roomTick(true);
				drawTab();
			});
			l.style.display = 'flex';
			l.style.margin = '4px 0';
			body.append(l);
		}
		body.append(
			make(
				'p',
				'dim',
				`Void Order ${VERSION}. /void opens this panel; /void card <member number> opens someone's card; /void roll 2d6+3 rolls dice.`,
			),
		);
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
	function drawTab() {
		const want =
			!!w.Player &&
			!!w.Player.MemberNumber &&
			pref('sideTab', true) &&
			!document.getElementById('void-panel') &&
			w.CurrentScreen === 'ChatRoom';
		let t = document.getElementById('void-tab');
		if (!want) {
			t?.remove();
			return;
		}
		if (!t) {
			style();
			t = make('button', '', '⸸');
			t.id = 'void-tab';
			t.title = 'The Void Order (/void)';
			t.addEventListener('click', () => guard(() => openPanel()));
			document.body.append(t);
		}
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
		if (sub === 'id') {
			const why = showMyIdInRoom();
			if (why) {
				note(why);
			}
			return;
		}
		if (sub === 'roll') {
			if (!arg) {
				openPanel('dice');
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

	w.VoidOrder = Object.freeze({ version: VERSION });

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
					Description: ': The Void Order (orders, members, ID cards, dice). /void card <number>, /void id, /void roll 2d6+3',
					Action: (/** @type {string} */ args) => guard(() => command(args)),
				},
			]);
			if (typeof w.ChatRoomRegisterMessageHandler === 'function') {
				w.ChatRoomRegisterMessageHandler({ Description: 'The Void Order ID cards and dice', Priority: -150, Callback: onRoomMessage });
			}
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') {
					if (document.getElementById('void-card')) {
						document.getElementById('void-card')?.remove();
					} else {
						closePanel();
					}
				}
			});
			hookRoom();
			connect();
			setInterval(tick, 2000);
		});
	}, 500);
})();
