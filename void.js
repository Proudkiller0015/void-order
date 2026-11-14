// The Void Order: a Bondage Club add-on for the members of the Void Order.
//
// /void opens the Order's panel: orders and photo sessions from the hierarchy, the member list by rank, ID
// cards, joining with the Order's questions, and for those with the rights, approving, ranks and the about page.
// Everything shared lives on the Order's server; each member signs in with a key kept in their BC account
// settings, so it works on every device. Everything runs inside `guard`: if the game changes, the Void Order
// shows an error and the game carries on.
(() => {
	'use strict';
	const w = /** @type {any} */ (window);
	if (w.VoidOrder) {
		return;
	}
	const VERSION = '1.0.0';
	/** The Order's server (a test page sets VoidOrderServer before loading this). */
	const SERVER = w.VoidOrderServer || 'wss://void-order.slimebeep-relay.workers.dev';
	/** Where the key is kept in the account (Player.ExtensionSettings), synced to every device. */
	const SETTINGS_KEY = 'VoidOrder';
	/** Content of the hidden room message that shows an ID card to the room's Void Order users. */
	const HIDDEN = 'VoidOrder';
	/** Minutes before a session that the reminder comes. */
	const REMIND_MIN = 15;
	const LIMITS = {
		name: 40,
		title: 40,
		bio: 300,
		about: 2000,
		questions: 8,
		question: 200,
		answer: 500,
		orderTitle: 80,
		orderText: 1500,
		pic: 12000,
		room: 40,
	};
	const KIND_ICON = { order: '📜', session: '📸', notice: '📢' };
	const KIND_NAME = { order: 'Order', session: 'Photo session', notice: 'Notice' };
	const ACK_LABEL = { read: '👁 Read', done: '✔ Done', yes: '✔ Coming', maybe: '❔ Maybe', no: '✖ Can’t come' };
	const ACKS = { order: ['read', 'done'], session: ['yes', 'maybe', 'no'], notice: ['read'] };

	// ---- Small helpers
	/** A line in your own chat log only. */
	const note = (/** @type {string} */ text) => {
		if (w.CurrentScreen === 'ChatRoom' && typeof w.ChatRoomSendLocal === 'function') {
			w.ChatRoomSendLocal(`⸸ ${text}`);
		}
	};
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
	/** A reset code to sign in with, typed by someone who lost their key. */
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
			sock = new WebSocket(`${SERVER}/ws${w.VoidOrderTestOrder ? `?o=${w.VoidOrderTestOrder}` : ''}`);
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
			clearInterval(pingTimer);
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
	 * Sends a request and resolves with the server's answer ({ t: 'ok' | 'error' | 'card', ... }).
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
			const first = !state;
			state = x;
			if (resetCode && x.status === 'member') {
				resetCode = '';
				note('Your new key is in. Welcome back.');
			}
			if (first && x.status === 'member') {
				ordersLoaded = false;
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
					note(`${open} unanswered order${open === 1 ? '' : 's'} from the Order. Type /void to read.`);
				}
			}
			render();
		} else if (x.t === 'order') {
			const fresh = !orders.has(x.o.id);
			orders.set(x.o.id, x.o);
			if (fresh && ordersLoaded && isForMe(x.o) && x.o.by !== w.Player.MemberNumber) {
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

	// ---- What the state says
	const isMember = () => !!state && state.status === 'member';
	const may = (/** @type {string} */ perm) => isMember() && state.me.perms.includes(perm);
	const rankOf = (/** @type {string} */ id) => (state ? state.ranks.find((/** @type {any} */ r) => r.id === id) : null);
	const rankIndex = (/** @type {string} */ id) => (state ? state.ranks.findIndex((/** @type {any} */ r) => r.id === id) : -1);
	/** A member's place: -1 for the founder, else their rank's index. */
	const powerOf = (/** @type {any} */ m) => (state.meta && state.meta.founder === m.n ? -1 : rankIndex(m.rank));
	const memberOf = (/** @type {number} */ n) => (state && state.members ? state.members.find((/** @type {any} */ m) => m.n === n) : null);
	/** Whether you stand above member `m`. */
	const aboveMe = (/** @type {any} */ m) => isMember() && state.me.power < powerOf(m);
	/** Ranks you may give: those strictly below your own. */
	const givable = () => (isMember() ? state.ranks.filter((/** @type {any} */ r, /** @type {number} */ i) => i > state.me.power) : []);
	function isForMe(/** @type {any} */ o) {
		if (!isMember()) {
			return false;
		}
		const me = state.me;
		return o.to.all === true || (o.to.ranks || []).includes(me.rank) || (o.to.members || []).includes(me.n);
	}
	/** Your answer to an order, or null. */
	const myAck = (/** @type {any} */ o) => (o.acks ? o.acks[w.Player.MemberNumber] : o.mine) || null;
	/** Whether an order is waiting for your answer (your own never are). */
	const waitsForMe = (/** @type {any} */ o) => isForMe(o) && o.by !== w.Player.MemberNumber && !myAck(o);
	/** A rank's name with its symbols either side ("≈][≈ Inquisitor ≈][≈"). */
	const rankLabel = (/** @type {any} */ r) => (r ? (r.sym ? `${r.sym} ${r.name} ${r.sym}` : r.name) : 'No rank');

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
		#void-panel, #void-card, .void-toast, #void-tab { --v-bg: #0c0714; --v-bg2: #160d24; --v-line: #3d2a5c; --v-text: #e8defc; --v-dim: #a597c4; --v-accent: #b48cff; --v-hot: #e05cff; --v-bad: #ff7a90;
			font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--v-text); box-sizing: border-box; }
		#void-panel *, #void-card * { box-sizing: border-box; }
		#void-panel { position: fixed; z-index: 2147483001; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(780px, 96vw); height: min(660px, 92vh);
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
		#void-panel input[type=checkbox] { width: auto; }
		#void-panel textarea { resize: vertical; min-height: 60px; }
		#void-panel label { display: block; margin: 8px 0 3px; color: var(--v-dim); font-size: 12px; }
		#void-panel .msg { min-height: 1.3em; color: var(--v-hot); font-size: 13px; margin-top: 6px; white-space: pre-wrap; }
		#void-panel .order .head { display: flex; gap: 8px; align-items: baseline; }
		#void-panel .order .title { font-weight: 600; flex: 1; }
		#void-panel .order.open { border-color: #9b59ff99; box-shadow: inset 3px 0 0 var(--v-hot); }
		#void-panel .order .body { white-space: pre-wrap; margin: 6px 0; }
		#void-panel .when { color: #ffd0ff; font-weight: 600; }
		#void-panel .rank { margin: 12px 0 4px; font: 600 14px Georgia, serif; letter-spacing: 1px; }
		#void-panel .member { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; cursor: pointer; }
		#void-panel .member:hover { background: #ffffff0c; }
		#void-panel .dot { width: 8px; height: 8px; border-radius: 50%; background: #3a3150; flex: none; }
		#void-panel .dot.on { background: #6bff9e; box-shadow: 0 0 6px #6bff9e; }
		#void-panel .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--v-line); color: var(--v-dim); }
		#void-panel .ladder .rk { display: grid; grid-template-columns: 1fr 90px 44px auto; gap: 6px; align-items: center; margin-bottom: 6px; }
		#void-panel .ladder .rk input[type=color] { padding: 0; height: 32px; }
		#void-panel .perms { display: flex; gap: 8px; font-size: 12px; color: var(--v-dim); grid-column: 1 / -1; margin-top: -2px; }
		#void-panel .perms label { display: inline-flex; gap: 4px; margin: 0; align-items: center; }
		#void-panel .code { font: 600 22px/1.2 ui-monospace, Consolas, monospace; letter-spacing: 3px; color: #fff; user-select: all; }
		#void-panel .pick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
		#void-card { position: fixed; z-index: 2147483002; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(380px, 94vw); padding: 18px 18px 16px; border-radius: 18px;
			border: 1px solid #7a52c4; background: radial-gradient(140% 90% at 50% 0%, #3a1d66 0%, #12091f 60%, #08040f 100%); box-shadow: 0 20px 60px #000e, 0 0 60px #8a4dff44; text-align: center; }
		#void-card .x { position: absolute; top: 8px; right: 10px; border: 0; background: none; color: var(--v-dim); font-size: 18px; cursor: pointer; }
		#void-card .org { font: 600 12px Georgia, serif; letter-spacing: 4px; text-transform: uppercase; color: var(--v-dim); }
		#void-card .pic { width: 120px; height: 120px; margin: 12px auto 10px; border-radius: 50%; border: 2px solid #9b6bff; background: #05020a center/cover no-repeat;
			display: flex; align-items: center; justify-content: center; font-size: 48px; color: #6a4aa0; box-shadow: 0 0 30px #8a4dff55; }
		#void-card .nm { font: 600 22px Georgia, serif; color: #fff; }
		#void-card .num { color: var(--v-dim); font-size: 12px; }
		#void-card .rk { margin-top: 8px; font: 600 16px Georgia, serif; letter-spacing: 1px; }
		#void-card .ttl { margin-top: 2px; font-style: italic; color: #d9c8ff; }
		#void-card .bio { margin-top: 10px; white-space: pre-wrap; font-size: 13px; color: #d6cdee; }
		#void-card .foot { margin-top: 12px; font-size: 11px; color: var(--v-dim); border-top: 1px solid #ffffff14; padding-top: 8px; }
		.void-toast { position: fixed; z-index: 2147483003; right: 16px; width: 300px; padding: 10px 14px; border-radius: 12px; cursor: pointer;
			border: 1px solid #7a52c4; background: #12091fee; box-shadow: 0 8px 30px #000c; transition: opacity .4s; }
		#void-tab { position: fixed; z-index: 2147483000; left: 0; top: 50%; transform: translateY(-50%); width: 26px; height: 54px; border: 1px solid #5b3d8f; border-left: 0;
			border-radius: 0 10px 10px 0; background: #12091fdd; color: #c9a8ff; font: 600 16px Georgia, serif; cursor: pointer; padding: 0; text-shadow: 0 0 8px #9b59ff; }
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
		const rk = make('div', 'rk', c.founder ? `✠ ${rankLabel(c.rank)} ✠` : rankLabel(c.rank));
		if (c.rank && /^#[0-9a-fA-F]{6}$/.test(c.rank.color)) {
			rk.style.color = c.rank.color;
		}
		card.append(
			x,
			make('div', 'org', c.order || 'The Void Order'),
			pic,
			make('div', 'nm', c.name),
			make('div', 'num', `Member #${c.n}`),
			rk,
		);
		if (c.founder) {
			card.append(make('div', 'ttl', 'Founder of the Order'));
		}
		if (c.title) {
			card.append(make('div', 'ttl', c.title));
		}
		if (c.bio) {
			card.append(make('div', 'bio', c.bio));
		}
		card.append(make('div', 'foot', `${fromRoom ? 'Shown in this room · ' : ''}In the Order since ${date(c.joined)}`));
		document.body.append(card);
	}
	/** Looks up a member's card on the server and opens it. */
	async function openCard(/** @type {number} */ n) {
		const r = await req({ t: 'card', member: n });
		if (r.t === 'card' && r.card) {
			showCard(r.card);
		} else {
			panelSay(r.why || `#${n} is not in the Order.`);
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
		w.ServerSend('ChatRoomChat', { Content: HIDDEN, Type: 'Hidden', Dictionary: [{ voidOrder: VERSION, card: true }] });
		return '';
	}
	/** A hidden Void Order note in the room: someone showing their card. The card comes from the server, not the note. */
	function onRoomMessage(/** @type {any} */ data, /** @type {any} */ sender) {
		guard(() => {
			if (!data || data.Type !== 'Hidden' || data.Content !== HIDDEN || !sender || !sender.MemberNumber) {
				return;
			}
			const d = Array.isArray(data.Dictionary) ? data.Dictionary[0] : null;
			if (!d || d.card !== true || !ws || !state || !pref('roomCards', true)) {
				return;
			}
			const n = sender.MemberNumber;
			cardWanted.add(n);
			ws.send(JSON.stringify({ t: 'card', member: n }));
			setTimeout(() => cardWanted.delete(n), 10000);
		});
		return false;
	}

	// ---- The panel
	let tab = 'orders';
	/** Unsaved form text, kept across re-renders. */
	const drafts = {};
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
	/** The tabs you have, in order. */
	function tabs() {
		if (!isMember()) {
			return [['join', state && state.meta ? 'The Order' : 'Found']];
		}
		/** @type {[string, string][]} */
		const t = [
			['orders', 'Orders'],
			['members', 'Members'],
			['order', 'The Order'],
		];
		if (may('approve')) {
			t.push(['apps', 'Applications']);
		}
		if (may('manage')) {
			t.push(['manage', 'Manage']);
		}
		t.push(['me', 'My card']);
		return t;
	}
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
			active.addEventListener('blur', () => setTimeout(() => render(), 0), { once: true });
			return;
		}
		const main = p.querySelector('main');
		const scroll = main ? main.scrollTop : 0;
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
			const count = id === 'orders' ? openOrders() : id === 'apps' && state.apps ? state.apps.length : 0;
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
		if (list.length > 1) {
			p.append(nav);
		}
		const body = make('main');
		guard(() => {
			if (!state) {
				body.append(make('p', 'dim', ws ? 'Signing in…' : 'Connecting to the Order…'));
			} else {
				({ orders: drawOrders, members: drawMembers, order: drawOrder, apps: drawApps, manage: drawManage, me: drawMe, join: drawJoin })[
					tab
				](body);
			}
		}, panelSay);
		const msg = make('div', 'msg', lastMsg);
		body.append(msg);
		p.append(body);
		body.scrollTop = scroll;
		drawTab();
	}
	const openOrders = () => [...orders.values()].filter(waitsForMe).length;
	function statusLine() {
		if (!state) {
			return 'offline';
		}
		if (isMember()) {
			const r = rankOf(state.me.rank);
			return `${state.meta && state.meta.founder === state.me.n ? 'Founder · ' : ''}${rankLabel(r)}`;
		}
		return { guest: 'Not a member', applied: 'Application sent', mismatch: 'Key not recognised' }[state.status] || '';
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
	const forget = (/** @type {string} */ prefix) => {
		for (const k of Object.keys(drafts)) {
			if (k.startsWith(prefix)) {
				delete drafts[k];
			}
		}
	};
	const label = (/** @type {string} */ text) => make('label', '', text);

	// -- Orders
	function drawOrders(/** @type {HTMLElement} */ body) {
		if (may('order')) {
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
	/** Who an order goes to, in words. */
	function toWords(/** @type {any} */ to) {
		if (to.all) {
			return 'everyone';
		}
		const parts = [
			...(to.ranks || []).map((/** @type {string} */ id) => rankOf(id)?.name || 'a removed rank'),
			...(to.members || []).map((/** @type {number} */ n) => memberOf(n)?.name || `#${n}`),
		];
		return parts.join(', ');
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
		const me = state.me;
		const author = memberOf(o.by);
		if (o.by === me.n || (may('order') && (author ? aboveMe(author) : may('manage')))) {
			row.append(
				button(
					'Take down',
					() => {
						if (drafts[`del${o.id}`]) {
							return act({ t: 'unorder', id: o.id });
						}
						drafts[`del${o.id}`] = '1';
						panelSay(`Click "Take down" again to remove "${o.title}" for everyone.`);
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
	/** The answers to an order, for its author and those above them. */
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
	function drawNewOrder() {
		const box = make('div', 'box');
		if (!drafts.newOpen) {
			box.append(
				button('＋ New order, session or notice', () => {
					drafts.newOpen = '1';
					render(true);
				}),
			);
			return box;
		}
		const kind = drafts.nKind || 'order';
		const kinds = make('div', 'row');
		for (const k of ['order', 'session', 'notice']) {
			const b = button(`${KIND_ICON[k]} ${KIND_NAME[k]}`, () => {
				drafts.nKind = k;
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
			field('nTitle', '', LIMITS.orderTitle),
			label('Details'),
			field('nBody', '', LIMITS.orderText, 'textarea'),
		);
		if (kind === 'session') {
			const when = field('nWhen', '', 20);
			when.type = 'datetime-local';
			box.append(label('When (your time)'), when);
		}
		// Who it goes to: everyone, ranks, or members.
		box.append(label('For'));
		const to = drafts.nTo || 'all';
		const pickTo = make('div', 'row');
		for (const [k, text] of [
			['all', 'Everyone'],
			['ranks', 'Ranks'],
			['members', 'Members'],
		]) {
			const b = button(text, () => {
				drafts.nTo = k;
				render(true);
			});
			if (k === to) {
				b.classList.add('on');
			}
			pickTo.append(b);
		}
		box.append(pickTo);
		const chosen = new Set(
			String(drafts[`nPick_${to}`] || '')
				.split(',')
				.filter(Boolean),
		);
		if (to !== 'all') {
			const pick = make('div', 'pick');
			const items =
				to === 'ranks'
					? state.ranks.map((/** @type {any} */ r) => [r.id, rankLabel(r)])
					: state.members.filter((/** @type {any} */ m) => m.n !== state.me.n).map((/** @type {any} */ m) => [String(m.n), m.name]);
			for (const [id, text] of items) {
				const b = button(text, () => {
					if (chosen.has(id)) {
						chosen.delete(id);
					} else {
						chosen.add(id);
					}
					drafts[`nPick_${to}`] = [...chosen].join(',');
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
					const dest = to === 'all' ? { all: true } : to === 'ranks' ? { ranks: [...chosen] } : { members: [...chosen].map(Number) };
					const when = kind === 'session' ? new Date(drafts.nWhen || '').getTime() : undefined;
					if (kind === 'session' && !(when > Date.now())) {
						panelSay('⚠ Pick when the session is, in the future.');
						return;
					}
					return act({ t: 'order', kind, title: drafts.nTitle || '', body: drafts.nBody || '', to: dest, when }, () => {
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

	// -- Members
	function drawMembers(/** @type {HTMLElement} */ body) {
		const on = state.members.filter((/** @type {any} */ m) => m.on).length;
		body.append(make('p', 'dim', `${state.members.length} members, ${on} online. Click someone for their ID card.`));
		const founder = state.meta.founder;
		/** @type {[any, any[]][]} */
		const groups = state.ranks.map((/** @type {any} */ r) => [r, []]);
		const loose = [];
		for (const m of [...state.members].sort(
			(a, b) => (b.n === founder ? 1 : 0) - (a.n === founder ? 1 : 0) || (b.on ? 1 : 0) - (a.on ? 1 : 0) || a.name.localeCompare(b.name),
		)) {
			const g = groups.find(([r]) => r.id === m.rank);
			(g ? g[1] : loose).push(m);
		}
		for (const [r, list] of groups) {
			if (!list.length) {
				continue;
			}
			const h = make('div', 'rank', `${rankLabel(r)} · ${list.length}`);
			h.style.color = r.color;
			body.append(h);
			for (const m of list) {
				body.append(drawMemberRow(m));
			}
		}
		for (const m of loose) {
			body.append(drawMemberRow(m));
		}
	}
	function drawMemberRow(/** @type {any} */ m) {
		const row = make('div', 'member');
		row.append(make('span', `dot${m.on ? ' on' : ''}`));
		const name = make('span', 'grow');
		name.append(make('span', '', m.name), make('span', 'dim', ` #${m.n}`));
		if (m.title) {
			name.append(make('span', 'dim', ` · ${m.title}`));
		}
		row.append(name);
		if (m.n === state.meta.founder) {
			row.append(make('span', 'tag', 'Founder'));
		}
		if (m.on && m.room) {
			row.append(make('span', 'tag', `📍 ${m.room}`));
		}
		row.addEventListener('click', () => guard(() => openCard(m.n), panelSay));
		return row;
	}

	// -- The Order: about, the heads, and leaving
	function drawOrder(/** @type {HTMLElement} */ body) {
		const meta = state.meta;
		body.append(make('h3', '', 'About'));
		body.append(make('p', '', meta.about || 'No about text yet.'));
		body.append(make('p', 'dim', `Founded ${date(meta.founded)}. Applications are ${meta.open ? 'open' : 'closed'}.`));
		body.append(make('h3', '', 'The ladder'));
		for (const [i, r] of state.ranks.entries()) {
			const line = make('div', 'row');
			const n = make('span', '', rankLabel(r));
			n.style.color = r.color;
			n.style.fontFamily = 'Georgia, serif';
			const can = r.perms.map((/** @type {string} */ p) => ({ approve: 'approves members', order: 'gives orders', manage: 'manages' })[p]);
			line.append(make('span', 'dim', `${i + 1}.`), n, make('span', 'dim', can.length ? `— ${can.join(', ')}` : ''));
			body.append(line);
		}
		if (meta.founder !== state.me.n) {
			body.append(make('h3', '', 'Leave'));
			body.append(
				button(
					'Leave the Order',
					() => {
						if (drafts.leave) {
							return act({ t: 'leave' });
						}
						drafts.leave = '1';
						panelSay('Click again to leave. Getting back in takes a new application.');
					},
					'b bad',
				),
			);
		}
	}

	// -- Joining (and founding, and lost keys)
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
					'You are the founder. Name the Order to start; ranks, the about page and the joining questions come next, under Manage.',
				),
			);
			body.append(
				label('Name'),
				field('fName', 'The Void Order', LIMITS.name),
				label('About'),
				field('fAbout', '', LIMITS.about, 'textarea'),
			);
			body.append(
				button(
					'Found the Order',
					() =>
						act({ t: 'found', name: drafts.fName || 'The Void Order', about: drafts.fAbout || '', myName: nick(w.Player) }, () =>
							forget('f'),
						),
					'b main',
				),
			);
			return;
		}
		const meta = state.meta;
		body.append(make('h3', '', 'About'), make('p', '', meta.about || ''));
		body.append(make('p', 'dim', `${state.count} members · founded ${date(meta.founded)}`));
		if (state.members.length) {
			body.append(make('h3', '', 'Heads of the Order'));
			for (const m of state.members) {
				const r = rankOf(m.rank);
				const line = make('div', 'member');
				const nm = make('span', 'grow', `${m.name} #${m.n}`);
				const rk = make('span', '', m.n === meta.founder ? `Founder · ${rankLabel(r)}` : rankLabel(r));
				if (r) {
					rk.style.color = r.color;
				}
				line.append(nm, rk);
				line.addEventListener('click', () => guard(() => openCard(m.n), panelSay));
				body.append(line);
			}
		}
		if (state.status === 'mismatch') {
			body.append(make('h3', '', 'Your key'));
			body.append(
				make(
					'p',
					'',
					'This member number is in the Order with a different key (another browser before the account synced, or a wiped account). Ask someone above you for a reset code and enter it here.',
				),
			);
			body.append(label('Reset code'), field('code', '', 10));
			body.append(
				button(
					'Use the code',
					() => {
						resetCode = String(drafts.code || '')
							.trim()
							.toUpperCase();
						forget('code');
						panelSay('Signing in with the code…');
						reconnect();
					},
					'b main',
				),
			);
			return;
		}
		if (state.status === 'applied') {
			body.append(make('h3', '', 'Your application'), make('p', '', `Sent ${dateTime(state.app.at)}. The hierarchy will look at it.`));
			for (const [i, q] of meta.questions.entries()) {
				body.append(make('div', 'dim', q), make('p', '', state.app.answers[i] || '—'));
			}
			body.append(button('Withdraw it', () => act({ t: 'withdraw' }), 'b bad'));
			return;
		}
		body.append(make('h3', '', 'Join'));
		if (!meta.open) {
			body.append(make('p', 'dim', 'Applications are closed right now.'));
			return;
		}
		for (const [i, q] of meta.questions.entries()) {
			body.append(label(q), field(`q${i}`, '', LIMITS.answer, 'textarea'));
		}
		body.append(
			button(
				'Apply',
				() =>
					act(
						{
							t: 'apply',
							name: nick(w.Player),
							answers: meta.questions.map((/** @type {string} */ _, /** @type {number} */ i) => drafts[`q${i}`] || ''),
						},
						() => {
							forget('q');
							render(true);
						},
					),
				'b main',
			),
		);
	}

	// -- Applications
	function drawApps(/** @type {HTMLElement} */ body) {
		const apps = state.apps || [];
		if (!apps.length) {
			body.append(make('p', 'dim', 'No applications waiting.'));
			return;
		}
		const ranks = givable();
		for (const a of apps) {
			const box = make('div', 'box');
			box.append(make('div', 'title', `${a.name} #${a.n}`), make('div', 'dim', `Applied ${dateTime(a.at)}`));
			for (const [i, q] of state.meta.questions.entries()) {
				box.append(make('div', 'dim', q), make('p', '', a.answers[i] || '—'));
			}
			const row = make('div', 'row');
			const sel = make('select');
			sel.style.width = 'auto';
			for (const r of [...ranks].reverse()) {
				const o = make('option', '', rankLabel(r));
				o.value = r.id;
				sel.append(o);
			}
			row.append(
				make('span', 'dim', 'Let in as'),
				sel,
				button('Let in', () => act({ t: 'approve', member: a.n, rank: sel.value }), 'b main'),
				button('Turn down', () => act({ t: 'reject', member: a.n }), 'b bad'),
			);
			box.append(row);
			body.append(box);
		}
	}

	// -- Manage: members below you, the about page, the ranks, the log
	function drawManage(/** @type {HTMLElement} */ body) {
		body.append(make('h3', '', 'Members below you'));
		const below = state.members
			.filter((/** @type {any} */ m) => aboveMe(m))
			.sort((/** @type {any} */ a, /** @type {any} */ b) => powerOf(a) - powerOf(b) || a.name.localeCompare(b.name));
		if (!below.length) {
			body.append(make('p', 'dim', 'Nobody is below you yet.'));
		}
		const ranks = givable();
		for (const m of below) {
			const box = make('div', 'box');
			const row = make('div', 'row');
			row.append(make('span', 'grow', `${m.name} #${m.n}`));
			const sel = make('select');
			sel.style.width = 'auto';
			for (const r of ranks) {
				const o = make('option', '', rankLabel(r));
				o.value = r.id;
				o.selected = r.id === m.rank;
				sel.append(o);
			}
			sel.addEventListener('change', () => guard(() => act({ t: 'rank', member: m.n, rank: sel.value }), panelSay));
			row.append(sel);
			box.append(row);
			const row2 = make('div', 'row');
			row2.style.marginTop = '6px';
			const title = field(`t${m.n}`, m.title || '', LIMITS.title);
			title.placeholder = 'Title (e.g. Keeper of Cameras)';
			title.style.flex = '1';
			title.style.width = 'auto';
			row2.append(
				title,
				button('Set title', () => act({ t: 'title', member: m.n, title: drafts[`t${m.n}`] ?? m.title }, () => forget(`t${m.n}`))),
				button('Reset code', () =>
					act({ t: 'reset', member: m.n }, (r) => {
						drafts[`code${m.n}`] = r.code;
						render(true);
					}),
				),
				button(
					'Remove',
					() => {
						if (drafts[`kick${m.n}`]) {
							return act({ t: 'kick', member: m.n });
						}
						drafts[`kick${m.n}`] = '1';
						panelSay(`Click "Remove" again to take ${m.name} out of the Order.`);
					},
					'b bad',
				),
			);
			box.append(row2);
			if (drafts[`code${m.n}`]) {
				box.append(
					make('div', 'dim', `Reset code for ${m.name}, valid 48 hours. They open /void and enter it:`),
					make('div', 'code', drafts[`code${m.n}`]),
				);
			}
			body.append(box);
		}

		// The about page and joining questions.
		const meta = state.meta;
		body.append(make('h3', '', 'About page and joining'));
		body.append(
			label('Name'),
			field('aName', meta.name, LIMITS.name),
			label('About'),
			field('aAbout', meta.about, LIMITS.about, 'textarea'),
		);
		body.append(
			label(`Joining questions, one per line (up to ${LIMITS.questions})`),
			field('aQs', meta.questions.join('\n'), LIMITS.questions * (LIMITS.question + 1), 'textarea'),
		);
		const open = make('label');
		const box = make('input');
		box.type = 'checkbox';
		box.checked = 'aOpen' in drafts ? drafts.aOpen === '1' : meta.open;
		box.addEventListener('change', () => {
			drafts.aOpen = box.checked ? '1' : '0';
		});
		open.append(box, document.createTextNode(' Applications open'));
		open.style.color = 'var(--v-text)';
		body.append(open);
		body.append(
			button(
				'Save the about page',
				() =>
					act(
						{
							t: 'about',
							name: drafts.aName ?? meta.name,
							about: drafts.aAbout ?? meta.about,
							questions: String(drafts.aQs ?? meta.questions.join('\n')).split('\n'),
							open: 'aOpen' in drafts ? drafts.aOpen === '1' : meta.open,
						},
						() => {
							forget('a');
							panelSay('Saved.');
						},
					),
				'b main',
			),
		);

		body.append(drawLadder());

		if (state.log && state.log.length) {
			body.append(make('h3', '', 'Recent changes'));
			for (const l of [...state.log].reverse()) {
				body.append(make('div', 'dim', `${dateTime(l.at)} — ${l.text}`));
			}
		}
	}
	/** The rank ladder editor: ranks at or above yours are shown but locked. */
	function drawLadder() {
		const wrap = make('div', 'ladder');
		wrap.append(make('h3', '', 'Ranks, top to bottom'));
		/** @type {any[]} */
		const ladder = drafts.ladder ? JSON.parse(drafts.ladder) : state.ranks.map((/** @type {any} */ r) => ({ ...r }));
		const save = () => {
			drafts.ladder = JSON.stringify(ladder);
		};
		const fixed = state.me.power + 1;
		for (const [i, r] of ladder.entries()) {
			const locked = i < fixed;
			const rk = make('div', 'rk');
			const name = make('input');
			name.value = r.name;
			name.maxLength = LIMITS.name;
			name.disabled = locked;
			name.addEventListener('input', () => {
				r.name = name.value;
				save();
			});
			const sym = make('input');
			sym.value = r.sym;
			sym.maxLength = 12;
			sym.placeholder = 'symbol';
			sym.disabled = locked;
			sym.addEventListener('input', () => {
				r.sym = sym.value;
				save();
			});
			const color = make('input');
			color.type = 'color';
			color.value = r.color;
			color.disabled = locked;
			color.addEventListener('input', () => {
				r.color = color.value;
				save();
			});
			const moves = make('div', 'row');
			if (!locked) {
				moves.append(
					button('↑', () => {
						if (i > fixed) {
							[ladder[i - 1], ladder[i]] = [ladder[i], ladder[i - 1]];
							save();
							render(true);
						}
					}),
					button('↓', () => {
						if (i < ladder.length - 1) {
							[ladder[i + 1], ladder[i]] = [ladder[i], ladder[i + 1]];
							save();
							render(true);
						}
					}),
					button(
						'✕',
						() => {
							ladder.splice(i, 1);
							save();
							render(true);
						},
						'b bad',
					),
				);
			} else {
				moves.append(make('span', 'dim', '🔒'));
			}
			rk.append(name, sym, color, moves);
			const perms = make('div', 'perms');
			for (const [p, text] of [
				['approve', 'approves members'],
				['order', 'gives orders'],
				['manage', 'manages'],
			]) {
				const l = make('label');
				const c = make('input');
				c.type = 'checkbox';
				c.checked = r.perms.includes(p);
				c.disabled = locked;
				c.addEventListener('change', () => {
					r.perms = c.checked ? [...new Set([...r.perms, p])] : r.perms.filter((/** @type {string} */ x) => x !== p);
					save();
				});
				l.append(c, document.createTextNode(text));
				perms.append(l);
			}
			rk.append(perms);
			wrap.append(rk);
		}
		const row = make('div', 'row');
		row.append(
			button('＋ Add a rank', () => {
				ladder.push({ id: '', name: 'New rank', sym: '', color: '#8f86b8', perms: [] });
				save();
				render(true);
			}),
			button('Save ranks', () => act({ t: 'ranks', ranks: ladder }, () => forget('ladder')), 'b main'),
			button('Undo changes', () => {
				forget('ladder');
				render(true);
			}),
		);
		wrap.append(row);
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
		body.append(label(`Bio (up to ${LIMITS.bio} characters)`), field('bio', me.bio, LIMITS.bio, 'textarea'));
		body.append(button('Save bio', () => act({ t: 'profile', bio: drafts.bio ?? me.bio }, () => forget('bio')), 'b main'));
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

		body.append(make('h3', '', 'Settings (this browser)'));
		for (const [k, text, dflt] of [
			['shareRoom', 'Show the Order which public room I am in', true],
			['roomCards', 'Open ID cards people show in my room', true],
			['sideTab', 'Show the ⸸ tab on the left of the screen', true],
		]) {
			const l = make('label');
			const c = make('input');
			c.type = 'checkbox';
			c.checked = pref(String(k), dflt);
			c.addEventListener('change', () => {
				setPref(String(k), c.checked);
				roomTick(true);
				drawTab();
			});
			l.append(c, document.createTextNode(` ${text}`));
			l.style.color = 'var(--v-text)';
			body.append(l);
		}
		body.append(make('p', 'dim', `Void Order ${VERSION}. /void opens this panel; /void card <member number> opens someone's card.`));
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
			drawTab();
		});
	}

	/** /void, /void card <member number>, /void id */
	function command(/** @type {string} */ text) {
		const [sub, arg] = String(text || '')
			.trim()
			.split(/\s+/);
		if (sub === 'card') {
			const n = Number(arg);
			if (!Number.isInteger(n) || n <= 0) {
				note('Use /void card <member number>.');
				return;
			}
			req({ t: 'card', member: n }).then((r) => (r.card ? showCard(r.card) : note(r.why || `#${n} is not in the Order.`)));
			return;
		}
		if (sub === 'id') {
			const why = showMyIdInRoom();
			if (why) {
				note(why);
			}
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
					Description: ': The Void Order (orders, members, ID cards). /void card <number>, /void id',
					Action: (/** @type {string} */ args) => guard(() => command(args)),
				},
			]);
			if (typeof w.ChatRoomRegisterMessageHandler === 'function') {
				w.ChatRoomRegisterMessageHandler({ Description: 'The Void Order ID cards', Priority: -150, Callback: onRoomMessage });
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
			connect();
			setInterval(tick, 2000);
		});
	}, 500);
})();
