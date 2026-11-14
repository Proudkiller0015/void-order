/**
 * The Void Order server: a Cloudflare Worker with one Durable Object holding the whole Order.
 *
 * Storage: 'meta' { name, about, questions, open, founded, founder }, 'ranks' (top to bottom, see Rank),
 * 'm:<member number>' members, 'a:<member number>' applications, 'pic:<member number>' pictures,
 * 'o:<id>' orders (the newest LIMITS.orders kept), 'log' (the newest LIMITS.log changes) and 'seq'.
 *
 * Clients sign in by signing a one-time nonce with their P-256 key. A member number is bound to the key it
 * applied with. A member who lost their key gets a reset code from someone above them, and the next key that
 * signs in with that code takes the number over. Only env.FOUNDER can found the Order.
 *
 * The hierarchy: ranks go top to bottom, and the founder stands above every rank. You only act on members
 * strictly below you, and only give ranks strictly below your own. What a rank may do is its `perms`:
 * approve (applications), order (post orders, sessions and notices) and manage (ranks, titles, kicks,
 * reset codes, the about page).
 *
 * Free-plan limits: sockets hibernate and keep-alive pings get an auto-response without waking the object.
 */

import { DurableObject } from 'cloudflare:workers';

const LIMITS = {
	/** Longest Order, member or rank name. */
	name: 40,
	/** Longest rank symbol. */
	sym: 12,
	/** Longest title a member is given. */
	title: 40,
	/** Longest bio. */
	bio: 300,
	/** Longest about text. */
	about: 2000,
	/** Most joining questions, the longest question and the longest answer. */
	questions: 8,
	question: 200,
	answer: 500,
	/** Most ranks. */
	ranks: 20,
	/** Most members, and most applications waiting. */
	members: 500,
	apps: 100,
	/** Longest order title and text, and orders kept. */
	orderTitle: 80,
	orderText: 1500,
	orders: 300,
	/** Most member numbers or ranks one order goes to. */
	orderTo: 50,
	/** Changes kept in the log. */
	log: 200,
	/** Longest picture data URL. */
	pic: 12000,
	/** Longest room name. */
	room: 40,
	/** Most messages per connection in 10 s. */
	burst: 30,
	/** Most open connections. */
	sockets: 400,
	/** Hours a reset code stays valid. */
	resetHours: 48,
};
const PERMS = ['approve', 'order', 'manage'];
const KINDS = ['order', 'session', 'notice'];
/** What an order can be answered with, by kind. */
const ACKS = { order: ['read', 'done'], session: ['yes', 'maybe', 'no'], notice: ['read'] };
/** A picture: an image data URL only. */
const PIC_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
/** A base64url key coordinate or signature. */
const B64URL = /^[A-Za-z0-9_-]{16,128}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-Z2-9]{10}$/;
/** Page origins allowed to connect: the game's sites (see the SlimeBeep relay), and localhost for tests. */
const ORIGINS = [
	/^https?:\/\/([a-z0-9-]+\.)*bondageprojects\.elementfx\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondageprojects\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondage-?europe\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondage-asia\.com$/,
	/^http:\/\/localhost(:\d+)?$/,
	/^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/**
 * @typedef {object} Rank
 * @property {string} id
 * @property {string} name
 * @property {string} sym shown either side of the name, like ≈][≈
 * @property {string} color
 * @property {string[]} perms
 */

/** A plausible member number. */
const isNum = (n) => Number.isInteger(n) && n > 0 && n < 1e9;
/** A string with control characters removed, trimmed and cut to `max`; '' for anything else. */
const clean = (x, max) =>
	typeof x === 'string'
		? x
				// eslint-disable-next-line no-control-regex -- removing control characters is the point
				.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
				.trim()
				.slice(0, max)
		: '';
/** A random string from `abc`. */
const randomOf = (abc, len) => {
	const a = new Uint8Array(len);
	crypto.getRandomValues(a);
	return [...a].map((x) => abc[x % abc.length]).join('');
};
/** A reset code: 10 characters with no look-alike letters. */
const newCode = () => randomOf('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);
const newRankId = () => randomOf('abcdefghijklmnopqrstuvwxyz0123456789', 6);
const b64url = (buf) =>
	btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
const unb64url = (s) =>
	Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
/** Whether two public keys are the same. */
const samePub = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
/** The storage key of an order: padded so they list in order. */
const orderKey = (id) => `o:${String(id).padStart(10, '0')}`;

/** Verifies an ECDSA P-256 / SHA-256 signature (base64url r||s) of `text`. */
async function verify(pub, sig, text) {
	try {
		const key = await crypto.subtle.importKey(
			'jwk',
			{ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, ext: true },
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);
		return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(sig), new TextEncoder().encode(text));
	} catch (e) {
		return false;
	}
}

/**
 * Whether a request carries the operator key (the OPERATOR_KEY secret, as `Authorization: Bearer <key>`).
 * Without that secret set, nothing is the operator.
 */
async function isOperator(req, env) {
	const key = env.OPERATOR_KEY;
	const got = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
	if (typeof key !== 'string' || key.length < 32 || !got) {
		return false;
	}
	const hash = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
	return crypto.subtle.timingSafeEqual(await hash(key), await hash(got));
}

export default {
	/**
	 * Checks the origin and hands the WebSocket (/ws) to the Order. Also takes the operator's POST /op/reset
	 * { member }: a reset code for a member who lost their key when nobody above them can make one (the founder).
	 */
	async fetch(req, env) {
		const url = new URL(req.url);
		// The test server runs a fresh Order per test run (?o=).
		const name =
			env.ALLOW_ANY_ORIGIN === '1' && /^[a-z0-9]{1,24}$/.test(url.searchParams.get('o') || '') ? url.searchParams.get('o') : 'void';
		const order = env.ORDER.get(env.ORDER.idFromName(name));
		if (url.pathname === '/') {
			return new Response('The Void Order', { headers: { 'content-type': 'text/plain' } });
		}
		if (url.pathname === '/op/reset' && req.method === 'POST') {
			if (!(await isOperator(req, env))) {
				return new Response('Not found', { status: 404 });
			}
			const p = await req.json().catch(() => ({}));
			if (!isNum(p.member)) {
				return new Response('Bad member number', { status: 400 });
			}
			return order.opReset(p.member);
		}
		if (url.pathname !== '/ws') {
			return new Response('Not found', { status: 404 });
		}
		if (req.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected a WebSocket', { status: 426 });
		}
		const origin = req.headers.get('Origin') || '';
		// ALLOW_ANY_ORIGIN is set only by the local test server.
		if (env.ALLOW_ANY_ORIGIN !== '1' && !ORIGINS.some((re) => re.test(origin))) {
			return new Response('Forbidden', { status: 403 });
		}
		return order.fetch(req);
	},
};

/**
 * The Order. Who is online, and in which room, lives on the connections, not in storage.
 */
export class Order extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
		ctx.blockConcurrencyWhile(async () => {
			this.meta = (await ctx.storage.get('meta')) || null;
			/** @type {Rank[]} */
			this.ranks = (await ctx.storage.get('ranks')) || [];
			this.members = {};
			for (const m of (await ctx.storage.list({ prefix: 'm:' })).values()) {
				this.members[m.n] = m;
			}
			this.apps = {};
			for (const a of (await ctx.storage.list({ prefix: 'a:' })).values()) {
				this.apps[a.n] = a;
			}
			this.orders = new Map();
			for (const o of (await ctx.storage.list({ prefix: 'o:' })).values()) {
				this.orders.set(o.id, o);
			}
			this.seq = (await ctx.storage.get('seq')) || 0;
			this.log = (await ctx.storage.get('log')) || [];
		});
	}

	/** The member number allowed to found the Order. */
	get founderNumber() {
		return Number(this.env.FOUNDER) || 0;
	}

	// ---- The hierarchy
	/** A member's place: -1 for the founder, else their rank's index (0 at the top); Infinity for non-members. */
	power(n) {
		const m = this.members[n];
		if (!m) {
			return Infinity;
		}
		if (this.meta && this.meta.founder === n) {
			return -1;
		}
		const i = this.ranks.findIndex((r) => r.id === m.rank);
		return i < 0 ? this.ranks.length : i;
	}
	/** Whether member `n` may do `perm` (the founder may do everything). */
	may(n, perm) {
		const m = this.members[n];
		if (!m) {
			return false;
		}
		if (this.meta && this.meta.founder === n) {
			return true;
		}
		const r = this.ranks.find((x) => x.id === m.rank);
		return !!r && r.perms.includes(perm);
	}
	/** Whether `by` stands strictly above member `n`. */
	above(by, n) {
		return this.power(by) < this.power(n);
	}
	/** Whether `by` may give rank `id`: one strictly below their own (the founder gives any). */
	mayGive(by, id) {
		const i = this.ranks.findIndex((r) => r.id === id);
		return i >= 0 && i > this.power(by);
	}
	/** The lowest rank, which new members get unless the approver picks another. */
	get lowest() {
		return this.ranks[this.ranks.length - 1];
	}

	// ---- Saving
	async putMember(n) {
		const m = this.members[n];
		if (m) {
			await this.ctx.storage.put(`m:${n}`, m);
		} else {
			await this.ctx.storage.delete([`m:${n}`, `pic:${n}`]);
		}
	}
	async putApp(n) {
		if (this.apps[n]) {
			await this.ctx.storage.put(`a:${n}`, this.apps[n]);
		} else {
			await this.ctx.storage.delete(`a:${n}`);
		}
	}
	/** Adds a line to the log (kept for those who manage). */
	async note(by, text) {
		this.log.push({ at: Date.now(), by, text });
		if (this.log.length > LIMITS.log) {
			this.log.splice(0, this.log.length - LIMITS.log);
		}
		await this.ctx.storage.put('log', this.log);
	}
	/** A member's name for the log. */
	nameOf(n) {
		const m = this.members[n] || this.apps[n];
		return m ? `${m.name} (${n})` : `#${n}`;
	}

	/**
	 * A reset code for a member, made by the operator (see the Worker's fetch): for the founder, who has nobody
	 * above them to make one.
	 * @returns {Promise<Response>}
	 */
	async opReset(member) {
		const m = this.members[member];
		if (!m) {
			return new Response('Not a member', { status: 404 });
		}
		m.reset = { code: newCode(), exp: Date.now() + LIMITS.resetHours * 36e5 };
		await this.putMember(member);
		await this.note(0, `The operator made a reset code for ${this.nameOf(member)}`);
		return Response.json({ code: m.reset.code });
	}

	// ---- Connections
	/** Accepts a WebSocket and sends it a sign-in nonce. */
	async fetch() {
		if (this.ctx.getWebSockets().length >= LIMITS.sockets) {
			return new Response('Busy', { status: 503 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
		server.serializeAttachment({ nonce, member: 0, pub: null, hits: [], room: '' });
		server.send(JSON.stringify({ t: 'hello', nonce }));
		return new Response(null, { status: 101, webSocket: client });
	}

	send(ws, x) {
		try {
			ws.send(JSON.stringify(x));
		} catch (e) {
			/* gone */
		}
	}
	/** Sends an error and closes the connection. */
	fail(ws, why) {
		this.send(ws, { t: 'error', why });
		try {
			ws.close(4000, why.slice(0, 100));
		} catch (e) {
			/* gone */
		}
	}
	/** Answers a request with an error, keeping the connection. */
	no(ws, why, p) {
		this.send(ws, { t: 'error', why, ...(p && typeof p.rid === 'number' ? { rid: p.rid } : {}) });
	}
	/** Answers a request as done. */
	ok(ws, p, extra = {}) {
		this.send(ws, { t: 'ok', what: p.t, ...(typeof p.rid === 'number' ? { rid: p.rid } : {}), ...extra });
	}
	/** The signed-in connections with their attachments. */
	sockets() {
		return this.ctx.getWebSockets().flatMap((ws) => {
			const a = ws.deserializeAttachment();
			return a && a.member ? [{ ws, a }] : [];
		});
	}

	/**
	 * What a connection is to the Order: 'member', 'applied' (an application with this key is waiting), 'mismatch'
	 * (the number is a member or applicant with another key) or 'guest'.
	 */
	statusOf(a) {
		const m = this.members[a.member];
		if (m) {
			return samePub(m.pub, a.pub) ? 'member' : 'mismatch';
		}
		const app = this.apps[a.member];
		if (app) {
			return samePub(app.pub, a.pub) ? 'applied' : 'mismatch';
		}
		return 'guest';
	}

	/** Who is online: member number -> the room they show (or ''). */
	online() {
		/** @type {Record<number, string>} */
		const on = {};
		for (const { a } of this.sockets()) {
			if (this.statusOf(a) === 'member') {
				on[a.member] = on[a.member] || a.room || '';
			}
		}
		return on;
	}

	/** A member as others see them in the list (no picture: cards carry that). */
	listed(m, on) {
		return {
			n: m.n,
			name: m.name,
			rank: m.rank,
			title: m.title || '',
			joined: m.joined,
			pv: m.pv || 0,
			...(m.n in on ? { on: 1, room: on[m.n] } : {}),
		};
	}

	/** The state one connection sees: everything for members, the about page and the heads for everyone else. */
	stateFor(a, on = this.online()) {
		const status = this.statusOf(a);
		const meta = this.meta
			? {
					name: this.meta.name,
					about: this.meta.about,
					questions: this.meta.questions,
					open: this.meta.open,
					founded: this.meta.founded,
					founder: this.meta.founder,
				}
			: null;
		/** @type {Record<string, any>} */
		const s = { t: 'state', status, member: a.member, meta, ranks: this.ranks, canFound: !this.meta && a.member === this.founderNumber };
		const all = Object.values(this.members);
		if (status === 'member') {
			const me = this.members[a.member];
			s.me = { ...this.listed(me, on), bio: me.bio || '', power: this.power(a.member), perms: PERMS.filter((p) => this.may(a.member, p)) };
			s.members = all.map((m) => this.listed(m, on));
			if (this.may(a.member, 'approve')) {
				s.apps = Object.values(this.apps).map((x) => ({ n: x.n, name: x.name, answers: x.answers, at: x.at }));
			}
			if (this.may(a.member, 'manage')) {
				s.log = this.log.slice(-50);
			}
		} else {
			// Guests see who leads: the founder and the top rank.
			const top = this.ranks[0] && this.ranks[0].id;
			s.members = all.filter((m) => this.meta && (m.n === this.meta.founder || m.rank === top)).map((m) => this.listed(m, {}));
			s.count = all.length;
			if (status === 'applied') {
				const app = this.apps[a.member];
				s.app = { answers: app.answers, at: app.at };
			}
		}
		return s;
	}

	/** Sends every connection its state (after any change to the Order). */
	broadcast() {
		const on = this.online();
		for (const { ws, a } of this.sockets()) {
			this.send(ws, this.stateFor(a, on));
		}
	}

	// ---- Orders
	/** Whether member `n` is one an order goes to. */
	isFor(o, n) {
		const m = this.members[n];
		if (!m) {
			return false;
		}
		return o.to.all === true || (o.to.ranks || []).includes(m.rank) || (o.to.members || []).includes(n);
	}
	/** Whether member `n` oversees an order: they stand above its author (or manage, once its author is gone). */
	oversees(o, n) {
		return this.members[o.by] ? this.above(n, o.by) : this.may(n, 'manage');
	}
	/** Whether member `n` sees an order: it goes to them, they wrote it, or they oversee it. */
	sees(o, n) {
		return !!this.members[n] && (o.by === n || this.isFor(o, n) || this.oversees(o, n));
	}
	/** An order as member `n` sees it: everyone's answers only for its author and those who oversee it. */
	orderFor(o, n) {
		const full = o.by === n || this.oversees(o, n);
		const { acks, ...rest } = o;
		return { ...rest, ...(full ? { acks } : { mine: acks[n] || null }) };
	}
	/** Sends an order, new or changed, to every connection that sees it. */
	pushOrder(o) {
		for (const { ws, a } of this.sockets()) {
			if (this.statusOf(a) === 'member' && this.sees(o, a.member)) {
				this.send(ws, { t: 'order', o: this.orderFor(o, a.member) });
			}
		}
	}
	/** The orders member `n` sees, newest first. */
	ordersOf(n) {
		return [...this.orders.values()]
			.filter((o) => this.sees(o, n))
			.reverse()
			.map((o) => this.orderFor(o, n));
	}

	/**
	 * A client message (JSON with `t`). Before sign-in only 'auth'. Members: 'profile', 'card', 'orders', 'ack',
	 * 'room', 'leave', and with rights 'approve', 'reject', 'rank', 'title', 'kick', 'reset', 'about', 'ranks',
	 * 'order', 'unorder', 'founder'. Guests: 'card', 'apply', 'withdraw', 'room', and 'found' for the founder.
	 * A request may carry a number `rid`, sent back with its 'ok' or 'error'.
	 */
	async webSocketMessage(ws, raw) {
		const a = ws.deserializeAttachment();
		let p = {};
		try {
			if (typeof raw !== 'string' || raw.length > 20000) {
				return this.fail(ws, 'too big');
			}
			const now = Date.now();
			a.hits = (a.hits || []).filter((t) => now - t < 10000);
			a.hits.push(now);
			ws.serializeAttachment(a);
			try {
				p = JSON.parse(raw);
			} catch (e) {
				return this.fail(ws, 'not JSON');
			}
			if (a.hits.length > LIMITS.burst) {
				return this.no(ws, 'slow down', p);
			}
			if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.t !== 'string') {
				return this.fail(ws, 'bad message');
			}
			if (!a.member) {
				return p.t === 'auth' ? await this.auth(ws, a, p) : this.fail(ws, 'sign in first');
			}
			const status = this.statusOf(a);
			const me = a.member;
			// Anyone signed in.
			switch (p.t) {
				case 'card':
					return this.card(ws, p);
				case 'room':
					return this.setRoom(ws, a, p);
			}
			if (status !== 'member') {
				switch (p.t) {
					case 'found':
						return await this.found(ws, a, p);
					case 'apply':
						return await this.apply(ws, a, p);
					case 'withdraw':
						return await this.withdraw(ws, a, p);
					default:
						return this.no(ws, status === 'mismatch' ? 'signed in with another key' : 'not a member', p);
				}
			}
			switch (p.t) {
				case 'orders':
					return this.send(ws, { t: 'orders', orders: this.ordersOf(me) });
				case 'profile':
					return await this.profile(ws, me, p);
				case 'ack':
					return await this.ack(ws, me, p);
				case 'leave':
					return await this.leave(ws, me, p);
				case 'approve':
					return await this.approve(ws, me, p);
				case 'reject':
					return await this.reject(ws, me, p);
				case 'rank':
					return await this.setRank(ws, me, p);
				case 'title':
					return await this.setTitle(ws, me, p);
				case 'kick':
					return await this.kick(ws, me, p);
				case 'reset':
					return await this.reset(ws, me, p);
				case 'about':
					return await this.setAbout(ws, me, p);
				case 'ranks':
					return await this.setRanks(ws, me, p);
				case 'order':
					return await this.addOrder(ws, me, p);
				case 'unorder':
					return await this.unorder(ws, me, p);
				case 'founder':
					return await this.setFounder(ws, me, p);
				default:
					return this.no(ws, 'unknown', p);
			}
		} catch (e) {
			this.no(ws, 'server error', p);
		}
	}

	webSocketClose(ws) {
		this.gone(ws);
	}
	webSocketError(ws) {
		this.gone(ws);
	}
	/** A connection closed: if a member went offline, the others' lists change. */
	gone(ws) {
		const a = ws.deserializeAttachment();
		if (!a || !a.member || !this.members[a.member]) {
			return;
		}
		const still = this.sockets().some((x) => x.ws !== ws && x.a.member === a.member);
		if (!still) {
			// The closing socket is still listed until this returns.
			try {
				ws.serializeAttachment({ ...a, member: 0 });
			} catch (e) {
				/* closed */
			}
			this.broadcast();
		}
	}

	/** Sign-in: checks the signature, takes a reset code if one is sent, and answers with the state. */
	async auth(ws, a, p) {
		const member = p.member;
		if (!isNum(member) || !p.pub || !B64URL.test(p.pub.x || '') || !B64URL.test(p.pub.y || '') || !B64URL.test(p.sig || '')) {
			return this.fail(ws, 'bad sign-in');
		}
		const pub = { x: p.pub.x, y: p.pub.y };
		if (!(await verify(pub, p.sig, `${a.nonce}|void|${member}`))) {
			return this.fail(ws, 'bad signature');
		}
		a.member = member;
		a.pub = pub;
		a.room = clean(p.room, LIMITS.room);
		ws.serializeAttachment(a);
		const m = this.members[member];
		let changed = false;
		if (m && !samePub(m.pub, pub) && CODE_RE.test(p.code || '') && m.reset && m.reset.code === p.code && m.reset.exp > Date.now()) {
			// A reset code moves the number to this key.
			m.pub = pub;
			delete m.reset;
			await this.note(member, `${this.nameOf(member)} signed in with a new key (reset code)`);
			changed = true;
		}
		const name = clean(p.name, LIMITS.name);
		if (m && samePub(m.pub, pub) && name && name !== m.name) {
			m.name = name;
			changed = true;
		}
		if (changed) {
			await this.putMember(member);
		}
		if (m && samePub(m.pub, pub)) {
			this.broadcast();
		} else {
			this.send(ws, this.stateFor(a));
		}
		if (this.statusOf(a) === 'member') {
			this.send(ws, { t: 'orders', orders: this.ordersOf(member) });
		}
	}

	/** Founds the Order: only env.FOUNDER, once. Two ranks to start with, renamed and added to in the app. */
	async found(ws, a, p) {
		if (this.meta) {
			return this.no(ws, 'already founded', p);
		}
		if (a.member !== this.founderNumber) {
			return this.no(ws, 'only the founder can found the Order', p);
		}
		this.meta = {
			name: clean(p.name, LIMITS.name) || 'The Void Order',
			about: clean(p.about, LIMITS.about),
			questions: [],
			open: true,
			founded: Date.now(),
			founder: a.member,
		};
		this.ranks = [
			{ id: newRankId(), name: 'Head', sym: '', color: '#b48cff', perms: [...PERMS] },
			{ id: newRankId(), name: 'Member', sym: '', color: '#8f86b8', perms: [] },
		];
		this.members[a.member] = {
			n: a.member,
			name: clean(p.myName, LIMITS.name) || `#${a.member}`,
			pub: a.pub,
			rank: this.ranks[0].id,
			title: '',
			bio: '',
			joined: Date.now(),
		};
		delete this.apps[a.member];
		await this.ctx.storage.put({ meta: this.meta, ranks: this.ranks });
		await this.putMember(a.member);
		await this.putApp(a.member);
		await this.note(a.member, `${this.nameOf(a.member)} founded ${this.meta.name}`);
		this.ok(ws, p);
		this.broadcast();
		this.send(ws, { t: 'orders', orders: [] });
	}

	/** An application: the answers to the joining questions, bound to the key it is sent with. */
	async apply(ws, a, p) {
		if (!this.meta) {
			return this.no(ws, 'the Order is not founded yet', p);
		}
		if (!this.meta.open) {
			return this.no(ws, 'applications are closed', p);
		}
		const status = this.statusOf(a);
		if (status === 'mismatch') {
			return this.no(ws, 'signed in with another key', p);
		}
		if (status === 'guest' && Object.keys(this.apps).length >= LIMITS.apps) {
			return this.no(ws, 'too many applications are waiting, try again later', p);
		}
		if (Object.keys(this.members).length >= LIMITS.members) {
			return this.no(ws, 'the Order is full', p);
		}
		const answers = Array.isArray(p.answers) ? p.answers.slice(0, LIMITS.questions).map((x) => clean(x, LIMITS.answer)) : [];
		this.apps[a.member] = { n: a.member, name: clean(p.name, LIMITS.name) || `#${a.member}`, pub: a.pub, answers, at: Date.now() };
		await this.putApp(a.member);
		this.ok(ws, p);
		this.broadcast();
	}
	async withdraw(ws, a, p) {
		if (this.statusOf(a) !== 'applied') {
			return this.no(ws, 'no application', p);
		}
		delete this.apps[a.member];
		await this.putApp(a.member);
		this.ok(ws, p);
		this.broadcast();
	}

	/** Approves an application: the applicant joins with the rank picked (one below the approver), else the lowest. */
	async approve(ws, me, p) {
		if (!this.may(me, 'approve')) {
			return this.no(ws, 'not allowed', p);
		}
		const app = this.apps[p.member];
		if (!app) {
			return this.no(ws, 'no such application', p);
		}
		if (Object.keys(this.members).length >= LIMITS.members) {
			return this.no(ws, 'the Order is full', p);
		}
		const rank = p.rank || this.lowest.id;
		if (!this.mayGive(me, rank)) {
			return this.no(ws, 'you can only give ranks below your own', p);
		}
		this.members[app.n] = { n: app.n, name: app.name, pub: app.pub, rank, title: '', bio: '', joined: Date.now() };
		delete this.apps[app.n];
		await this.putMember(app.n);
		await this.putApp(app.n);
		await this.note(me, `${this.nameOf(me)} let ${this.nameOf(app.n)} in`);
		this.ok(ws, p);
		this.broadcast();
		for (const { ws: w, a } of this.sockets()) {
			if (a.member === app.n) {
				this.send(w, { t: 'orders', orders: this.ordersOf(app.n) });
			}
		}
	}
	async reject(ws, me, p) {
		if (!this.may(me, 'approve')) {
			return this.no(ws, 'not allowed', p);
		}
		const app = this.apps[p.member];
		if (!app) {
			return this.no(ws, 'no such application', p);
		}
		await this.note(me, `${this.nameOf(me)} turned down ${this.nameOf(app.n)}`);
		delete this.apps[app.n];
		await this.putApp(app.n);
		this.ok(ws, p);
		this.broadcast();
	}

	/** Checks that `me` manages and stands above member p.member; answers the error otherwise. */
	managed(ws, me, p) {
		if (!this.may(me, 'manage')) {
			this.no(ws, 'not allowed', p);
			return null;
		}
		const m = this.members[p.member];
		if (!m) {
			this.no(ws, 'no such member', p);
			return null;
		}
		if (!this.above(me, m.n)) {
			this.no(ws, 'they are not below you', p);
			return null;
		}
		return m;
	}
	async setRank(ws, me, p) {
		const m = this.managed(ws, me, p);
		if (!m) {
			return;
		}
		if (!this.mayGive(me, p.rank)) {
			return this.no(ws, 'you can only give ranks below your own', p);
		}
		m.rank = p.rank;
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} made ${this.nameOf(m.n)} ${this.ranks.find((r) => r.id === p.rank).name}`);
		this.ok(ws, p);
		this.broadcast();
	}
	async setTitle(ws, me, p) {
		const m = this.managed(ws, me, p);
		if (!m) {
			return;
		}
		m.title = clean(p.title, LIMITS.title);
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} gave ${this.nameOf(m.n)} the title "${m.title}"`);
		this.ok(ws, p);
		this.broadcast();
	}
	async kick(ws, me, p) {
		const m = this.managed(ws, me, p);
		if (!m) {
			return;
		}
		await this.note(me, `${this.nameOf(me)} removed ${this.nameOf(m.n)}`);
		delete this.members[m.n];
		await this.putMember(m.n);
		this.ok(ws, p);
		this.broadcast();
	}
	/** A reset code for a member below you who lost their key: they sign in with it from their new key. */
	async reset(ws, me, p) {
		const m = this.managed(ws, me, p);
		if (!m) {
			return;
		}
		m.reset = { code: newCode(), exp: Date.now() + LIMITS.resetHours * 36e5 };
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} made a reset code for ${this.nameOf(m.n)}`);
		this.ok(ws, p, { code: m.reset.code, hours: LIMITS.resetHours });
	}
	async leave(ws, me, p) {
		if (this.meta.founder === me) {
			return this.no(ws, 'hand the Order to someone else first', p);
		}
		await this.note(me, `${this.nameOf(me)} left`);
		delete this.members[me];
		await this.putMember(me);
		this.ok(ws, p);
		this.broadcast();
	}
	/** Hands the Order to another member: they become the founder, at the top rank; the old founder keeps theirs. */
	async setFounder(ws, me, p) {
		if (this.meta.founder !== me) {
			return this.no(ws, 'only the founder can do that', p);
		}
		const m = this.members[p.member];
		if (!m || m.n === me) {
			return this.no(ws, 'no such member', p);
		}
		this.meta.founder = m.n;
		m.rank = this.ranks[0].id;
		this.members[me].rank = this.ranks[0].id;
		await this.ctx.storage.put('meta', this.meta);
		await this.putMember(m.n);
		await this.putMember(me);
		await this.note(me, `${this.nameOf(me)} handed the Order to ${this.nameOf(m.n)}`);
		this.ok(ws, p);
		this.broadcast();
	}

	/** Your own card: bio and picture ('' removes it). */
	async profile(ws, me, p) {
		const m = this.members[me];
		if (typeof p.bio === 'string') {
			m.bio = clean(p.bio, LIMITS.bio);
		}
		if (typeof p.pic === 'string') {
			if (p.pic && (p.pic.length > LIMITS.pic || !PIC_RE.test(p.pic))) {
				return this.no(ws, 'bad picture', p);
			}
			m.pv = (m.pv || 0) + 1;
			if (p.pic) {
				await this.ctx.storage.put(`pic:${me}`, p.pic);
			} else {
				await this.ctx.storage.delete(`pic:${me}`);
			}
		}
		await this.putMember(me);
		this.ok(ws, p);
		this.broadcast();
	}
	/** A member's ID card, for anyone signed in (a card shown in a chat room is looked up here). */
	async card(ws, p) {
		const m = this.members[p.member];
		if (!m) {
			return this.send(ws, { t: 'card', member: p.member, card: null, ...(typeof p.rid === 'number' ? { rid: p.rid } : {}) });
		}
		const pic = (await this.ctx.storage.get(`pic:${m.n}`)) || '';
		const rank = this.ranks.find((r) => r.id === m.rank) || null;
		this.send(ws, {
			t: 'card',
			member: m.n,
			...(typeof p.rid === 'number' ? { rid: p.rid } : {}),
			card: {
				n: m.n,
				name: m.name,
				rank,
				founder: this.meta && this.meta.founder === m.n,
				title: m.title || '',
				bio: m.bio || '',
				joined: m.joined,
				pic,
				pv: m.pv || 0,
				order: this.meta ? this.meta.name : '',
			},
		});
	}
	/** Which chat room you show the Order ('' for none); the client sends only public rooms. */
	setRoom(ws, a, p) {
		const room = clean(p.room, LIMITS.room);
		if (room === a.room) {
			return;
		}
		a.room = room;
		ws.serializeAttachment(a);
		if (this.statusOf(a) === 'member') {
			this.broadcast();
		}
	}

	/** The about page, the joining questions and whether applications are open. */
	async setAbout(ws, me, p) {
		if (!this.may(me, 'manage')) {
			return this.no(ws, 'not allowed', p);
		}
		if (typeof p.name === 'string' && clean(p.name, LIMITS.name)) {
			this.meta.name = clean(p.name, LIMITS.name);
		}
		if (typeof p.about === 'string') {
			this.meta.about = clean(p.about, LIMITS.about);
		}
		if (Array.isArray(p.questions)) {
			this.meta.questions = p.questions
				.slice(0, LIMITS.questions)
				.map((q) => clean(q, LIMITS.question))
				.filter(Boolean);
		}
		if (typeof p.open === 'boolean') {
			this.meta.open = p.open;
		}
		await this.ctx.storage.put('meta', this.meta);
		await this.note(me, `${this.nameOf(me)} changed the about page`);
		this.ok(ws, p);
		this.broadcast();
	}

	/**
	 * The whole rank ladder, top to bottom. Ranks at or above your own must come back unchanged and in place; you
	 * add, change, move and remove only the ones below (the founder changes all). A rank someone holds can't go.
	 */
	async setRanks(ws, me, p) {
		if (!this.may(me, 'manage')) {
			return this.no(ws, 'not allowed', p);
		}
		if (!Array.isArray(p.ranks) || p.ranks.length < 1 || p.ranks.length > LIMITS.ranks) {
			return this.no(ws, `between 1 and ${LIMITS.ranks} ranks`, p);
		}
		const old = new Map(this.ranks.map((r) => [r.id, r]));
		/** @type {Rank[]} */
		const next = [];
		for (const x of p.ranks) {
			if (!x || typeof x !== 'object') {
				return this.no(ws, 'bad rank', p);
			}
			const id = typeof x.id === 'string' && old.has(x.id) ? x.id : newRankId();
			const name = clean(x.name, LIMITS.name);
			if (!name) {
				return this.no(ws, 'every rank needs a name', p);
			}
			next.push({
				id,
				name,
				sym: clean(x.sym, LIMITS.sym),
				color: COLOR_RE.test(x.color || '') ? x.color : '#8f86b8',
				perms: PERMS.filter((q) => Array.isArray(x.perms) && x.perms.includes(q)),
			});
		}
		if (new Set(next.map((r) => r.id)).size !== next.length) {
			return this.no(ws, 'a rank is listed twice', p);
		}
		const mine = this.power(me);
		if (mine >= 0) {
			// Not the founder: everything down to your own rank stays exactly as it was.
			const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
			if (!same(next.slice(0, mine + 1), this.ranks.slice(0, mine + 1))) {
				return this.no(ws, 'you can only change ranks below your own', p);
			}
		}
		const kept = new Set(next.map((r) => r.id));
		const held = Object.values(this.members).find((m) => !kept.has(m.rank));
		if (held) {
			return this.no(ws, `${held.name} still holds a rank you removed`, p);
		}
		// The founder holds the top rank.
		if (this.meta.founder && this.members[this.meta.founder] && this.members[this.meta.founder].rank !== next[0].id) {
			this.members[this.meta.founder].rank = next[0].id;
			await this.putMember(this.meta.founder);
		}
		this.ranks = next;
		await this.ctx.storage.put('ranks', this.ranks);
		await this.note(me, `${this.nameOf(me)} changed the ranks`);
		this.ok(ws, p);
		this.broadcast();
	}

	/**
	 * A new order, photo session or notice, to everyone, to ranks, or to members. A session has a time (`when`)
	 * for the reminders.
	 */
	async addOrder(ws, me, p) {
		if (!this.may(me, 'order')) {
			return this.no(ws, 'not allowed', p);
		}
		const kind = KINDS.includes(p.kind) ? p.kind : 'order';
		const title = clean(p.title, LIMITS.orderTitle);
		if (!title) {
			return this.no(ws, 'an order needs a title', p);
		}
		const to = p.to && typeof p.to === 'object' ? p.to : {};
		/** @type {{ all?: true, ranks?: string[], members?: number[] }} */
		const dest = {};
		if (to.all === true) {
			dest.all = true;
		} else {
			const ranks = Array.isArray(to.ranks)
				? [...new Set(to.ranks.filter((id) => this.ranks.some((r) => r.id === id)))].slice(0, LIMITS.orderTo)
				: [];
			const members = Array.isArray(to.members)
				? [...new Set(to.members.filter((n) => isNum(n) && this.members[n]))].slice(0, LIMITS.orderTo)
				: [];
			if (!ranks.length && !members.length) {
				return this.no(ws, 'pick who it is for', p);
			}
			if (ranks.length) {
				dest.ranks = ranks;
			}
			if (members.length) {
				dest.members = members;
			}
		}
		const when = Number(p.when);
		if (kind === 'session' && !(when > Date.now() - 36e5 && when < Date.now() + 366 * 864e5)) {
			return this.no(ws, 'a session needs a time', p);
		}
		const o = {
			id: ++this.seq,
			by: me,
			byName: this.members[me].name,
			at: Date.now(),
			kind,
			title,
			body: clean(p.body, LIMITS.orderText),
			to: dest,
			...(kind === 'session' ? { when } : {}),
			acks: {},
		};
		this.orders.set(o.id, o);
		await this.ctx.storage.put({ [orderKey(o.id)]: o, seq: this.seq });
		// Only the newest are kept.
		const ids = [...this.orders.keys()];
		if (ids.length > LIMITS.orders) {
			const gone = ids.slice(0, ids.length - LIMITS.orders);
			for (const id of gone) {
				this.orders.delete(id);
			}
			await this.ctx.storage.delete(gone.map(orderKey));
		}
		this.ok(ws, p, { id: o.id });
		this.pushOrder(o);
	}
	/** Answers an order you got: read or done, or for a session yes, maybe or no. */
	async ack(ws, me, p) {
		const o = this.orders.get(p.id);
		if (!o || !this.isFor(o, me)) {
			return this.no(ws, 'no such order', p);
		}
		if (!ACKS[o.kind].includes(p.a)) {
			return this.no(ws, 'bad answer', p);
		}
		o.acks[me] = { a: p.a, at: Date.now() };
		await this.ctx.storage.put(orderKey(o.id), o);
		this.ok(ws, p);
		this.pushOrder(o);
	}
	/** Takes an order down: its author, or someone who oversees it and may post orders. */
	async unorder(ws, me, p) {
		const o = this.orders.get(p.id);
		if (!o) {
			return this.no(ws, 'no such order', p);
		}
		if (o.by !== me && !(this.may(me, 'order') && this.oversees(o, me))) {
			return this.no(ws, 'not allowed', p);
		}
		const seen = this.sockets().filter(({ a }) => this.statusOf(a) === 'member' && this.sees(o, a.member));
		this.orders.delete(o.id);
		await this.ctx.storage.delete(orderKey(o.id));
		this.ok(ws, p);
		for (const { ws: w } of seen) {
			this.send(w, { t: 'unorder', id: o.id });
		}
	}
}
