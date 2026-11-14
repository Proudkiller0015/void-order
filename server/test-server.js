// Plays several members of the Order against the server: npm run dev:test first (FOUNDER 11), then node test-server.js.
// Each run uses a fresh Order (?o=), so runs don't see each other.
const BASE = process.env.SERVER || 'ws://127.0.0.1:8788';
const ORDER = `t${Date.now().toString(36)}`;
const { subtle } = globalThis.crypto;
let failed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (!ok) {
		failed++;
	}
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A player with their own P-256 key. */
async function makePeer(member, name) {
	const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const jwk = await subtle.exportKey('jwk', pair.publicKey);
	return { member, name, priv: pair.privateKey, pub: { x: jwk.x, y: jwk.y } };
}
const sign = async (who, text) => b64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.priv, new TextEncoder().encode(text)));

/** Signs `who` in; everything received is kept in `got`, the newest state in `state`. */
async function connect(who, extra = {}) {
	const ws = new WebSocket(`${BASE}/ws?o=${ORDER}`, { headers: { Origin: 'https://www.bondageprojects.elementfx.com' } });
	const c = { ws, got: [], closed: null, state: null, orders: new Map(), rid: 0 };
	ws.onmessage = (e) => {
		const x = JSON.parse(e.data);
		c.got.push(x);
		if (x.t === 'state') c.state = x;
		if (x.t === 'orders') c.orders = new Map(x.orders.map((o) => [o.id, o]));
		if (x.t === 'order') c.orders.set(x.o.id, x.o);
		if (x.t === 'unorder') c.orders.delete(x.id);
	};
	ws.onclose = (e) => {
		c.closed = e.code || 'closed';
	};
	await new Promise((res) => {
		const t = setInterval(() => {
			if (c.got.length || c.closed) {
				clearInterval(t);
				res();
			}
		}, 20);
	});
	const hello = c.got.find((x) => x.t === 'hello');
	const sig = extra.badSig ? b64url(new Uint8Array(64)) : await sign(extra.signWith || who, `${hello.nonce}|void|${who.member}`);
	ws.send(JSON.stringify({ t: 'auth', member: who.member, name: who.name, pub: (extra.signWith || who).pub, sig, ...extra.fields }));
	await wait(300);
	/** Sends a request and waits for its 'ok', 'error' or 'card' answer. */
	c.req = async (x) => {
		const rid = ++c.rid;
		ws.send(JSON.stringify({ ...x, rid }));
		for (let i = 0; i < 100; i++) {
			const r = c.got.find((y) => y.rid === rid);
			if (r) {
				await wait(120);
				return r;
			}
			await wait(20);
		}
		return { t: 'timeout' };
	};
	c.close = () => ws.close();
	return c;
}
const rankId = (c, name) => (c.state.ranks.find((r) => r.name === name) || {}).id;
const listed = (c, n) => (c.state.members || []).find((m) => m.n === n);

(async () => {
	const ann = await makePeer(11, 'Ann');
	const bea = await makePeer(12, 'Bea');
	const cat = await makePeer(13, 'Cat');
	const dan = await makePeer(14, 'Dan');

	const forged = await connect(ann, { badSig: true });
	check(forged.closed && forged.got.some((x) => x.why === 'bad signature'), 'a bad signature is turned away');

	// Founding: only the FOUNDER number may.
	const b = await connect(bea);
	check(
		b.state.status === 'guest' && !b.state.canFound && b.state.meta === null,
		'before founding, others are guests who cannot found',
		b.state,
	);
	check((await b.req({ t: 'found', name: 'Mine' })).why === 'only the founder can found the Order', 'someone else cannot found the Order');
	const a = await connect(ann, { fields: { room: 'Void Hall' } });
	check(a.state.canFound === true, 'the founder number may found the Order');
	const founded = await a.req({ t: 'found', name: 'The Void Order', about: 'We gaze back.', myName: 'Ann' });
	check(
		founded.t === 'ok' && a.state.status === 'member' && a.state.ranks.map((r) => r.name).join() === 'Head,Member',
		'founding makes Ann the founder at Head',
		a.state,
	);
	check(
		a.state.me.power === -1 && a.state.me.perms.join() === 'approve,order,manage',
		'the founder stands above every rank with every right',
		a.state.me,
	);
	check((await a.req({ t: 'found', name: 'Again' })).why === 'unknown', 'the Order is founded once');
	check(listed(a, 11).on === 1 && listed(a, 11).room === 'Void Hall', 'the member list shows who is online and their room', listed(a, 11));

	// What guests see.
	await wait(200);
	check(
		b.state.meta.name === 'The Void Order' && b.state.members.length === 1 && b.state.count === 1 && !b.state.apps,
		'guests see the about page and the heads, not the whole list',
		b.state,
	);

	// The about page and joining questions.
	check(
		(await a.req({ t: 'about', about: 'We gaze back.', questions: ['Why the Void?', '', 'Who sent you?'], open: true })).t === 'ok',
		'the founder sets the joining questions',
	);
	check(b.state.meta.questions.join('|') === 'Why the Void?|Who sent you?', 'empty questions are dropped', b.state.meta);

	// The rank ladder: the founder renames Head and adds Inquisitor and Paladin.
	const head = rankId(a, 'Head');
	const member = rankId(a, 'Member');
	const ladder = [
		{ id: head, name: 'Void Lord', sym: '⸸', color: '#9b59ff', perms: ['approve', 'order', 'manage'] },
		{ id: '', name: 'Inquisitor', sym: '≈][≈', color: '#c0a0ff', perms: ['approve', 'order', 'manage'] },
		{ id: '', name: 'Paladin', sym: '✦⸸✦', color: '#7fd4ff', perms: ['order'] },
		{ id: member, name: 'Acolyte', sym: '', color: 'bad', perms: ['fly'] },
	];
	check((await a.req({ t: 'ranks', ranks: ladder })).t === 'ok', 'the founder sets the rank ladder');
	const inq = rankId(a, 'Inquisitor');
	const pal = rankId(a, 'Paladin');
	const aco = rankId(a, 'Acolyte');
	check(
		aco === member && /^[a-z0-9]{6}$/.test(inq) && a.state.ranks[3].color === '#8f86b8' && a.state.ranks[3].perms.length === 0,
		'kept ranks keep their id, new ones get one, bad colours and rights are dropped',
		a.state.ranks,
	);

	// Applying.
	check(
		(await b.req({ t: 'apply', name: 'Bea', answers: ['To serve.', 'Kikuri'] })).t === 'ok' && b.state.status === 'applied',
		'Bea applies with her answers',
	);
	check(a.state.apps && a.state.apps[0].n === 12 && a.state.apps[0].answers[1] === 'Kikuri', 'the founder sees the application');
	const c = await connect(cat);
	check((await c.req({ t: 'approve', member: 12 })).why === 'not a member', 'a guest cannot approve');
	check(
		(await a.req({ t: 'approve', member: 12, rank: inq })).t === 'ok' && b.state.status === 'member' && listed(a, 12).rank === inq,
		'the founder lets Bea in as Inquisitor',
		b.state,
	);
	check(
		b.state.me.perms.join() === 'approve,order,manage' && b.state.me.power === 1,
		'Bea has the Inquisitor rights and place',
		b.state.me,
	);

	// Cat applies; Bea approves, but only into ranks below her own.
	await c.req({ t: 'apply', name: 'Cat', answers: ['Curious'] });
	check(
		(await b.req({ t: 'approve', member: 13, rank: head })).why === 'you can only give ranks below your own',
		'Bea cannot let someone in above her',
	);
	check((await b.req({ t: 'approve', member: 13, rank: inq })).why === 'you can only give ranks below your own', 'or at her own rank');
	check(
		(await b.req({ t: 'approve', member: 13 })).t === 'ok' && listed(b, 13).rank === aco,
		'with no rank picked, Cat joins at the lowest',
	);

	// Ranks: Bea changes only what is below her.
	const bLadder = b.state.ranks.map((r) => ({ ...r }));
	bLadder[0].name = 'Mine Now';
	check(
		(await b.req({ t: 'ranks', ranks: bLadder })).why === 'you can only change ranks below your own',
		'Bea cannot change ranks at or above hers',
	);
	const bLadder2 = b.state.ranks.map((r) => ({ ...r }));
	bLadder2[2].name = 'Paladin of the Void';
	check(
		(await b.req({ t: 'ranks', ranks: bLadder2 })).t === 'ok' && rankId(a, 'Paladin of the Void') === pal,
		'Bea renames Paladin, below her',
	);
	check(
		(await b.req({ t: 'ranks', ranks: bLadder2.filter((r) => r.id !== aco) })).why === 'Cat still holds a rank you removed',
		'a rank someone holds cannot be removed',
	);

	// Promotions, titles, and only on those below.
	check((await b.req({ t: 'rank', member: 13, rank: pal })).t === 'ok' && c.state.me.rank === pal, 'Bea makes Cat a Paladin');
	check(
		(await b.req({ t: 'rank', member: 13, rank: inq })).why === 'you can only give ranks below your own',
		'Bea cannot raise Cat to her own rank',
	);
	check((await b.req({ t: 'rank', member: 11, rank: aco })).why === 'they are not below you', 'Bea cannot touch the founder');
	check((await c.req({ t: 'title', member: 13, title: 'Me' })).why === 'not allowed', 'a Paladin cannot give titles');
	check(
		(await b.req({ t: 'title', member: 13, title: 'Keeper of Cameras' })).t === 'ok' && listed(a, 13).title === 'Keeper of Cameras',
		'Bea gives Cat a title',
	);

	// Orders.
	const o1 = await c.req({ t: 'order', kind: 'order', title: 'Polish the altar', body: 'Before Friday.', to: { all: true } });
	check(
		o1.t === 'ok' && a.orders.has(o1.id) && b.orders.has(o1.id) && c.orders.has(o1.id),
		'a Paladin posts an order to everyone; all get it',
		o1,
	);
	const when = Date.now() + 2 * 36e5;
	const s1 = await a.req({ t: 'order', kind: 'session', title: 'Photo session', body: 'Club room, uniforms.', to: { ranks: [pal] }, when });
	check(
		s1.t === 'ok' && c.orders.get(s1.id) && c.orders.get(s1.id).when === when && !b.orders.has(s1.id),
		'a session for Paladins reaches Cat, not Bea',
		[...b.orders.keys()],
	);
	check(
		(await a.req({ t: 'order', kind: 'session', title: 'No time', to: { all: true } })).why === 'a session needs a time',
		'a session needs a time',
	);
	check(
		(await a.req({ t: 'order', title: 'Nobody', to: { members: [999] } })).why === 'pick who it is for',
		'an order needs someone to go to',
	);
	check((await c.req({ t: 'ack', id: s1.id, a: 'done' })).why === 'bad answer', 'a session is answered yes, maybe or no');
	check((await c.req({ t: 'ack', id: s1.id, a: 'yes' })).t === 'ok', 'Cat says yes to the session');
	check(
		a.orders.get(s1.id).acks[13].a === 'yes' && c.orders.get(s1.id).mine.a === 'yes' && !c.orders.get(s1.id).acks,
		'the author sees every answer, Cat only her own',
		c.orders.get(s1.id),
	);
	check((await b.req({ t: 'ack', id: s1.id, a: 'yes' })).why === 'no such order', 'Bea cannot answer a session not meant for her');
	await b.req({ t: 'ack', id: o1.id, a: 'done' });
	check(
		b.orders.get(o1.id).acks && b.orders.get(o1.id).acks[12].a === 'done',
		"Bea, above Cat, sees the answers to Cat's order",
		b.orders.get(o1.id),
	);
	const dm = await b.req({ t: 'order', kind: 'notice', title: 'For Cat', to: { members: [13] } });
	check(c.orders.has(dm.id) && a.orders.has(dm.id), 'a notice to one member reaches them, and the founder above sees it');

	// ID cards, for anyone signed in.
	const d = await connect(dan);
	check((await b.req({ t: 'profile', pic: 'data:text/html;base64,AAAA' })).why === 'bad picture', 'only image pictures');
	check(
		(await b.req({ t: 'profile', bio: 'Watcher.', pic: 'data:image/png;base64,iVBORw0KGgo=' })).t === 'ok',
		'Bea sets her bio and picture',
	);
	const card = await d.req({ t: 'card', member: 12 });
	check(
		card.card &&
			card.card.rank.name === 'Inquisitor' &&
			card.card.rank.sym === '≈][≈' &&
			card.card.pic.startsWith('data:image/png') &&
			card.card.bio === 'Watcher.' &&
			card.card.order === 'The Void Order',
		'a guest looks up Bea’s ID card',
		card,
	);
	check((await d.req({ t: 'card', member: 99 })).card === null, 'no card for a non-member');
	check((await d.req({ t: 'orders' })).why === 'not a member', 'guests get no orders');

	// Rooms: only members are listed online.
	d.ws.send(JSON.stringify({ t: 'room', room: 'Lobby' }));
	b.ws.send(JSON.stringify({ t: 'room', room: 'Shrine' }));
	await wait(300);
	check(listed(a, 12).room === 'Shrine' && !listed(a, 14), 'a member’s room shows; a guest is not listed', a.state.members);

	// Lost key: a reset code from above moves the number to a new key.
	const code = await b.req({ t: 'reset', member: 13 });
	check(/^[A-Z2-9]{10}$/.test(code.code || ''), 'Bea makes a reset code for Cat', code);
	const cat2 = await makePeer(13, 'Cat');
	const c2bad = await connect(cat2);
	check(c2bad.state.status === 'mismatch', 'a new key without the code is not Cat');
	check((await c2bad.req({ t: 'apply', answers: [] })).why === 'signed in with another key', 'and cannot apply over her');
	const c2 = await connect(cat2, { fields: { code: code.code } });
	check(c2.state.status === 'member' && c2.orders.has(s1.id), 'with the code, the new key is Cat, orders and all');
	const cOld = await connect(cat);
	check(cOld.state.status === 'mismatch', 'the old key no longer is');
	const reuse = await connect(await makePeer(13, 'Cat'), { fields: { code: code.code } });
	check(reuse.state.status === 'mismatch', 'a reset code works once');

	// Kicks and taking orders down.
	check((await c2.req({ t: 'kick', member: 12 })).why === 'not allowed', 'a Paladin cannot kick');
	const kicked = await b.req({ t: 'kick', member: 13 });
	check(kicked.t === 'ok' && c2.state.status === 'guest' && !listed(a, 13), 'Bea removes Cat; Cat is a guest now', [
		kicked,
		c2.state.status,
		listed(a, 13),
	]);
	check((await b.req({ t: 'unorder', id: s1.id })).why === 'not allowed', "Bea cannot take down the founder's session");
	check(
		(await a.req({ t: 'unorder', id: o1.id })).t === 'ok' && !b.orders.has(o1.id),
		"the founder takes down departed Cat's order; it goes for everyone",
	);

	// Leaving, and the founder handing over.
	check((await a.req({ t: 'leave' })).why === 'hand the Order to someone else first', 'the founder cannot just leave');
	check(
		(await a.req({ t: 'founder', member: 12 })).t === 'ok' && b.state.me.power === -1 && a.state.me.power === 0,
		'the founder hands the Order to Bea; Ann stays at the top rank',
	);
	check((await b.req({ t: 'kick', member: 11 })).t === 'ok' && a.state.status === 'guest', 'the new founder outranks Ann');

	// Everything is kept.
	b.close();
	const b2 = await connect(bea);
	check(
		b2.state.status === 'member' && b2.state.ranks.length === 4 && b2.state.meta.founder === 12 && b2.orders.has(s1.id),
		'signing in again finds it all kept',
	);
	check(b2.state.log && b2.state.log.some((l) => /let Bea \(12\) in/.test(l.text)), 'the log records who let whom in', b2.state.log);

	// Going offline is noticed.
	b2.ws.send(JSON.stringify({ t: 'room', room: 'Shrine' }));
	const watcher = await connect(ann);
	await b2.req({ t: 'rank', member: 11, rank: aco }).catch(() => {});
	await watcher.req({ t: 'apply', answers: ['back'] });
	await b2.req({ t: 'approve', member: 11 });
	check(listed(watcher, 12) && listed(watcher, 12).on === 1, 'Ann sees Bea online');
	b2.close();
	await wait(600);
	check(listed(watcher, 12) && !listed(watcher, 12).on, 'and offline once she goes', listed(watcher, 12));

	// Too many messages at once.
	for (let i = 0; i < 40; i++) d.ws.send(JSON.stringify({ t: 'card', member: 12 }));
	await wait(500);
	check(
		d.got.some((x) => x.why === 'slow down'),
		'a flood is slowed down',
	);

	for (const x of [a, b, c, d, c2, c2bad, cOld, reuse, watcher, forged]) {
		try {
			x.close();
		} catch (e) {
			/* closed */
		}
	}
	console.log(failed ? `${failed} FAILED` : 'all passed');
	process.exit(failed ? 1 : 0);
})();
