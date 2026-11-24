/**
 * The Void Order server: a Cloudflare Worker with one Durable Object holding the whole Order.
 *
 * Storage: 'meta' { name, about, open, founded, founder, admins }, 'm:<member number>' members (see Member),
 * 'pic:<member number>' pictures, 'o:<id>' orders (the newest LIMITS.orders kept), 'seq', 'log' (the newest LIMITS.log changes), 'joins' (when each
 * address joined in the last hour) and 'r:<id>' dice rolls (kept LIMITS.rollMinutes).
 *
 * Clients sign in by signing a one-time nonce with their P-256 key. A member number is bound to the key it joined
 * with. A member who lost their key gets a reset code from someone over them, and the next key that signs in with
 * that code takes the number over. Members brought in by the hierarchy get a join code the same way. A member number
 * is whatever the client says it is (the game can't vouch for it to an outside server), so founding takes the
 * FOUND_CODE secret as well as env.ADMIN.
 *
 * The hierarchy (STRUCTURE, fixed in the code: changing it is an update): five branches, each with five ranks (1 at the bottom, 5 at the top) and chapters open from rank 2.
 * A member holds up to two branches (two make them a hybrid, with the title for that pair), and may be a Monsignor,
 * an honorary rank with no powers. Powers: the Founder (one member) and the app admins (env.ADMIN always, and whoever
 * the Founder or env.ADMIN names) do everything; nobody acts on them but the Founder. A member at rank 4 or 5 of a
 * branch leads it: they place, move, give orders to and remove that branch's members whose rank in it is below
 * theirs, and place members who have no place yet.
 *
 * Members who also run SlimeBeep are put in the Order's group chat there: the SlimeBeep relay makes an invite for
 * them (SLIMEBEEP_RELAY, with the SLIMEBEEP_LINK_KEY secret), and takes them out when they leave the Order.
 *
 * The hunt board: the Void Order Prison's hunting board (volunteers) and bounty board (escaped inmates), read from
 * vo-p.com through vop-source.js, and the Holy Order of Void's own bounty sheet (order-sheet.js), read again at most
 * every HUNT_EVERY ms, one page per alarm, kept in 'hunt' and 'sheet' and sent to everyone signed in. A page that
 * fails to load or read keeps the last good copy of it.
 *
 * Free-plan limits: sockets hibernate and keep-alive pings get an auto-response without waking the object.
 */

import { DurableObject } from 'cloudflare:workers';
import { HUNT_BOARD_URL } from './hunt-board.js';
import { BOUNTY_BOARD_URL, fetchBounties, fetchHunting } from './vop-source.js';
import { ORDER_SHEET_CSV, parseOrderSheet } from './order-sheet.js';
import { addReport, clearReports, listReports } from './reports.js';
import { badgeOf, setBadge } from './badges.js';
import { endLendTo, lend, lentTo, loadLend, recall } from './lend.js';
import { botCall, botKey, loadBotLinks, rankFromDiscord } from './bot-api.js';
import WEAPONS from '../../assets/weapons/index.json';

const LIMITS = {
	/** Longest Order or member name, and the longest element. */
	name: 40,
	element: 12,
	/** Longest bio. */
	bio: 300,
	/** Longest about text. */
	about: 2000,
	/** Most members. */
	members: 500,
	/** Longest order title and text, and orders kept. */
	orderTitle: 80,
	orderText: 1500,
	orders: 300,
	/** Most groups or member numbers one order goes to. */
	orderTo: 50,
	/** Changes kept in the log. */
	log: 200,
	/** Longest picture data URL. */
	pic: 12000,
	/** Longest room name. */
	room: 40,
	/** Most messages per connection in 10 s. */
	burst: 30,
	/** Most open connections, most from one address, and how long one may stay open without signing in (ms). */
	sockets: 400,
	socketsPerIp: 12,
	signIn: 10000,
	/** Most members joining from one address per hour. */
	joinsPerIp: 5,
	/** Hours a reset code stays valid, and days a join code does. */
	resetHours: 48,
	joinDays: 7,
	/** Most members brought in at once. */
	addAtOnce: 50,
	/** Most dice in one roll, the largest modifier, rolls per member a minute, minutes a roll is kept, rolls kept. */
	dice: 10,
	mod: 99,
	rollsPerMinute: 8,
	rollMinutes: 10,
	rolls: 1000,
	/** How often the hunt board is fetched again (ms), and the most pages fetched. */
	huntEvery: 600000,
	huntPages: 10,
	/** The most pages of the bounty board read, and the least time between two reads of the prison's site (ms). */
	bountyPages: 20,
	huntGap: 60000,
	/** A commendation's longest name and reason, and the most a member keeps (the newest). */
	medalName: 40,
	medalReason: 140,
	medals: 30,
};
/** Ranks in a branch, and the lowest rank that joins a chapter and that leads the branch. */
const TIERS = 5;
const CHAPTER_FROM = 2;
const LEADS_FROM = 4;
/** Most branches one member holds. */
const PLACES = 2;
const FORMS = ['f', 'm', 'n'];
/** The pictures a commendation can carry (the client draws them). */
const MEDALS = ['eye', 'scythe', 'star', 'flame', 'moon', 'crown', 'shield', 'rose', 'skull', 'chain', 'key', 'heart'];
/** The Armory: every weapon in the Order's catalog, by id (the client shows them from the same index). */
const WEAPON_IDS = WEAPONS.map((x) => x.id);
/** Who sees a member's public room: everyone in the Order, only those over them, or nobody. */
const ROOM_FOR = ['all', 'over', 'none'];
const DICE = [4, 6, 8, 10, 12, 20, 100];
const KINDS = ['order', 'session', 'notice'];
/** What an order can be answered with, by kind. */
const ACKS = { order: ['read', 'done'], session: ['yes', 'maybe', 'no'], notice: ['read'] };
/** A picture: an image data URL only. */
const PIC_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
/** A base64url key coordinate or signature. */
const B64URL = /^[A-Za-z0-9_-]{16,128}$/;
const CODE_RE = /^[A-Z2-9]{10}$/;
const ROLL_RE = /^[a-z0-9]{12}$/;
/**
 * Page origins allowed to connect: the game's sites and their subdomains (the European mirror is spelt both with and
 * without the hyphen), and localhost for tests.
 */
const ORIGINS = [
	/^https?:\/\/([a-z0-9-]+\.)*bondageprojects\.elementfx\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondageprojects\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondage-?europe\.com$/,
	/^https?:\/\/([a-z0-9-]+\.)*bondage-asia\.com$/,
	/^http:\/\/localhost(:\d+)?$/,
	/^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/**
 * @typedef {{ f: string, m: string, n: string }} Forms a rank name: feminine, masculine and neutral. A '*' stands for
 *   the member's element ("*mancer": Pyromancer).
 * @typedef {{ id: string, name: string, tiers: (Forms | null)[] }} Chapter `tiers`: the chapter's own rank names,
 *   replacing the branch's where set.
 * @typedef {{ id: string, name: string, sym: string, color: string, about: string, tiers: Forms[], chapters: Chapter[],
 *   elements: string[] }} Branch
 * @typedef {{ b: string, t: number, c: string }} Place a branch, the rank in it (1-5) and the chapter ('' for none).
 * @typedef {{ n: number, name: string, pub: { x: string, y: string } | null, joined: number, bio: string,
 *   form: string, el: string, places: Place[], mon: boolean, rank?: number, roomFor?: string,
 *   reset?: { code: string, exp: number } }} Member `rank`: their Order rank (an index into STRUCTURE.ranks).
 *   `places`: the first is their main branch. `mon`: a Monsignor. `pub` is null until a member brought in joins.
 *   `roomFor`: who sees the public room they are in (ROOM_FOR; everyone when unset). `medals`: their commendations
 *   (see Medal), oldest first.
 *   `weapons`: the Armory's weapons issued to them; `carried`: the ones they carry (see carryLimit). Records from
 *   before kept one in `carry` (0 for none), read as a list of that one.
 * @typedef {{ id: string, icon: string, name: string, reason: string, by: number, byName: string, at: number }} Medal
 */

/** A rank name with the same word in every form. */
const forms = (f, m = f, n = m) => ({ f, m, n });
const chapter = (id, name, tiers = []) => ({ id, name, tiers: Array.from({ length: TIERS }, (_, i) => tiers[i] || null) });
/** The Order's structure, as its Discord has it. Changing it is a code update. */
/** The Order's name: fixed, like its structure. A name stored when the Order was founded stays in 'meta' but isn't used. */
const ORDER_NAME = 'Holy Order of Void';
/** Queen's Wrath, the app admin's signature scythe: never counted in what someone carries. */
const QUEENS_WRATH = 100;
const STRUCTURE = {
	motto: 'Praise the Void! 𓁹‿𓁹',
	/**
	 * The Order's ranks, from Neophyte (every member's first) up; the Founder stands above them all. Set by the Founder
	 * and admins. A member's `rank` is an index into this list (0 when unset).
	 */
	ranks: [
		'Neophyte',
		'Elder Neophyte',
		'Follower',
		'Elder Follower',
		'Acolyte',
		'Elder Acolyte',
		'Zealot',
		'Elder Zealot',
		'Elder',
		'One of the First Ones',
	],
	founder: { name: 'Founder', sym: '𓁹‿𓁹', color: '#ffe3a3' },
	monsignor: {
		name: 'Monsignor',
		sym: '🎇',
		color: '#ffb36b',
		about: 'Celebrities within BC. Full members of the Void Order, who outside of it are well known to whole BC community.',
	},
	branches: [
		{
			id: 'priest',
			name: 'Priest',
			sym: '☨✙☨',
			color: '#f0d08a',
			about: 'Leaders of spiritual and religious matters.',
			tiers: [
				forms('Scholar'),
				forms('Priestess', 'Priest', 'Priest / Priestess'),
				forms('High Priestess', 'High Priest', 'High Priest / High Priestess'),
				forms('Bishop'),
				forms('Archbishop'),
			],
			chapters: [chapter('lore-custos', 'Lore Custos'), chapter('vox-nihil', 'Vox Nihil'), chapter('redemptio', 'Redemptio per dolorem')],
			elements: [],
		},
		{
			id: 'inquisitor',
			name: 'Inquisitor',
			sym: '≈][≈',
			color: '#ff7a8c',
			about: 'Judicial enforcers of law and order.',
			tiers: [forms('Investigator'), forms('Inquisitor'), forms('Enforcer'), forms('Judge'), forms('Arch Judge')],
			chapters: [
				chapter('ordo-hereticus', 'Ordo Hereticus'),
				chapter('ordo-arbitrorum', 'Ordo Arbitrorum'),
				chapter('ordo-guardiani', 'Ordo Guardiani'),
			],
			elements: [],
		},
		{
			id: 'paladin',
			name: 'Paladin',
			sym: '✦⸸✦',
			color: '#8fd3ff',
			about: 'The stalwart defenders and knights of the realm.',
			tiers: [forms('Squire'), forms('Knight'), forms('Paladin'), forms('Crusader'), forms('Champion')],
			chapters: [chapter('bellator', 'Division Bellator'), chapter('salvatoris', 'Salvatoris'), chapter('ranger', 'Ranger')],
			elements: [],
		},
		{
			id: 'mage',
			name: 'Mage',
			sym: '☿⸸☿',
			color: '#c49bff',
			about: 'Masters of mental powers and psychic abilities.',
			tiers: [forms('Novitate'), forms('Primary'), forms('*mancer'), forms('Sage'), forms('Grand Sage')],
			chapters: [
				chapter('conjurers', 'Conjurers', [null, null, forms('Spellblade'), forms('Arcane Fencer'), forms('Sword Sage')]),
				chapter('thought-weavers', 'Thought-Weavers', [null, null, forms('Cerebralist'), forms('Mind Bender'), forms('Psionic Sage')]),
				chapter('spell-shapers', 'Spell-Shapers', [null, null, forms('Shaper'), forms('Arcane Fabricator'), forms('Magitech Sage')]),
			],
			elements: ['Geo', 'Pyro', 'Hydro', 'Aero'],
		},
		{
			id: 'maid',
			name: 'Maid',
			sym: '🧹',
			color: '#f5a8d6',
			about: 'The noble caretakers and household leaders.',
			tiers: [
				forms('Attendant'),
				forms('Senior Attendant'),
				forms('Maid', 'Butler', 'Maid / Butler'),
				forms('Head Maid', 'Head Butler', 'Head Maid / Head Butler'),
				forms('Matron', 'Patron', 'Matron / Patron'),
			],
			chapters: [
				chapter('hospitii', 'House of Hospitii Ars Amandi'),
				chapter('alimentum', 'Alimentum Armatura'),
				chapter('animalus', 'Animalus Custodian'),
			],
			elements: [],
		},
	],
	/** The title of a member in two branches, by the two branch ids in alphabetical order. */
	hybrids: {
		'mage+priest': forms('Tomekeeper'),
		'paladin+priest': forms('Cleric'),
		'inquisitor+priest': forms('Chaplain'),
		'maid+priest': forms('Altar Girl', 'Altar Boy', 'Altar Boy / Altar Girl'),
		'inquisitor+paladin': forms('Commisar'),
		'inquisitor+mage': forms('Warlock'),
		'inquisitor+maid': forms('Inspector'),
		'maid+paladin': forms('Battle Maid', 'Battle Butler', 'Battle Maid / Battle Butler'),
		'mage+paladin': forms('Warmage'),
		'mage+maid': forms('Caretaker'),
	},
};

/** A plausible member number. */
const isNum = (n) => Number.isInteger(n) && n > 0 && n < 1e9;
/** A join date (ms) from a client or the bot: from 2010 (before BC's chat rooms) up to tomorrow (time zones), or 0. */
const joinDay = (at) => {
	const t = Number(at);
	return Number.isFinite(t) && t >= Date.UTC(2010, 0, 1) && t <= Date.now() + 864e5 ? Math.round(t) : 0;
};
/** A string with control characters removed, trimmed and cut to `max`; '' for anything else. */
const clean = (x, max) =>
	typeof x === 'string'
		? x
				// eslint-disable-next-line no-control-regex -- removing control characters is the point
				.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
				.trim()
				.slice(0, max)
		: '';
/** A random string from `abc`, without the bias of a plain modulo. */
const randomOf = (abc, len) => {
	let out = '';
	while (out.length < len) {
		const v = randInt(abc.length);
		out += abc[v - 1];
	}
	return out;
};
/** A uniformly random whole number from 1 to `max`, from the crypto source. */
function randInt(max) {
	const limit = Math.floor(0x100000000 / max) * max;
	const a = new Uint32Array(1);
	do {
		crypto.getRandomValues(a);
	} while (a[0] >= limit);
	return (a[0] % max) + 1;
}
/** A reset code: 10 characters with no look-alike letters. */
const newCode = () => randomOf('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);
const newId = (len) => randomOf('abcdefghijklmnopqrstuvwxyz0123456789', len);
const b64url = (buf) =>
	btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
const unb64url = (s) =>
	Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
/** Whether two public keys are the same. */
const samePub = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
/** A request's id, sent back with its answer. */
const ridOf = (p) => (p && typeof p.rid === 'number' ? { rid: p.rid } : {});
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
	 * { member }: a reset code for a member who lost their key when nobody over them can make one.
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
		// The Order's Discord bot (see bot-api.js): signed with its own key.
		if (url.pathname === '/bot' && req.method === 'POST') {
			const key = botKey(env);
			const body = await req.text();
			if (!key || body.length > 20000 || !(await verify(key, req.headers.get('X-Void-Bot-Sig') || '', body))) {
				return new Response('Not found', { status: 404 });
			}
			return Response.json(await order.botCall(body));
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
			/** @type {Record<number, Member>} */
			this.members = {};
			for (const m of (await ctx.storage.list({ prefix: 'm:' })).values()) {
				this.members[m.n] = m;
			}
			this.orders = new Map();
			for (const o of (await ctx.storage.list({ prefix: 'o:' })).values()) {
				this.orders.set(o.id, o);
			}
			/** @type {Map<string, any>} */
			this.rolls = new Map();
			for (const r of (await ctx.storage.list({ prefix: 'r:' })).values()) {
				this.rolls.set(r.id, r);
			}
			this.seq = (await ctx.storage.get('seq')) || 0;
			this.log = (await ctx.storage.get('log')) || [];
			/** @type {{ pages: Record<number, any>, of: number, tried: number, next: string[] }} */
			this.hunt = (await ctx.storage.get('hunt')) || { pages: {}, of: 0, tried: 0, next: [] };
			/** @type {{ list: any[], at: number }} The Order's bounties, from its sheet. */
			this.sheet = (await ctx.storage.get('sheet')) || { list: [], at: 0 };
			await loadLend(this);
			await loadBotLinks(this);
		});
	}

	/** The Order's ranks (STRUCTURE.ranks), for the Discord bot. */
	get ranks() {
		return STRUCTURE.ranks;
	}
	/** A request from the Discord bot, its signature checked by the Worker (see bot-api.js). */
	async botCall(body) {
		return await botCall(this, body);
	}

	/** The app admin's member number: founds the Order and always has every power. */
	get appAdmin() {
		return Number(this.env.ADMIN) || 0;
	}

	// ---- The hierarchy
	isFounder(n) {
		return !!this.meta && this.meta.founder === n && !!this.members[n];
	}
	/** An admin: the app admin or one the Founder named, once they have signed in with their own key. */
	isAdmin(n) {
		const m = this.members[n];
		return !!m && !!m.pub && (n === this.appAdmin || (!!this.meta && this.meta.admins.includes(n)));
	}
	/** The Founder or an admin: every power, everywhere. */
	isTop(n) {
		return this.isFounder(n) || this.isAdmin(n);
	}
	/** Member n's rank in branch b (1-5), or 0. */
	tierIn(n, b) {
		const m = this.members[n];
		const p = m && m.places.find((x) => x.b === b);
		return p ? p.t : 0;
	}
	/** Whether member n leads branch b (rank 4 or 5 in it). */
	leads(n, b) {
		return this.tierIn(n, b) >= LEADS_FROM;
	}
	leadsAny(n) {
		const m = this.members[n];
		return !!m && m.places.some((p) => p.t >= LEADS_FROM);
	}
	/** Whether `by` acts on member n with the Founder's or an admin's powers: nobody acts on them but the Founder. */
	topOver(by, n) {
		return this.isFounder(by) || (this.isAdmin(by) && !this.isFounder(n) && (n === by || !this.isAdmin(n)));
	}
	/** Whether `by`, leading branch b, outranks member n in it (n holds it, below `by`). */
	leaderOver(by, n, b) {
		const t = this.tierIn(n, b);
		return !this.isTop(n) && t > 0 && t < this.tierIn(by, b) && this.leads(by, b);
	}
	/**
	 * Whether `by` has powers over member n (codes that hand over their number, weapons, commendations): the Founder's
	 * or an admin's (topOver), or a leader's over n in EVERY branch n holds. A leader over one branch of a hybrid member
	 * who outranks them in another has no powers over them (orders still reach them in that branch: see commands).
	 */
	standsOver(by, n) {
		const m = this.members[n];
		if (!m) {
			return false;
		}
		return this.topOver(by, n) || (m.places.length > 0 && m.places.every((p) => this.leaderOver(by, n, p.b)));
	}
	/**
	 * Whether `by` stands over member n in the hierarchy's messages: orders go down to them, `by` sees the answers to
	 * n's orders and the room n shows those over them. A leader reaches a hybrid member in the branch they lead.
	 */
	commands(by, n) {
		const m = this.members[n];
		return !!m && by !== n && (this.topOver(by, n) || m.places.some((p) => this.leaderOver(by, n, p.b)));
	}
	/** Whether member n has no place yet (no branch and not a Monsignor) and `by` may place them. */
	placesNew(by, n) {
		const m = this.members[n];
		return !!m && !m.places.length && !m.mon && !this.isTop(n) && this.leadsAny(by);
	}
	/**
	 * Whether `by` may give member n rank t (1-5) in branch b: the Founder and admins any; a leader of b only a rank
	 * below their own, to someone below them in b or new to it.
	 */
	mayPlace(by, n, b, t) {
		if (this.topOver(by, n)) {
			return true;
		}
		const m = this.members[n];
		const mine = this.tierIn(by, b);
		if (!this.leads(by, b) || this.isTop(n) || t >= mine) {
			return false;
		}
		if (this.tierIn(n, b) > 0) {
			return this.leaderOver(by, n, b);
		}
		// Adding a branch: only to someone the leader stands over in every branch they hold, or who has no place yet.
		return m.places.length ? m.places.every((p) => this.leaderOver(by, n, p.b)) : this.placesNew(by, n);
	}
	/** Whether `by` may take member n out of the Order: leaders only those under them in every branch they hold. */
	mayRemove(by, n) {
		const m = this.members[n];
		if (!m || by === n) {
			return false;
		}
		if (this.topOver(by, n)) {
			return true;
		}
		return !m.mon && (this.placesNew(by, n) || (m.places.length > 0 && m.places.every((p) => this.leaderOver(by, n, p.b))));
	}
	/**
	 * Whether `by` may make member n a reset or join code: whoever may take them out of the Order (a code hands over the
	 * member's number), so a leader only over those below them in every branch they hold.
	 */
	mayReset(by, n) {
		return this.mayRemove(by, n);
	}
	/** Whether member n may post orders: the Founder, admins and branch leaders. */
	mayOrder(n) {
		return this.isTop(n) || this.leadsAny(n);
	}
	/** What member n may do, for their client. */
	powersOf(n) {
		return {
			founder: this.isFounder(n),
			admin: this.isAdmin(n),
			appAdmin: n === this.appAdmin,
			top: this.isTop(n),
			leads: STRUCTURE.branches.filter((b) => this.leads(n, b.id)).map((b) => b.id),
		};
	}
	branch(id) {
		return STRUCTURE.branches.find((b) => b.id === id) || null;
	}
	/** A member's rank name in a place, in their form ("Pyromancer", "High Priestess"). */
	rankName(p, m) {
		const b = this.branch(p.b);
		if (!b) {
			return '';
		}
		const ch = b.chapters.find((c) => c.id === p.c);
		const tier = (ch && ch.tiers[p.t - 1]) || b.tiers[p.t - 1];
		const word = (tier[m.form] || tier.n).replace('*', m.el || '');
		return word.charAt(0).toUpperCase() + word.slice(1);
	}
	/** "Paladin - Knight" for the log. */
	placeName(p, m) {
		const b = this.branch(p.b);
		return b ? `${b.name} - ${this.rankName(p, m)}` : '';
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
	/** Adds a line to the log (kept for the Founder and admins). */
	async note(by, text) {
		this.log.push({ at: Date.now(), by, text });
		if (this.log.length > LIMITS.log) {
			this.log.splice(0, this.log.length - LIMITS.log);
		}
		await this.ctx.storage.put('log', this.log);
	}
	/** A member's name for the log. */
	nameOf(n) {
		const m = this.members[n];
		return m ? `${m.name} (${n})` : `#${n}`;
	}
	/** A new member record. */
	newMember(n, name, pub, extra = {}) {
		return { n, name, pub, joined: Date.now(), bio: '', form: 'n', el: '', places: [], mon: false, ...extra };
	}

	/**
	 * A reset code for a member, made by the operator (see the Worker's fetch): for the Founder, who has nobody over
	 * them to make one.
	 * @returns {Promise<Response>}
	 */
	async opReset(member) {
		// The app admin is the one number the operator may bring back in: she can't join and is never removed, but an
		// Order kept from before that rule may have lost her.
		if (!this.members[member] && member === this.appAdmin && this.meta) {
			this.members[member] = this.newMember(member, `#${member}`, null);
		}
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
	/**
	 * Accepts a WebSocket and sends it a sign-in nonce. Connections that didn't sign in within LIMITS.signIn are closed
	 * first, and one address holds at most LIMITS.socketsPerIp.
	 */
	async fetch(req) {
		const ip = req.headers.get('CF-Connecting-IP') || '';
		const now = Date.now();
		let fromIp = 0;
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment() || {};
			if (!a.member && now - (a.at || 0) > LIMITS.signIn) {
				this.fail(ws, 'sign in first');
			} else if (ip && a.ip === ip) {
				fromIp++;
			}
		}
		if (this.ctx.getWebSockets().length >= LIMITS.sockets || fromIp >= LIMITS.socketsPerIp) {
			return new Response('Busy', { status: 503 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
		server.serializeAttachment({ nonce, member: 0, name: '', pub: null, hits: [], room: '', ip, at: now });
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
		this.send(ws, { t: 'error', why, ...ridOf(p) });
	}
	/** Answers a request as done. */
	ok(ws, p, extra = {}) {
		this.send(ws, { t: 'ok', what: p.t, ...ridOf(p), ...extra });
	}
	/** The signed-in connections with their attachments. */
	sockets() {
		return this.ctx.getWebSockets().flatMap((ws) => {
			const a = ws.deserializeAttachment();
			return a && a.member ? [{ ws, a }] : [];
		});
	}

	/**
	 * What a connection is to the Order: 'member', 'invited' (brought in, waiting for their join code), 'mismatch'
	 * (the number is a member with another key) or 'guest'.
	 */
	statusOf(a) {
		const m = this.members[a.member];
		if (!m) {
			return 'guest';
		}
		if (!m.pub) {
			return 'invited';
		}
		return samePub(m.pub, a.pub) ? 'member' : 'mismatch';
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

	/**
	 * A member as `viewer` sees them in the list (no picture or bio: cards carry those). Their room shows to whom they
	 * let see it: everyone, those over them (and themselves), or nobody.
	 */
	listed(m, on, viewer = 0) {
		const roomFor = m.roomFor || 'all';
		const seesRoom = roomFor === 'all' || (roomFor === 'over' && (viewer === m.n || this.commands(viewer, m.n)));
		return {
			n: m.n,
			name: m.name,
			joined: m.joined,
			form: m.form,
			el: m.el,
			places: m.places,
			weapons: this.weaponsOf(m.n),
			carried: this.carriedOf(m.n),
			carry: this.carriedOf(m.n)[0] || 0,
			carryLimit: this.carryLimit(m.n),
			badge: badgeOf(m),
			...(m.mon ? { mon: 1 } : {}),
			...(m.rank ? { rank: m.rank } : {}),
			...(rankFromDiscord(this, m.n) ? { discord: 1 } : {}),
			...(m.armor ? { armor: 1 } : {}),
			...(this.isAdmin(m.n) ? { admin: 1 } : {}),
			// The Founder can be in the Order without the add-on (Mag: shown, never signs in): never shown as invited.
			...(m.pub || this.isFounder(m.n) ? {} : { invited: 1 }),
			...(m.n in on ? { on: 1, room: seesRoom ? on[m.n] : '' } : {}),
		};
	}

	/** The state one connection sees: everything for members; the about page and who leads for everyone else. */
	stateFor(a, on = this.online()) {
		const status = this.statusOf(a);
		const meta = this.meta
			? { name: this.meta.name, about: this.meta.about, open: this.meta.open, founded: this.meta.founded, founder: this.meta.founder }
			: null;
		/** @type {Record<string, any>} */
		const s = {
			t: 'state',
			status,
			member: a.member,
			meta,
			structure: STRUCTURE,
			appAdmin: this.appAdmin,
			lent: lentTo(this),
			canFound: !this.meta && a.member === this.appAdmin,
		};
		const all = Object.values(this.members);
		if (status === 'member') {
			const me = this.members[a.member];
			s.me = {
				...this.listed(me, on, me.n),
				bio: me.bio,
				roomFor: me.roomFor || 'all',
				powers: this.powersOf(a.member),
				medalCount: (me.medals || []).length,
			};
			s.members = all.map((m) => this.listed(m, on, me.n));
			if (this.isTop(a.member)) {
				s.log = this.log.slice(-50);
			}
		} else {
			// Everyone else sees who leads: the Founder, the Monsignors and the branch leaders.
			s.members = all.filter((m) => this.isFounder(m.n) || m.mon || m.places.some((p) => p.t >= LEADS_FROM)).map((m) => this.listed(m, {}));
			s.count = all.length;
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
	/**
	 * Whether member n is in an order's group: 'priest' (the branch), 'priest/3' (one rank of it), 'priest:vox-nihil'
	 * (a chapter), 'monsignor' or 'unplaced'.
	 */
	inGroup(g, n) {
		const m = this.members[n];
		if (g === 'monsignor') {
			return m.mon;
		}
		if (g === 'unplaced') {
			return !m.places.length && !m.mon;
		}
		const [, b, sep, rest] = /^([a-z0-9-]+)(?:([/:])([a-z0-9-]+))?$/.exec(g) || [];
		const p = m.places.find((x) => x.b === b);
		return !!p && (!sep || (sep === '/' ? p.t === Number(rest) : p.c === rest));
	}
	/** Whether `by` may send an order to group g: the Founder and admins to any, leaders only inside their branch. */
	mayAddress(by, g) {
		const [, b, sep, rest] = /^([a-z0-9-]+)(?:([/:])([a-z0-9-]+))?$/.exec(g) || [];
		const br = this.branch(b);
		const valid =
			g === 'monsignor' ||
			g === 'unplaced' ||
			(!!br && (!sep || (sep === '/' ? Number(rest) >= 1 && Number(rest) <= TIERS : br.chapters.some((c) => c.id === rest))));
		if (!valid) {
			return false;
		}
		if (this.isTop(by)) {
			return true;
		}
		return !!br && this.leads(by, b) && (sep !== '/' || Number(rest) < this.tierIn(by, b));
	}
	/** Whether member n is one an order goes to: under its author, and everyone, or in a group or named. */
	isFor(o, n) {
		const m = this.members[n];
		if (!m || n === o.by) {
			return false;
		}
		// An author who left still reaches only those below the place they held when they posted (kept in o.from); an
		// order from before places were kept reaches nobody once its author is gone.
		const under = this.members[o.by] ? this.commands(o.by, n) : this.overFrom(o.from, n);
		return under && (o.to.all === true || (o.to.groups || []).some((g) => this.inGroup(g, n)) || (o.to.members || []).includes(n));
	}
	/** Member n's place, kept with an order they post: { founder, admin, places }. */
	placeOf(n) {
		const m = this.members[n];
		return { founder: this.isFounder(n), admin: this.isAdmin(n), places: m ? m.places.map((x) => ({ b: x.b, t: x.t })) : [] };
	}
	/** Whether a place kept with an order (see placeOf) stands over member n, the way commands does for a member. */
	overFrom(from, n) {
		const m = this.members[n];
		if (!from || typeof from !== 'object' || !m) {
			return false;
		}
		if (from.founder) {
			return true;
		}
		if (from.admin) {
			return !this.isFounder(n) && !this.isAdmin(n);
		}
		const kept = Array.isArray(from.places) ? from.places : [];
		const tier = (b) => (kept.find((x) => x && x.b === b) || { t: 0 }).t;
		return !this.isTop(n) && m.places.some((p) => tier(p.b) >= LEADS_FROM && p.t < tier(p.b));
	}
	/** Sends every member connection the orders it sees now (after a change to who stands where). */
	pushAllOrders() {
		for (const { ws, a } of this.sockets()) {
			if (this.statusOf(a) === 'member') {
				this.send(ws, { t: 'orders', orders: this.ordersOf(a.member) });
			}
		}
	}
	/** Whether member n oversees an order: they stand over its author (or are the Founder or an admin, once it is gone). */
	oversees(o, n) {
		return this.members[o.by] ? this.commands(n, o.by) : this.isTop(n);
	}
	/** Whether member n sees an order: it goes to them, they wrote it, or they oversee it. */
	sees(o, n) {
		return !!this.members[n] && (o.by === n || this.isFor(o, n) || this.oversees(o, n));
	}
	/** An order as member n sees it: everyone's answers only for its author and those who oversee it. */
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
	/** The orders member n sees, newest first. */
	ordersOf(n) {
		return [...this.orders.values()]
			.filter((o) => this.sees(o, n))
			.reverse()
			.map((o) => this.orderFor(o, n));
	}

	/**
	 * A client message (JSON with `t`). Before sign-in only 'auth'. Anyone signed in: 'card', 'room', 'roll',
	 * 'getroll', 'hunt', 'report' (and the app admin 'reports', 'clearreports': see reports.js). Guests: 'join', and
	 * 'found' for the app admin. Members: 'orders', 'profile', 'ack', 'leave',
	 * 'chat', 'carry', and with the powers for it 'place', 'unplace', 'monsignor', 'admin', 'kick', 'reset', 'add',
	 * 'about', 'award', 'unaward', 'issue', 'order', 'unorder', 'founder'. A request may carry a number `rid`, sent back with its 'ok' or 'error'.
	 */
	async webSocketMessage(ws, raw) {
		const a = ws.deserializeAttachment();
		let p = {};
		try {
			if (typeof raw !== 'string' || raw.length > 30000) {
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
			switch (p.t) {
				case 'card':
					return await this.card(ws, p);
				case 'room':
					return this.setRoom(ws, a, p);
				case 'roll':
					return await this.roll(ws, a, p);
				case 'hunt':
					this.huntCheck();
					return this.send(ws, { t: 'hunt', ...ridOf(p), board: this.huntBoard() });
				case 'getroll':
					return this.getRoll(ws, p);
				case 'report':
					return await addReport(this, ws, a, p);
				case 'reports':
					return await listReports(this, ws, a, p);
				case 'clearreports':
					return await clearReports(this, ws, a, p);
			}
			if (status !== 'member') {
				switch (p.t) {
					case 'found':
						return await this.found(ws, a, p);
					case 'join':
						return await this.join(ws, a, p);
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
				case 'place':
					return await this.place(ws, me, p);
				case 'unplace':
					return await this.unplace(ws, me, p);
				case 'monsignor':
					return await this.setMonsignor(ws, me, p);
				case 'rank':
					return await this.setRank(ws, me, p);
				case 'admin':
					return await this.setAdmin(ws, me, p);
				case 'kick':
					return await this.kick(ws, me, p);
				case 'reset':
					return await this.reset(ws, me, p);
				case 'since':
					return await this.setSince(ws, me, p);
				case 'add':
					return await this.addMembers(ws, me, p);
				case 'about':
					return await this.setAbout(ws, me, p);
				case 'order':
					return await this.addOrder(ws, me, p);
				case 'unorder':
					return await this.unorder(ws, me, p);
				case 'founder':
					return await this.setFounder(ws, me, p);
				case 'chat':
					return await this.chatInvite(ws, me, p);
				case 'award':
					return await this.award(ws, me, p);
				case 'unaward':
					return await this.unaward(ws, me, p);
				case 'issue':
					return await this.issue(ws, me, p);
				case 'carry':
					return await this.carry(ws, me, p);
				case 'armor':
					return await this.armor(ws, me, p);
				case 'hidebounty':
					return await this.hideBounty(ws, me, p);
				case 'badge':
					return await setBadge(this, ws, me, p);
				case 'lend':
					return await lend(this, ws, me, p);
				case 'recall':
					return await recall(this, ws, me, p);
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

	/** Sign-in: checks the signature, takes a reset or join code if one is sent, and answers with the state. */
	async auth(ws, a, p) {
		const member = p.member;
		if (!isNum(member) || !p.pub || !B64URL.test(p.pub.x || '') || !B64URL.test(p.pub.y || '') || !B64URL.test(p.sig || '')) {
			return this.fail(ws, 'bad sign-in');
		}
		const pub = { x: p.pub.x, y: p.pub.y };
		if (!(await verify(pub, p.sig, `${a.nonce}|void|${member}`))) {
			return this.fail(ws, 'bad signature');
		}
		const name = clean(p.name, LIMITS.name);
		a.member = member;
		a.name = name || `#${member}`;
		a.pub = pub;
		a.room = clean(p.room, LIMITS.room);
		ws.serializeAttachment(a);
		const m = this.members[member];
		let changed = false;
		if (m && !samePub(m.pub, pub) && CODE_RE.test(p.code || '') && m.reset && m.reset.code === p.code && m.reset.exp > Date.now()) {
			// A reset or join code moves the number to this key.
			const joining = !m.pub;
			m.pub = pub;
			delete m.reset;
			await this.note(
				member,
				`${this.nameOf(member)} ${joining ? 'joined with their join code' : 'signed in with a new key (reset code)'}`,
			);
			changed = true;
		}
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
		const board = this.huntBoard();
		if (board) {
			this.send(ws, { t: 'hunt', board });
		}
		this.huntCheck();
	}

	/**
	 * Founds the Order: only the app admin with the FOUND_CODE secret, once. They are its Founder until they hand that
	 * over (to the Order's real founder, once she has joined).
	 */
	async found(ws, a, p) {
		if (this.meta) {
			return this.no(ws, 'already founded', p);
		}
		if (a.member !== this.appAdmin) {
			return this.no(ws, 'only the app admin can found the Order', p);
		}
		// Trimmed both sides: a secret set from the command line can carry a line break.
		const code = typeof this.env.FOUND_CODE === 'string' ? this.env.FOUND_CODE.trim() : '';
		if (code.length < 8 || typeof p.code !== 'string' || p.code.trim() !== code) {
			return this.no(ws, 'wrong founding code', p);
		}
		this.meta = {
			name: ORDER_NAME,
			about: clean(p.about, LIMITS.about),
			open: true,
			founded: Date.now(),
			founder: a.member,
			admins: [],
		};
		this.members[a.member] = this.newMember(a.member, clean(p.myName, LIMITS.name) || a.name, a.pub);
		await this.ctx.storage.put('meta', this.meta);
		await this.putMember(a.member);
		await this.note(a.member, `${this.nameOf(a.member)} founded the ${ORDER_NAME}`);
		this.ok(ws, p);
		this.broadcast();
		this.send(ws, { t: 'orders', orders: [] });
	}

	/** Joins the Order at once, with no place yet: a leader or admin places them. At most a few per address an hour. */
	async join(ws, a, p) {
		if (!this.meta) {
			return this.no(ws, 'the Order is not founded yet', p);
		}
		const status = this.statusOf(a);
		if (status === 'mismatch') {
			return this.no(ws, 'signed in with another key', p);
		}
		if (status === 'invited') {
			return this.no(ws, 'you are already in the Order: enter the join code you were sent', p);
		}
		// The app admin's number is never joined into: she founds the Order, and if she ever lost her place she comes
		// back through the operator's reset code (which re-admits her), never through a join anyone can send.
		if (a.member === this.appAdmin) {
			return this.no(ws, "the app admin's number can't join: the operator makes her a reset code", p);
		}
		if (!this.meta.open) {
			return this.no(ws, 'joining is closed right now', p);
		}
		if (Object.keys(this.members).length >= LIMITS.members) {
			return this.no(ws, 'the Order is full', p);
		}
		// Joins per address in the last hour, kept in storage (the object sleeps between visitors).
		const now = Date.now();
		const joins = (await this.ctx.storage.get('joins')) || {};
		for (const [ip, times] of Object.entries(joins)) {
			joins[ip] = times.filter((t) => now - t < 36e5);
			if (!joins[ip].length) {
				delete joins[ip];
			}
		}
		const mine = joins[a.ip] || [];
		if (mine.length >= LIMITS.joinsPerIp) {
			return this.no(ws, 'too many joined from here, try again in an hour', p);
		}
		joins[a.ip] = [...mine, now];
		await this.ctx.storage.put('joins', joins);
		this.members[a.member] = this.newMember(a.member, clean(p.name, LIMITS.name) || a.name, a.pub);
		await this.putMember(a.member);
		await this.note(a.member, `${this.nameOf(a.member)} joined`);
		this.ok(ws, p);
		this.broadcast();
		this.send(ws, { t: 'orders', orders: this.ordersOf(a.member) });
	}

	/** The member p.member, answering the error if there is none. */
	target(ws, p) {
		const m = isNum(p.member) ? this.members[p.member] : null;
		if (!m) {
			this.no(ws, 'no such member', p);
		}
		return m;
	}
	/**
	 * Places a member in a branch, or moves them in it: { member, branch, tier, chapter }. A new branch is added as
	 * their second (a hybrid) if they have one already. Chapters only from rank 2.
	 */
	async place(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		const b = this.branch(p.branch);
		const t = Number(p.tier);
		if (!b || !Number.isInteger(t) || t < 1 || t > TIERS) {
			return this.no(ws, 'pick a branch and a rank', p);
		}
		const c = typeof p.chapter === 'string' ? p.chapter : '';
		if (c && !b.chapters.some((x) => x.id === c)) {
			return this.no(ws, 'no such chapter', p);
		}
		if (c && t < CHAPTER_FROM) {
			return this.no(ws, `chapters are open from rank ${CHAPTER_FROM}`, p);
		}
		const held = m.places.find((x) => x.b === b.id);
		if (!held && m.places.length >= PLACES) {
			return this.no(ws, `a member holds at most ${PLACES} branches`, p);
		}
		if (!this.mayPlace(me, m.n, b.id, t)) {
			return this.no(ws, 'you can only place members below your own rank in a branch you lead', p);
		}
		if (held) {
			held.t = t;
			held.c = c;
		} else {
			m.places.push({ b: b.id, t, c });
		}
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} placed ${this.nameOf(m.n)}: ${this.placeName({ b: b.id, t, c }, m)}`);
		this.ok(ws, p);
		this.broadcast();
		this.pushAllOrders();
	}
	/**
	 * The Discord bot, on the app admin's word: makes member n the Founder, bringing them in under `name` first if they
	 * aren't in the Order. Unlike setFounder they need not have joined: the Founder may never use the add-on and is still
	 * shown as Founder. Returns { ok, founder, name } or { error }.
	 */
	async botFounder(n, name, by) {
		if (!this.meta) {
			return { error: 'the Order is not founded yet' };
		}
		if (!isNum(n)) {
			return { error: 'no such member' };
		}
		if (n === this.appAdmin) {
			return { error: "the app admin's number can't be the Founder" };
		}
		let m = this.members[n];
		if (!m) {
			const nm = clean(name, LIMITS.name);
			if (!nm) {
				return { error: 'a name is needed to bring them in' };
			}
			if (Object.keys(this.members).length >= LIMITS.members) {
				return { error: 'the Order is full' };
			}
			m = this.members[n] = this.newMember(n, nm, null);
			await this.putMember(n);
			await this.note(0, `${this.nameOf(n)} brought in (${String(by || 'Discord').slice(0, 60)}, on Discord)`);
		}
		if (this.meta.founder !== n) {
			this.meta.founder = n;
			this.meta.admins = this.meta.admins.filter((x) => x !== n);
			await this.ctx.storage.put('meta', this.meta);
			await this.note(0, `${this.nameOf(n)} is now the Founder (${String(by || 'Discord').slice(0, 60)}, on Discord)`);
			this.broadcast();
			this.pushAllOrders();
		}
		return { ok: true, founder: n, name: m.name };
	}
	/** The branches for the Discord bot's pickers: ids, names, rank names (neutral form), chapters, and from which rank chapters open. */
	botStructure() {
		const word = (/** @type {any} */ x) => (x ? String(x.n || x.m || x.f).replace('*', '…') : null);
		return {
			chapterFrom: CHAPTER_FROM,
			most: PLACES,
			branches: STRUCTURE.branches.map((b) => ({
				id: b.id,
				name: b.name,
				tiers: b.tiers.map(word),
				chapters: b.chapters.map((c) => ({ id: c.id, name: c.name, tiers: c.tiers.map(word) })),
			})),
		};
	}
	/**
	 * The Discord bot (on the app admin's word) sets every branch a member holds at once: places [{ b, t, c }], the main
	 * branch first, at most PLACES; [] takes them out of every branch. Same rules as place(). Returns { ok } or { error }.
	 */
	async botPlaces(n, places, by) {
		const m = Number.isInteger(n) ? this.members[n] : null;
		if (!m) {
			return { error: 'no such member' };
		}
		if (!Array.isArray(places) || places.length > PLACES) {
			return { error: `a member holds at most ${PLACES} branches` };
		}
		const next = [];
		for (const x of places) {
			const b = x && this.branch(x.b);
			const t = x && Number(x.t);
			if (!b || !Number.isInteger(t) || t < 1 || t > TIERS) {
				return { error: 'pick a branch and a rank' };
			}
			if (next.some((y) => y.b === b.id)) {
				return { error: 'the same branch twice' };
			}
			const c = typeof x.c === 'string' ? x.c : '';
			if (c && !b.chapters.some((y) => y.id === c)) {
				return { error: 'no such chapter' };
			}
			if (c && t < CHAPTER_FROM) {
				return { error: `chapters are open from rank ${CHAPTER_FROM}` };
			}
			next.push({ b: b.id, t, c });
		}
		const same = JSON.stringify(next) === JSON.stringify(m.places.map((x) => ({ b: x.b, t: x.t, c: x.c || '' })));
		if (!same) {
			m.places = next;
			await this.putMember(m.n);
			const what = next.length ? next.map((x) => this.placeName(x, m)).join(' and ') : 'no branch';
			await this.note(0, `${this.nameOf(m.n)} placed: ${what} (${String(by || 'Discord').slice(0, 60)}, on Discord)`);
			this.broadcast();
			this.pushAllOrders();
		}
		return { ok: true, places: m.places.map((x) => this.placeName(x, m)) };
	}
	/** Takes a member out of one branch: { member, branch }. */
	async unplace(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!m.places.some((x) => x.b === p.branch)) {
			return this.no(ws, 'they are not in that branch', p);
		}
		if (!this.topOver(me, m.n) && !this.leaderOver(me, m.n, p.branch)) {
			return this.no(ws, 'you can only move members below your own rank in a branch you lead', p);
		}
		m.places = m.places.filter((x) => x.b !== p.branch);
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} took ${this.nameOf(m.n)} out of ${this.branch(p.branch).name}`);
		this.ok(ws, p);
		this.broadcast();
		this.pushAllOrders();
	}
	/** Makes a member a Monsignor, or not: { member, on }. The Founder and admins only. */
	async setMonsignor(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.topOver(me, m.n)) {
			return this.no(ws, 'not allowed', p);
		}
		m.mon = p.on === true;
		await this.putMember(m.n);
		const what = m.mon
			? `made ${this.nameOf(m.n)} a ${STRUCTURE.monsignor.name}`
			: `took ${this.nameOf(m.n)}'s ${STRUCTURE.monsignor.name} rank away`;
		await this.note(me, `${this.nameOf(me)} ${what}`);
		this.ok(ws, p);
		this.broadcast();
		this.pushAllOrders();
	}
	/** Gives a member one of the Order's ranks: { member, rank } (an index into STRUCTURE.ranks). The Founder and admins only. */
	async setRank(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		const r = p.rank;
		if (!Number.isInteger(r) || r < 0 || r >= STRUCTURE.ranks.length) {
			return this.no(ws, 'no such rank', p);
		}
		if (!this.topOver(me, m.n)) {
			return this.no(ws, 'not allowed', p);
		}
		if (rankFromDiscord(this, m.n)) {
			return this.no(ws, 'their rank comes from their rank role on Discord', p);
		}
		if ((m.rank || 0) !== r) {
			if (r) {
				m.rank = r;
			} else {
				delete m.rank;
			}
			await this.putMember(m.n);
			await this.note(me, `${this.nameOf(me)} made ${this.nameOf(m.n)} ${STRUCTURE.ranks[r]}`);
		}
		this.ok(ws, p);
		this.broadcast();
	}
	/** Names an app admin, or takes it back: { member, on }. The Founder and the app admin only. */
	async setAdmin(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.isFounder(me) && me !== this.appAdmin) {
			return this.no(ws, 'only the Founder names admins', p);
		}
		if (m.n === this.appAdmin || this.isFounder(m.n)) {
			return this.no(ws, 'they have every power already', p);
		}
		if (!m.pub) {
			return this.no(ws, "they haven't joined with their join code yet", p);
		}
		const admins = this.meta.admins.filter((n) => n !== m.n);
		this.meta.admins = p.on === true ? [...admins, m.n] : admins;
		await this.ctx.storage.put('meta', this.meta);
		const what = p.on === true ? `made ${this.nameOf(m.n)} an admin` : `took ${this.nameOf(m.n)}'s admin powers away`;
		await this.note(me, `${this.nameOf(me)} ${what}`);
		this.ok(ws, p);
		this.broadcast();
		this.pushAllOrders();
	}
	async kick(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (m.n === this.appAdmin) {
			return this.no(ws, 'the app admin stays in the Order', p);
		}
		if (!this.mayRemove(me, m.n)) {
			return this.no(ws, 'you can only remove members below you in every branch they hold', p);
		}
		await this.note(me, `${this.nameOf(me)} removed ${this.nameOf(m.n)}`);
		await endLendTo(this, m.n);
		delete this.members[m.n];
		this.chatRemove(m.n);
		this.meta.admins = this.meta.admins.filter((n) => n !== m.n);
		await this.ctx.storage.put('meta', this.meta);
		await this.putMember(m.n);
		this.ok(ws, p);
		this.broadcast();
	}
	/**
	 * A reset code for a member below you who lost their key, or a new join code for one brought in who hasn't joined:
	 * they sign in with it from their key.
	 */
	async reset(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.mayReset(me, m.n)) {
			return this.no(ws, 'they are not below you', p);
		}
		const hours = m.pub ? LIMITS.resetHours : LIMITS.joinDays * 24;
		m.reset = { code: newCode(), exp: Date.now() + hours * 36e5 };
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} made a ${m.pub ? 'reset' : 'join'} code for ${this.nameOf(m.n)}`);
		this.ok(ws, p, { code: m.reset.code, hours });
	}
	/**
	 * When a member joined the Order, the date on their ID card: { member, at } (ms). The Founder and admins set anyone's
	 * (an admin their own too, not another admin's); a leader those below them, like a reset code.
	 */
	async setSince(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.topOver(me, m.n) && !this.mayReset(me, m.n)) {
			return this.no(ws, 'only someone over them can change when they joined', p);
		}
		const at = joinDay(p.at);
		if (!at) {
			return this.no(ws, 'pick a real day, not in the future', p);
		}
		await this.moveSince(m, at, this.nameOf(me));
		this.ok(ws, p, { at });
	}
	/** Sets member m's join date and tells the Order. */
	async moveSince(m, at, by) {
		if (m.joined === at) {
			return;
		}
		m.joined = at;
		await this.putMember(m.n);
		await this.note(0, `${by} set when ${this.nameOf(m.n)} joined: ${new Date(at).toISOString().slice(0, 10)}`);
		this.broadcast();
	}
	/** The bot's 'since': { member, at, by } (the bot decides who may). */
	async botSince(n, at, by) {
		const m = Number.isInteger(n) ? this.members[n] : null;
		if (!m) {
			return { error: 'no such member' };
		}
		const day = joinDay(at);
		if (!day) {
			return { error: 'pick a real day, not in the future' };
		}
		await this.moveSince(m, day, `${String(by || 'Discord').slice(0, 60)} (on Discord)`);
		return { ok: true, at: day };
	}
	/** The bot makes a member a Monsignor, or not (as the Founder and admins do in Oculus Nihili). */
	async botMonsignor(n, on, by) {
		const m = Number.isInteger(n) ? this.members[n] : null;
		if (!m) {
			return { error: 'no such member' };
		}
		if (typeof on !== 'boolean') {
			return { error: 'on must be true or false' };
		}
		if (m.mon !== on) {
			m.mon = on;
			await this.putMember(m.n);
			const what = on ? `${this.nameOf(m.n)} is now a ${STRUCTURE.monsignor.name}` : `${this.nameOf(m.n)} is no longer a ${STRUCTURE.monsignor.name}`;
			await this.note(0, `${what} (${String(by || 'Discord').slice(0, 60)}, on Discord)`);
			this.broadcast();
			this.pushAllOrders();
		}
		return { ok: true, mon: m.mon };
	}
	/**
	 * Brings in members the Order had before the add-on, at a set place: { people: [{ member, name }], branch, tier,
	 * chapter, mon, since }. Leaders bring people into their branch below their own rank; the Founder and admins also
	 * with no branch, or as Monsignors. Each gets a join code that makes their number theirs when they first sign in
	 * with it.
	 */
	async addMembers(ws, me, p) {
		const list = Array.isArray(p.people) ? p.people : [];
		if (!list.length || list.length > LIMITS.addAtOnce) {
			return this.no(ws, `between 1 and ${LIMITS.addAtOnce} people at once`, p);
		}
		const top = this.isTop(me);
		const b = p.branch ? this.branch(p.branch) : null;
		const t = Number(p.tier);
		const c = typeof p.chapter === 'string' ? p.chapter : '';
		if (p.branch && (!b || !Number.isInteger(t) || t < 1 || t > TIERS)) {
			return this.no(ws, 'pick a branch and a rank', p);
		}
		if (c && (!b || !b.chapters.some((x) => x.id === c) || t < CHAPTER_FROM)) {
			return this.no(ws, `chapters are open from rank ${CHAPTER_FROM}`, p);
		}
		if (!top && !(b && this.leads(me, b.id) && t < this.tierIn(me, b.id) && p.mon !== true)) {
			return this.no(ws, 'you can only bring people in below your own rank in a branch you lead', p);
		}
		if (Object.keys(this.members).length + list.length > LIMITS.members) {
			return this.no(ws, 'the Order would be full', p);
		}
		const people = [];
		for (const x of list) {
			const n = x && x.member;
			const name = clean(x && x.name, LIMITS.name);
			if (!isNum(n) || !name) {
				return this.no(ws, 'each person needs a member number and a name', p);
			}
			if (this.members[n]) {
				return this.no(ws, `#${n} is already in the Order`, p);
			}
			if (n === this.appAdmin) {
				return this.no(ws, `#${n} is the app admin's number: nobody brings it in`, p);
			}
			people.push({ n, name });
		}
		if (new Set(people.map((x) => x.n)).size !== people.length) {
			return this.no(ws, 'a member number is listed twice', p);
		}
		const since = Number(p.since);
		const joined = since > 0 && since <= Date.now() ? since : Date.now();
		const codes = [];
		for (const x of people) {
			const code = newCode();
			this.members[x.n] = this.newMember(x.n, x.name, null, {
				joined,
				places: b ? [{ b: b.id, t, c }] : [],
				mon: p.mon === true,
				reset: { code, exp: Date.now() + LIMITS.joinDays * 864e5 },
			});
			await this.putMember(x.n);
			codes.push({ n: x.n, name: x.name, code });
		}
		await this.note(me, `${this.nameOf(me)} brought in ${people.map((x) => this.nameOf(x.n)).join(', ')}`);
		this.ok(ws, p, { codes, days: LIMITS.joinDays });
		this.broadcast();
	}
	async leave(ws, me, p) {
		if (this.isFounder(me)) {
			return this.no(ws, 'hand the Order to someone else first', p);
		}
		if (me === this.appAdmin) {
			return this.no(ws, 'the app admin stays in the Order', p);
		}
		await this.note(me, `${this.nameOf(me)} left`);
		await endLendTo(this, me);
		delete this.members[me];
		this.chatRemove(me);
		this.meta.admins = this.meta.admins.filter((n) => n !== me);
		await this.ctx.storage.put('meta', this.meta);
		await this.putMember(me);
		this.ok(ws, p);
		this.broadcast();
	}
	/** Hands the Founder's place to another member who has joined; the old Founder keeps their places. */
	async setFounder(ws, me, p) {
		if (!this.isFounder(me)) {
			return this.no(ws, 'only the Founder can do that', p);
		}
		const m = isNum(p.member) ? this.members[p.member] : null;
		if (!m || m.n === me) {
			return this.no(ws, 'no such member', p);
		}
		if (!m.pub) {
			return this.no(ws, "they haven't joined with their join code yet", p);
		}
		this.meta.founder = m.n;
		this.meta.admins = this.meta.admins.filter((n) => n !== m.n);
		await this.ctx.storage.put('meta', this.meta);
		await this.note(me, `${this.nameOf(me)} handed the Founder's place to ${this.nameOf(m.n)}`);
		this.ok(ws, p);
		this.broadcast();
		this.pushAllOrders();
	}

	/** Your own card: bio, picture ('' removes it), the form of your rank names, your element, and who sees your room. */
	async profile(ws, me, p) {
		const m = this.members[me];
		if (typeof p.roomFor === 'string') {
			if (!ROOM_FOR.includes(p.roomFor)) {
				return this.no(ws, 'bad choice', p);
			}
			m.roomFor = p.roomFor;
		}
		if (typeof p.form === 'string') {
			if (!FORMS.includes(p.form)) {
				return this.no(ws, 'bad form', p);
			}
			m.form = p.form;
		}
		if (typeof p.el === 'string') {
			const el = clean(p.el, LIMITS.element);
			if (el && !STRUCTURE.branches.some((b) => b.elements.includes(el))) {
				return this.no(ws, 'no such element', p);
			}
			m.el = el;
		}
		if (typeof p.bio === 'string') {
			m.bio = clean(p.bio, LIMITS.bio);
		}
		if (typeof p.pic === 'string') {
			if (p.pic && (p.pic.length > LIMITS.pic || !PIC_RE.test(p.pic))) {
				return this.no(ws, 'bad picture', p);
			}
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
		const m = isNum(p.member) ? this.members[p.member] : null;
		if (!m) {
			return this.send(ws, { t: 'card', member: p.member, card: null, ...ridOf(p) });
		}
		const pic = (await this.ctx.storage.get(`pic:${m.n}`)) || '';
		this.send(ws, {
			t: 'card',
			member: m.n,
			...ridOf(p),
			card: {
				n: m.n,
				name: m.name,
				form: m.form,
				el: m.el,
				places: m.places,
				mon: m.mon,
				rank: m.rank || 0,
				founder: this.isFounder(m.n),
				keeper: m.n === this.appAdmin,
				bio: m.bio,
				joined: m.joined,
				medals: m.medals || [],
				weapons: this.weaponsOf(m.n),
				carried: this.carriedOf(m.n),
				carry: this.carriedOf(m.n)[0] || 0,
				carryLimit: this.carryLimit(m.n),
				badge: badgeOf(m),
				pic,
				order: this.meta ? ORDER_NAME : '',
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

	/** The about page and whether joining is open (the name is fixed: one sent is ignored). The Founder and admins. */
	async setAbout(ws, me, p) {
		if (!this.isTop(me)) {
			return this.no(ws, 'not allowed', p);
		}
		if (typeof p.about === 'string') {
			this.meta.about = clean(p.about, LIMITS.about);
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
	 * A new order, photo session or notice: { kind, title, body, to, when }. `to` is { all: true } (everyone under
	 * you) or { groups, members }; a session has a time (`when`) for the reminders.
	 */
	async addOrder(ws, me, p) {
		if (!this.mayOrder(me)) {
			return this.no(ws, 'not allowed', p);
		}
		const kind = KINDS.includes(p.kind) ? p.kind : 'order';
		const title = clean(p.title, LIMITS.orderTitle);
		if (!title) {
			return this.no(ws, 'an order needs a title', p);
		}
		const to = p.to && typeof p.to === 'object' ? p.to : {};
		/** @type {{ all?: true, groups?: string[], members?: number[] }} */
		const dest = {};
		if (to.all === true) {
			dest.all = true;
		} else {
			const groups = Array.isArray(to.groups) ? [...new Set(to.groups)] : [];
			const members = Array.isArray(to.members) ? [...new Set(to.members)] : [];
			if (groups.length > LIMITS.orderTo || members.length > LIMITS.orderTo) {
				return this.no(ws, `at most ${LIMITS.orderTo} groups and ${LIMITS.orderTo} members`, p);
			}
			if (
				!groups.every((g) => typeof g === 'string' && this.mayAddress(me, g)) ||
				!members.every((n) => isNum(n) && this.commands(me, n))
			) {
				return this.no(ws, 'orders only go to members below you', p);
			}
			if (!groups.length && !members.length) {
				return this.no(ws, 'pick who it is for', p);
			}
			if (groups.length) {
				dest.groups = groups;
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
			from: this.placeOf(me),
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
	/** Takes an order down: its author, or someone who oversees it. */
	async unorder(ws, me, p) {
		const o = this.orders.get(p.id);
		if (!o) {
			return this.no(ws, 'no such order', p);
		}
		if (o.by !== me && !this.oversees(o, me)) {
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

	// ---- The hunt board: three lists, read one page per alarm (parsing a page takes most of an invocation's CPU on the
	// free plan), the Void Order Prison's pages at least HUNT_GAP apart. Each keeps its last good copy when a read fails.
	//   the hunting board: the prison's volunteers (vo-p.com, pages of contracts)
	//   the bounty board: the prison's escaped inmates, by bounty (vo-p.com, pages of 12)
	//   the Order's bounties: the Holy Order of Void's own sheet (one CSV)
	/** The hunting board's address (a test server points HUNT_BOARD_URL elsewhere). */
	get huntUrl() {
		return typeof this.env.HUNT_BOARD_URL === 'string' && this.env.HUNT_BOARD_URL ? this.env.HUNT_BOARD_URL : HUNT_BOARD_URL;
	}
	/** The bounty board's address (BOUNTY_BOARD_URL for a test server). */
	get bountyUrl() {
		return typeof this.env.BOUNTY_BOARD_URL === 'string' && this.env.BOUNTY_BOARD_URL ? this.env.BOUNTY_BOARD_URL : BOUNTY_BOARD_URL;
	}
	/** The Order's sheet as CSV (ORDER_SHEET_URL for a test server). */
	get sheetUrl() {
		return typeof this.env.ORDER_SHEET_URL === 'string' && this.env.ORDER_SHEET_URL ? this.env.ORDER_SHEET_URL : ORDER_SHEET_CSV;
	}
	/** Starts reading the three lists again (in alarms) if the last time is older than HUNT_EVERY. */
	huntCheck() {
		const every = Number(this.env.HUNT_EVERY) || LIMITS.huntEvery;
		if (Date.now() - this.hunt.tried < every) {
			return;
		}
		// A chain of pages still being read is never restarted (its later pages would never be read, and a new chain
		// would start right after the last page read, without the boards' gap), unless it has been stuck a long time.
		if (Array.isArray(this.hunt.next) && this.hunt.next.length && Date.now() - this.hunt.tried < 3 * every) {
			return;
		}
		this.hunt.tried = Date.now();
		this.hunt.next = [{ k: 'sheet' }, { k: 'hunt', n: 1 }, { k: 'bounty', n: 1 }];
		this.ctx.waitUntil(this.ctx.storage.put('hunt', this.hunt).then(() => this.ctx.storage.setAlarm(Date.now())));
	}
	/**
	 * The board as clients get it: the hunting board's contracts (with its most wanted and the casino's debtors once
	 * each), the bounty board's escaped inmates, the Order's bounties, and the keys the hierarchy has hidden (`hidden`:
	 * Order bounties by their key, escaped inmates as "vop:<prison number>"). Null before anything was read.
	 */
	huntBoard() {
		const pages = Object.keys(this.hunt.pages)
			.map(Number)
			.sort((a, b) => a - b)
			.map((n) => this.hunt.pages[n]);
		const bountyPages = Object.values((this.hunt.bounty && this.hunt.bounty.pages) || {});
		const sheet = this.sheet || { list: [], at: 0 };
		if (!pages.length && !bountyPages.length && !sheet.at) {
			return null;
		}
		const once = (list) => [...new Map(list.map((x) => [x.code, x])).values()];
		const wanted = once(pages.flatMap((p) => p.wanted));
		const seen = new Map([...wanted, ...once(pages.flatMap((p) => p.debtors))].map((x) => [x.code, x]));
		const escaped = once(bountyPages.flatMap((p) => p.inmates)).map((x) => {
			const w = seen.get(x.code);
			return w ? { ...x, lastSeen: w.lastSeen, sightings: w.sightings } : x;
		});
		return {
			contracts: once(pages.flatMap((p) => p.contracts)),
			wanted,
			debtors: once(pages.flatMap((p) => p.debtors)),
			totals: pages.length ? pages[0].totals : null,
			at: pages.length ? Math.min(...pages.map((p) => p.at)) : 0,
			url: this.huntUrl,
			escaped: escaped.sort((a, b) => (b.bounty || 0) - (a.bounty || 0)),
			escapedAt: bountyPages.length ? Math.min(...bountyPages.map((p) => p.at)) : 0,
			order: sheet.list,
			orderAt: sheet.at,
			hidden: Object.keys(this.hunt.hidden || {}),
		};
	}
	/** Sends everyone signed in the board as it is now. */
	huntSend() {
		const out = this.huntBoard();
		for (const { ws } of this.sockets()) {
			this.send(ws, { t: 'hunt', board: out });
		}
	}
	/**
	 * Hides a bounty from the board, or shows it again: { key, on } (the hierarchy's top, for players who asked out of
	 * character to be left alone). `key` is an Order bounty's key or "vop:<prison number>".
	 */
	async hideBounty(ws, me, p) {
		if (!this.isTop(me)) {
			return this.no(ws, 'not allowed', p);
		}
		const key = typeof p.key === 'string' ? p.key.slice(0, 120) : '';
		if (!key) {
			return this.no(ws, 'no such bounty', p);
		}
		this.hunt.hidden ??= {};
		if (p.on === false) {
			delete this.hunt.hidden[key];
		} else {
			this.hunt.hidden[key] = { by: me, at: Date.now() };
		}
		await this.ctx.storage.put('hunt', this.hunt);
		this.ok(ws, p);
		this.huntSend();
	}
	/**
	 * Reads one page of one list (the next in the queue): the first page of a board queues its others. Whatever reads
	 * cleanly replaces its last copy, and everyone signed in gets the new board.
	 */
	async alarm() {
		let job = this.hunt.next.shift();
		if (!job) {
			return;
		}
		// A queue from before the bounty board held the hunting board's addresses.
		if (typeof job === 'string') {
			job = { k: 'hunt', n: Number(new URL(job).searchParams.get('p')) || 1 };
		}
		await this.ctx.storage.put('hunt', this.hunt);
		if (job.k === 'sheet') {
			await this.readSheet();
		} else if (job.k === 'bounty') {
			await this.readBounties(job.n);
		} else {
			await this.readHunting(job.n);
		}
		await this.ctx.storage.put('hunt', this.hunt);
		const next = this.hunt.next[0];
		if (next) {
			const gap = typeof next === 'object' && next.k === 'sheet' ? 1000 : Number(this.env.HUNT_GAP) || LIMITS.huntGap;
			await this.ctx.storage.setAlarm(Date.now() + gap);
		}
	}
	/** One page of the hunting board. */
	async readHunting(n) {
		const board = await fetchHunting(n, this.huntUrl);
		const page = board.page ? board.page.n : 0;
		if (!page || !(board.contracts.length || board.wanted.length)) {
			console.warn('hunt board: page', n, 'did not read', board.problems.slice(0, 5));
			return;
		}
		if (!board.ok) {
			console.warn('hunt board: read with problems', board.problems.slice(0, 5));
		}
		this.hunt.pages[page] = {
			contracts: board.contracts.map((c) => ({ ...c, photo: null })),
			wanted: board.wanted,
			debtors: board.debtors,
			totals: board.totals,
			at: Date.now(),
		};
		if (page === 1) {
			this.hunt.of = Math.min(board.page.of, LIMITS.huntPages);
			for (const k of Object.keys(this.hunt.pages)) {
				if (Number(k) > this.hunt.of) {
					delete this.hunt.pages[k];
				}
			}
			const others = board.pages.filter((p) => p > 1 && p <= this.hunt.of).map((p) => ({ k: 'hunt', n: p }));
			this.hunt.next = [...others, ...this.hunt.next];
		}
		this.huntSend();
	}
	/** One page of the bounty board. */
	async readBounties(n) {
		const board = await fetchBounties(n, this.bountyUrl);
		if (!board.inmates.length) {
			console.warn('bounty board: page', n, 'did not read', board.problems.slice(0, 5));
			return;
		}
		this.hunt.bounty ??= { pages: {}, of: 0 };
		const b = this.hunt.bounty;
		b.pages[n] = { inmates: board.inmates.filter((x) => x.status === 'escaped' || !x.status), at: Date.now() };
		if (n === 1) {
			b.of = Math.min(board.page ? board.page.of : 1, LIMITS.bountyPages);
			for (const k of Object.keys(b.pages)) {
				if (Number(k) > b.of) {
					delete b.pages[k];
				}
			}
			for (let p = 2; p <= b.of; p++) {
				this.hunt.next.push({ k: 'bounty', n: p });
			}
		}
		this.huntSend();
	}
	/** The Order's sheet: kept in its own record, since it can be long. */
	async readSheet() {
		let text = '';
		try {
			const res = await fetch(this.sheetUrl, { signal: AbortSignal.timeout(15000) });
			text = res.ok ? await res.text() : '';
			if (!res.ok) {
				console.warn('order sheet: HTTP', res.status);
			}
		} catch (e) {
			console.warn('order sheet: fetch failed', String(e));
		}
		const sheet = text ? parseOrderSheet(text) : null;
		if (!sheet || sheet.problems.length) {
			console.warn('order sheet: did not read', sheet ? sheet.problems : []);
			return;
		}
		this.sheet = { list: sheet.bounties, at: Date.now() };
		await this.ctx.storage.put('sheet', this.sheet);
		this.huntSend();
	}

	// ---- The Armory
	/** The weapons member n has: those issued to them; every one for the app admin (early access). */
	weaponsOf(n) {
		const m = this.members[n];
		return n === this.appAdmin ? WEAPON_IDS : (m && m.weapons) || [];
	}
	/**
	 * How many weapons member n carries at once, Queen's Wrath not counted (it comes to its Queen when called): 2, and 4
	 * for the app admin (her slime body) or while wearing the Void Paladin power armour.
	 */
	carryLimit(n) {
		const m = this.members[n];
		return n === this.appAdmin || (m && m.armor) ? 4 : 2;
	}
	/**
	 * Whether you wear the Void Paladin power armour, as your own add-on sees it: { on }. Only your own limit follows it.
	 * Taken off, the weapons you carry beyond your limit are put down, the oldest first (Queen's Wrath stays); the answer
	 * names them in `dropped`.
	 */
	async armor(ws, me, p) {
		if (typeof p.on !== 'boolean') {
			return this.no(ws, 'bad request', p);
		}
		const m = this.members[me];
		const was = !!m.armor;
		if (p.on) {
			m.armor = 1;
		} else {
			delete m.armor;
		}
		const carried = this.carriedOf(me);
		const counted = carried.filter((id) => id !== QUEENS_WRATH);
		const put = counted.slice(0, Math.max(0, counted.length - this.carryLimit(me)));
		if (put.length) {
			m.carried = carried.filter((id) => !put.includes(id));
			delete m.carry;
		}
		if (was !== !!m.armor || put.length) {
			await this.putMember(me);
			this.broadcast();
		}
		this.ok(ws, p, { dropped: put.map((id) => (WEAPONS.find((x) => x.id === id) || { name: `weapon ${id}` }).name) });
	}
	/** The weapons member n carries, still theirs (a record from before, with one in `carry`, reads as that one). */
	carriedOf(n) {
		const m = this.members[n];
		if (!m) {
			return [];
		}
		const list = Array.isArray(m.carried) ? m.carried : m.carry ? [m.carry] : [];
		const theirs = this.weaponsOf(n);
		return list.filter((id) => theirs.includes(id));
	}
	/**
	 * Issues a weapon to a member, or takes it back: { member, weapon, on }. The Founder and admins to anyone they act
	 * on (themselves too), a leader to those below them.
	 */
	async issue(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.standsOver(me, m.n)) {
			return this.no(ws, 'you can only issue weapons to members below you', p);
		}
		const w = WEAPONS.find((x) => x.id === p.weapon);
		if (!w) {
			return this.no(ws, 'no such weapon', p);
		}
		const had = (m.weapons || []).filter((id) => id !== w.id);
		m.weapons = p.on === false ? had : [...had, w.id];
		if (p.on === false && m.n !== this.appAdmin) {
			m.carried = this.carriedOf(m.n).filter((id) => id !== w.id);
			delete m.carry;
		}
		await this.putMember(m.n);
		await this.note(
			me,
			`${this.nameOf(me)} ${p.on === false ? 'took back' : 'issued'} ${w.name} ${p.on === false ? 'from' : 'to'} ${this.nameOf(m.n)}`,
		);
		this.ok(ws, p);
		this.broadcast();
	}
	/**
	 * The weapons you carry, all of them yours: { weapons: [ids] }, at most carryLimit of them besides Queen's Wrath.
	 * The older { weapon } (one, or 0 for none) still works.
	 */
	async carry(ws, me, p) {
		const asked = Array.isArray(p.weapons) ? p.weapons : Number(p.weapon) ? [p.weapon] : [];
		const ids = [...new Set(asked.map(Number))];
		if (ids.length > 8 || ids.some((id) => !this.weaponsOf(me).includes(id))) {
			return this.no(ws, 'that weapon is not yours', p);
		}
		const limit = this.carryLimit(me);
		if (ids.filter((id) => id !== QUEENS_WRATH).length > limit) {
			return this.no(ws, `you carry at most ${limit}: put one down first`, p);
		}
		this.members[me].carried = ids;
		delete this.members[me].carry;
		await this.putMember(me);
		this.ok(ws, p);
		this.broadcast();
	}

	// ---- Commendations
	/**
	 * Whether `by` may commend member n: the Founder and admins anyone they act on, a leader those below them in a
	 * branch they lead; never themselves.
	 */
	mayCommend(by, n) {
		return by !== n && this.standsOver(by, n);
	}
	/** A commendation for a member: { member, icon, name, reason }. They keep the newest LIMITS.medals. */
	async award(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		if (!this.mayCommend(me, m.n)) {
			return this.no(ws, 'you can only commend members below you', p);
		}
		const name = clean(p.name, LIMITS.medalName);
		if (!MEDALS.includes(p.icon) || !name) {
			return this.no(ws, 'a commendation needs a picture and a name', p);
		}
		/** @type {Medal} */
		const medal = {
			id: newId(8),
			icon: p.icon,
			name,
			reason: clean(p.reason, LIMITS.medalReason),
			by: me,
			byName: this.members[me].name,
			at: Date.now(),
		};
		m.medals = [...(m.medals || []), medal].slice(-LIMITS.medals);
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} commended ${this.nameOf(m.n)}: ${name}`);
		this.ok(ws, p, { id: medal.id });
		for (const { ws: w, a } of this.sockets()) {
			if (a.member === m.n && this.statusOf(a) === 'member') {
				this.send(w, { t: 'medal', medal });
			}
		}
	}
	/** Takes a commendation back: { member, id }. Whoever gave it, or the Founder and admins (over the member). */
	async unaward(ws, me, p) {
		const m = this.target(ws, p);
		if (!m) {
			return;
		}
		const medal = (m.medals || []).find((x) => x.id === p.id);
		if (!medal) {
			return this.no(ws, 'no such commendation', p);
		}
		if (medal.by !== me && !this.topOver(me, m.n)) {
			return this.no(ws, 'only whoever gave it, the Founder or an admin can take it back', p);
		}
		m.medals = m.medals.filter((x) => x.id !== p.id);
		await this.putMember(m.n);
		await this.note(me, `${this.nameOf(me)} took back ${this.nameOf(m.n)}'s ${medal.name}`);
		this.ok(ws, p);
	}

	// ---- The Order's group chat in SlimeBeep
	/** A POST to the SlimeBeep relay's link API, or null without the key. */
	relay(path, body) {
		const key = this.env.SLIMEBEEP_LINK_KEY;
		const base = this.env.SLIMEBEEP_RELAY;
		if (typeof key !== 'string' || !key || typeof base !== 'string' || !base) {
			return null;
		}
		return fetch(`${base.replace(/\/+$/, '')}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
		});
	}
	/** An invite to the Order's SlimeBeep group for member `me`: { code, gid }, or { already: true, gid }. */
	async chatInvite(ws, me, p) {
		const res = this.relay('/link/invite', { member: me });
		if (!res) {
			return this.no(ws, "the Order chat isn't set up yet", p);
		}
		const r = await res.then((x) => (x.ok ? x.json() : null)).catch(() => null);
		if (!r || typeof r.gid !== 'string') {
			return this.no(ws, 'the Order chat could not be reached, try again later', p);
		}
		if (r.member === true) {
			return this.ok(ws, p, { already: true, gid: r.gid });
		}
		if (typeof r.code !== 'string') {
			return this.no(ws, 'the Order chat could not be reached, try again later', p);
		}
		this.ok(ws, p, { code: r.code, gid: r.gid });
	}
	/** Takes someone who left the Order out of its SlimeBeep group (in the background; errors are ignored). */
	chatRemove(n) {
		const res = this.relay('/link/remove', { member: n });
		if (res) {
			this.ctx.waitUntil(res.catch(() => null));
		}
	}

	// ---- Dice
	/**
	 * Rolls dice for anyone signed in: { dice: [sides…], mod }. The server rolls, so nobody can fake a result; the roll
	 * is kept LIMITS.rollMinutes under an id that others in the room look it up by. Members get LIMITS.rollsPerMinute
	 * rolls a minute; anyone else is counted by number and key, so they can't use up a member's rolls.
	 */
	async roll(ws, a, p) {
		const dice = Array.isArray(p.dice) ? p.dice : [];
		if (!dice.length || dice.length > LIMITS.dice || !dice.every((s) => DICE.includes(s))) {
			return this.no(ws, `roll 1 to ${LIMITS.dice} dice: d${DICE.join(', d')}`, p);
		}
		const mod = p.mod === undefined ? 0 : Number(p.mod);
		if (!Number.isInteger(mod) || Math.abs(mod) > LIMITS.mod) {
			return this.no(ws, `the modifier goes from -${LIMITS.mod} to +${LIMITS.mod}`, p);
		}
		const now = Date.now();
		const gone = [...this.rolls.values()].filter((r, i, all) => now - r.at > LIMITS.rollMinutes * 60000 || all.length - i >= LIMITS.rolls);
		if (gone.length) {
			for (const r of gone) {
				this.rolls.delete(r.id);
			}
			await this.ctx.storage.delete(gone.map((r) => `r:${r.id}`));
		}
		const who = this.statusOf(a) === 'member' ? `m${a.member}` : `g${a.member}:${a.pub.x}`;
		const recent = [...this.rolls.values()].filter((r) => r.who === who && now - r.at < 60000).length;
		if (recent >= LIMITS.rollsPerMinute) {
			return this.no(ws, 'too many rolls, wait a moment', p);
		}
		const faces = dice.map((s) => ({ s, v: randInt(s) }));
		const r = {
			id: newId(12),
			who,
			by: a.member,
			name: a.name,
			dice: faces,
			mod,
			total: faces.reduce((sum, d) => sum + d.v, mod),
			at: now,
		};
		this.rolls.set(r.id, r);
		await this.ctx.storage.put(`r:${r.id}`, r);
		this.ok(ws, p, { roll: this.rollOut(r) });
	}
	/**
	 * A roll by its id, for anyone signed in: { roll, age, later }. `age` (ms) and `later` (rolls the same roller made
	 * after it) let others see an old roll shown again, or one picked out of several.
	 */
	getRoll(ws, p) {
		const r = ROLL_RE.test(p.id || '') ? this.rolls.get(p.id) : null;
		if (!r) {
			return this.send(ws, { t: 'roll', ...ridOf(p), roll: null });
		}
		const later = [...this.rolls.values()].filter((x) => x.who === r.who && x.at > r.at).length;
		this.send(ws, { t: 'roll', ...ridOf(p), roll: this.rollOut(r), age: Date.now() - r.at, later });
	}
	/** A roll as others see it: without who it was counted against. */
	rollOut(r) {
		if (!r) {
			return null;
		}
		return { id: r.id, by: r.by, name: r.name, dice: r.dice, mod: r.mod, total: r.total, at: r.at };
	}
}
