// Plays several members of the Order against the server: npm run dev:test first (ADMIN 11), then node test-server.js.
// Each run uses a fresh Order (?o=), so runs don't see each other.
const BASE = process.env.SERVER || 'ws://127.0.0.1:8788';
const ORDER = `t${Date.now().toString(36)}`;
const { subtle } = globalThis.crypto;
let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the SlimeBeep relay's link API (dev:test points SLIMEBEEP_RELAY here, with the key test-link-key):
 * invites are 'CODE<member>' in group 'g1', members in `inGroup` are in already, and `down` answers 500.
 */
const relay = { calls: [], inGroup: new Set(), down: false };
const relayServer = require('http').createServer((req, res) => {
	let body = '';
	req.on('data', (d) => (body += d));
	req.on('end', () => {
		const p = JSON.parse(body || '{}');
		relay.calls.push({ path: req.url, member: p.member, auth: req.headers.authorization });
		const reply = (status, x) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(x));
		};
		if (relay.down) return reply(500, {});
		if (req.headers.authorization !== 'Bearer test-link-key') return reply(404, {});
		if (req.url === '/link/invite')
			return reply(200, relay.inGroup.has(p.member) ? { member: true, gid: 'g1' } : { code: `CODE${p.member}`, gid: 'g1' });
		if (req.url === '/link/remove') return reply(200, { removed: true });
		reply(404, {});
	});
});
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
	/** Sends a request and waits for its 'ok', 'error', 'card' or 'roll' answer. */
	c.sent = [];
	c.req = async (x) => {
		// The server allows 30 messages per connection in 10 s; a test pauses rather than run into that.
		c.sent = c.sent.filter((t) => Date.now() - t < 10000);
		if (c.sent.length >= 25) {
			await wait(10100 - (Date.now() - c.sent[0]));
		}
		c.sent.push(Date.now());
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
const listed = (c, n) => (c.state.members || []).find((m) => m.n === n);
const placesOf = (c, n) => (listed(c, n) || { places: [] }).places.map((p) => `${p.b}${p.t}${p.c ? `:${p.c}` : ''}`).join(',');
/** A member signs in and joins at once. */
async function joined(member, name) {
	const c = await connect(await makePeer(member, name));
	const r = await c.req({ t: 'join', name });
	return { c, r };
}

(async () => {
	await new Promise((r) => relayServer.listen(8799, '127.0.0.1', r));
	const ann = await makePeer(11, 'Ann');

	const forged = await connect(ann, { badSig: true });
	check(forged.closed && forged.got.some((x) => x.why === 'bad signature'), 'a bad signature is turned away');

	// An empty Order: founding by the app admin only, with the founding code.
	const early = await connect(await makePeer(12, 'Bea'));
	check(
		early.state.status === 'guest' && !early.state.canFound && early.state.meta === null && early.state.structure.branches.length === 5,
		'before founding, others are guests who cannot found; the structure is there already',
		early.state,
	);
	check((await early.req({ t: 'found', name: 'Mine' })).why === 'only the app admin can found the Order', 'someone else cannot found');
	check((await early.req({ t: 'join' })).why === 'the Order is not founded yet', 'nobody joins before the founding');
	early.close();
	const a = await connect(ann, { fields: { room: 'Void Hall' } });
	check(a.state.canFound === true, 'the app admin may found the Order');
	check(
		(await a.req({ t: 'found', name: 'The Void Order', code: 'guess', myName: 'Ann' })).why === 'wrong founding code',
		'founding takes the founding code too',
	);
	const founded = await a.req({ t: 'found', name: 'The Void Order', about: 'We gaze back.', code: 'test-founding-code', myName: 'Ann' });
	check(
		founded.t === 'ok' && a.state.status === 'member' && a.state.meta.founder === 11 && a.state.me.places.length === 0,
		'founding makes Ann the Founder, with no branch',
		a.state,
	);
	const pw = a.state.me.powers;
	check(pw.founder && pw.admin && pw.appAdmin && pw.top, 'she is Founder and app admin', pw);
	check((await a.req({ t: 'found', name: 'Again' })).why === 'unknown', 'the Order is founded once');
	check(listed(a, 11).on === 1 && listed(a, 11).room === 'Void Hall', 'the member list shows who is online and their room');

	// The structure the Order uses.
	const st = a.state.structure;
	const br = (id) => st.branches.find((b) => b.id === id);
	check(
		st.branches.map((b) => `${b.sym} ${b.name}`).join('|') === '☨✙☨ Priest|≈][≈ Inquisitor|✦⸸✦ Paladin|☿⸸☿ Mage|🧹 Maid' &&
			br('priest').tiers[1].f === 'Priestess' &&
			br('maid').tiers[4].m === 'Patron' &&
			br('mage').tiers[0].n === 'Novitate' &&
			br('mage').chapters.find((c) => c.id === 'thought-weavers').tiers[3].n === 'Mind Bender' &&
			st.hybrids['inquisitor+paladin'].n === 'Commisar' &&
			st.hybrids['maid+priest'].f === 'Altar Girl' &&
			Object.keys(st.hybrids).length === 10 &&
			st.monsignor.sym === '🎇',
		'the default structure: five branches, gendered ranks, chapter rank names, ten hybrid titles, Monsignor',
	);

	// Joining: at once, with no place yet.
	const { c: b, r: bj } = await joined(12, 'Bea');
	check(bj.t === 'ok' && b.state.status === 'member' && b.state.me.places.length === 0, 'Bea joins at once, unplaced', b.state);
	check(listed(a, 12) && listed(a, 12).places.length === 0, 'Ann sees Bea waiting for a place');
	check((await b.req({ t: 'join' })).why === 'unknown', 'a member does not join twice');
	check(!b.state.log && !b.state.me.powers.top && !b.state.me.powers.leads.length, 'Bea has no powers yet', b.state.me.powers);
	const { c } = await joined(13, 'Cat');
	const { c: d } = await joined(14, 'Dan');
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 1 })).why, 'an unplaced member places nobody');

	// The Founder places Bea as a Paladin rank 4: she leads the Paladins.
	check((await a.req({ t: 'place', member: 12, branch: 'paladin', tier: 4 })).t === 'ok', 'Ann places Bea: Paladin rank 4');
	check(placesOf(a, 12) === 'paladin4' && b.state.me.powers.leads.join() === 'paladin', 'Bea now leads the Paladins', b.state.me);
	check((await a.req({ t: 'place', member: 12, branch: 'paladin', tier: 6 })).why === 'pick a branch and a rank', 'ranks go 1 to 5');
	check((await a.req({ t: 'place', member: 12, branch: 'bard', tier: 1 })).why === 'pick a branch and a rank', 'only real branches');

	// A branch leader places the unplaced into her branch, below her own rank.
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 2 })).t === 'ok', 'Bea places Cat: Paladin rank 2');
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 4 })).why, 'but not at her own rank');
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 5 })).why, 'or above it');
	check((await b.req({ t: 'place', member: 14, branch: 'priest', tier: 1 })).why, 'and not into a branch she does not lead');
	check((await b.req({ t: 'place', member: 12, branch: 'paladin', tier: 5 })).why, 'she cannot promote herself');
	check(
		(await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 1, chapter: 'salvatoris' })).why === 'chapters are open from rank 2',
		'chapters from rank 2',
	);
	check(
		(await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 2, chapter: 'vox-nihil' })).why === 'no such chapter',
		"only the branch's chapters",
	);
	check(
		(await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 2, chapter: 'salvatoris' })).t === 'ok' &&
			placesOf(a, 13) === 'paladin2:salvatoris',
		'Bea puts Cat in the Salvatoris chapter',
	);
	check(
		a.state.log.some((l) => /placed Cat \(13\): Paladin - Knight/.test(l.text)),
		'the log names the rank: Paladin - Knight',
		a.state.log.slice(-3),
	);

	// A leader can't touch Priests, or Paladins at or above her rank.
	await a.req({ t: 'place', member: 14, branch: 'priest', tier: 3 });
	check(placesOf(a, 14) === 'priest3', 'Ann places Dan: Priest rank 3');
	check((await b.req({ t: 'place', member: 14, branch: 'priest', tier: 2 })).why, 'Bea cannot move a Priest');
	check((await b.req({ t: 'place', member: 14, branch: 'paladin', tier: 1 })).why, 'or add a Priest to the Paladins');
	check((await b.req({ t: 'unplace', member: 14, branch: 'priest' })).why, 'or take him out of his branch');
	check((await b.req({ t: 'kick', member: 14 })).why, 'or remove him');
	check((await b.req({ t: 'reset', member: 14 })).why === 'they are not below you', 'or make him a reset code');
	const fay = await makePeer(15, 'Fay');
	const added = await a.req({ t: 'add', people: [{ member: 15, name: 'Fay' }], branch: 'paladin', tier: 4 });
	check(
		added.t === 'ok' && added.codes.length === 1 && /^[A-Z2-9]{10}$/.test(added.codes[0].code),
		'Ann brings Fay in as a Paladin rank 4',
	);
	const f = await connect(fay, { fields: { code: added.codes[0].code } });
	check(f.state.status === 'member' && f.state.me.powers.leads.join() === 'paladin', 'Fay joins with her code, leading the Paladins too');
	check((await b.req({ t: 'place', member: 15, branch: 'paladin', tier: 3 })).why, 'Bea cannot move Fay, at her own rank');
	check((await b.req({ t: 'kick', member: 15 })).why, 'or remove her');
	check((await f.req({ t: 'place', member: 12, branch: 'paladin', tier: 1 })).why, 'and Fay cannot move Bea');
	check((await b.req({ t: 'place', member: 11, branch: 'paladin', tier: 1 })).why, 'nobody but the Founder acts on the Founder');

	// Hybrids: a second branch; never a third.
	check((await a.req({ t: 'place', member: 13, branch: 'mage', tier: 3 })).t === 'ok', 'Ann adds Cat to the Mages at rank 3');
	check(placesOf(a, 13) === 'paladin2:salvatoris,mage3', 'Cat is a Paladin and a Mage: a hybrid');
	check(
		(await a.req({ t: 'place', member: 13, branch: 'maid', tier: 1 })).why === 'a member holds at most 2 branches',
		'two branches at most',
	);
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 3 })).t === 'ok', 'Bea still promotes Cat in the Paladins');
	check((await b.req({ t: 'kick', member: 13 })).why, 'but cannot remove her from the Order: she is a Mage too');
	check((await b.req({ t: 'unplace', member: 13, branch: 'mage' })).why, 'or take her out of the Mages');
	check((await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 2, chapter: 'salvatoris' })).t === 'ok', 'and back to rank 2');

	// Your own card: the form of your rank names, and your element.
	check((await c.req({ t: 'profile', form: 'x' })).why === 'bad form', 'forms are feminine, masculine or neutral');
	check((await c.req({ t: 'profile', el: 'Lava' })).why === 'no such element', 'elements come from the list');
	check((await c.req({ t: 'profile', form: 'f', el: 'Pyro', bio: 'Burns bright.' })).t === 'ok', 'Cat picks feminine and Pyro');
	const card = await d.req({ t: 'card', member: 13 });
	check(
		card.card &&
			card.card.form === 'f' &&
			card.card.el === 'Pyro' &&
			card.card.places.length === 2 &&
			card.card.bio === 'Burns bright.' &&
			!card.card.mon,
		"Dan looks up Cat's ID card",
		card,
	);

	// Who sees your public room: everyone, only those over you, or nobody.
	c.ws.send(JSON.stringify({ t: 'room', room: 'Shrine' }));
	await wait(300);
	check(listed(d, 13).room === 'Shrine', 'by default everyone in the Order sees Cat’s room');
	check((await c.req({ t: 'profile', roomFor: 'some' })).why === 'bad choice', 'only the three choices');
	check(
		(await c.req({ t: 'profile', roomFor: 'over' })).t === 'ok' && c.state.me.roomFor === 'over',
		'Cat shows it only to those over her',
	);
	check(
		listed(b, 13).room === 'Shrine' && listed(a, 13).room === 'Shrine' && listed(c, 13).room === 'Shrine',
		'Bea, over her, Ann and Cat herself still see it',
	);
	check(listed(d, 13).on === 1 && listed(d, 13).room === '', 'Dan sees her online, not where');
	await c.req({ t: 'profile', roomFor: 'none' });
	check(listed(a, 13).room === '' && listed(b, 13).room === '', 'with nobody, not even the Founder sees it');
	await c.req({ t: 'profile', roomFor: 'all' });

	// Monsignor: an honorary rank the Founder and admins give.
	const { c: g } = await joined(16, 'Gus');
	check((await b.req({ t: 'monsignor', member: 16, on: true })).why === 'not allowed', 'a leader cannot make a Monsignor');
	check((await a.req({ t: 'monsignor', member: 16, on: true })).t === 'ok' && listed(a, 16).mon === 1, 'Ann makes Gus a Monsignor');
	check(g.state.me.powers.leads.length === 0 && !g.state.me.powers.top, 'which gives him no powers');
	check((await b.req({ t: 'place', member: 16, branch: 'paladin', tier: 1 })).why, 'a leader cannot place a Monsignor');
	check((await b.req({ t: 'kick', member: 16 })).why, 'or remove him');
	check((await a.req({ t: 'monsignor', member: 11, on: true })).t === 'ok' && listed(a, 11).mon === 1, 'Ann makes herself a Monsignor');

	// Orders flow down: a leader to the members of her branch below her.
	check((await c.req({ t: 'order', title: 'Up', to: { all: true } })).why === 'not allowed', 'a rank 2 Paladin gives no orders');
	const o1 = await b.req({ t: 'order', title: 'Polish the shields', body: 'Before Friday.', to: { all: true } });
	await wait(200);
	check(
		o1.t === 'ok' && c.orders.has(o1.id) && !d.orders.has(o1.id) && !f.orders.has(o1.id) && !g.orders.has(o1.id),
		"Bea's order to all reaches Cat, not Dan (Priest), Fay (Paladin 4) or Gus",
	);
	check(a.orders.get(o1.id) && !!a.orders.get(o1.id).acks, 'Ann, over Bea, oversees it with its answers');
	check(
		(await b.req({ t: 'order', title: 'x', to: { groups: ['priest'] } })).why === 'orders only go to members below you',
		'Bea cannot order the Priests',
	);
	check(
		(await b.req({ t: 'order', title: 'x', to: { groups: ['paladin/4'] } })).why === 'orders only go to members below you',
		'or her own rank',
	);
	check((await b.req({ t: 'order', title: 'x', to: { members: [14] } })).why === 'orders only go to members below you', 'or Dan by name');
	const o2 = await b.req({ t: 'order', kind: 'notice', title: 'Salvatoris meet', to: { groups: ['paladin:salvatoris'] } });
	await wait(200);
	check(o2.t === 'ok' && c.orders.has(o2.id), 'Bea sends a notice to the Salvatoris chapter: Cat gets it');
	const when = Date.now() + 2 * 36e5;
	const s1 = await a.req({ t: 'order', kind: 'session', title: 'Photo session', to: { groups: ['priest/3', 'monsignor'] }, when });
	await wait(200);
	check(
		s1.t === 'ok' && d.orders.get(s1.id) && g.orders.get(s1.id) && !c.orders.has(s1.id) && d.orders.get(s1.id).when === when,
		'a session for Priests of rank 3 and Monsignors reaches Dan and Gus, not Cat',
	);
	check(
		(await a.req({ t: 'order', kind: 'session', title: 'No time', to: { all: true } })).why === 'a session needs a time',
		'a session needs a time',
	);
	check((await a.req({ t: 'order', title: 'Nobody', to: {} })).why === 'pick who it is for', 'an order needs someone to go to');
	check((await c.req({ t: 'ack', id: o1.id, a: 'yes' })).why === 'bad answer', 'an order is answered read or done');
	check((await c.req({ t: 'ack', id: o1.id, a: 'done' })).t === 'ok', 'Cat answers done');
	check(
		b.orders.get(o1.id).acks[13].a === 'done' && c.orders.get(o1.id).mine.a === 'done' && !c.orders.get(o1.id).acks,
		'Bea sees every answer, Cat only hers',
	);
	check((await d.req({ t: 'ack', id: o1.id, a: 'done' })).why === 'no such order', 'Dan cannot answer an order not meant for him');
	check((await c.req({ t: 'unorder', id: o1.id })).why === 'not allowed', 'Cat cannot take an order down');
	check((await f.req({ t: 'unorder', id: o1.id })).why === 'not allowed', 'nor can Fay, beside Bea');

	// A promotion changes who gets what at once.
	await b.req({ t: 'place', member: 13, branch: 'paladin', tier: 3, chapter: 'salvatoris' });
	const o3 = await b.req({ t: 'order', kind: 'notice', title: 'Rank 3 only', to: { groups: ['paladin/3'] } });
	await wait(200);
	check(o3.t === 'ok' && c.orders.has(o3.id), 'promoted to rank 3, Cat gets the notice for rank 3');

	// Reset codes and removing: a leader over the member.
	const code = await b.req({ t: 'reset', member: 13 });
	check(/^[A-Z2-9]{10}$/.test(code.code || '') && code.hours === 48, 'Bea makes a reset code for Cat', code);
	const cat2 = await makePeer(13, 'Cat');
	const c2bad = await connect(cat2);
	check(c2bad.state.status === 'mismatch', 'a new key without the code is not Cat');
	check((await c2bad.req({ t: 'join' })).why === 'signed in with another key', 'and cannot join over her');
	const c2 = await connect(cat2, { fields: { code: code.code } });
	check(c2.state.status === 'member' && c2.orders.has(o1.id), 'with the code, the new key is Cat, orders and all');
	const reuse = await connect(await makePeer(13, 'Cat'), { fields: { code: code.code } });
	check(reuse.state.status === 'mismatch', 'a reset code works once');
	const { c: e } = await joined(17, 'Eve');
	check((await b.req({ t: 'kick', member: 17 })).t === 'ok' && e.state.status === 'guest', 'a leader removes an unplaced member');
	// One address holds at most 12 connections.
	for (const x of [c, c2bad, reuse, e]) x.close();

	// Bringing people in: leaders into their branch, below their rank.
	check(
		(await b.req({ t: 'add', people: [{ member: 30, name: 'Ivy' }], branch: 'paladin', tier: 4 })).why ===
			'you can only bring people in below your own rank in a branch you lead',
		'Bea cannot bring someone in at her own rank',
	);
	check((await b.req({ t: 'add', people: [{ member: 30, name: 'Ivy' }], branch: 'priest', tier: 1 })).why, 'or into the Priests');
	check((await b.req({ t: 'add', people: [{ member: 30, name: 'Ivy' }] })).why, 'or with no place');
	const ivy = await b.req({
		t: 'add',
		people: [
			{ member: 30, name: 'Ivy' },
			{ member: 31, name: 'Jo' },
		],
		branch: 'paladin',
		tier: 1,
		since: Date.parse('2025-03-01'),
	});
	check(ivy.t === 'ok' && ivy.codes.length === 2 && ivy.days === 7, 'Bea brings in Ivy and Jo as Squires');
	check(
		listed(a, 30).invited === 1 && placesOf(a, 30) === 'paladin1' && listed(a, 30).joined === Date.parse('2025-03-01'),
		'listed as invited, placed, in since the date given',
	);
	const ivyNo = await connect(await makePeer(30, 'Ivy'));
	check(
		ivyNo.state.status === 'invited' && /join code/.test((await ivyNo.req({ t: 'join' })).why),
		'Ivy without her code is pointed to it',
	);
	check(
		(await a.req({ t: 'add', people: [{ member: 11, name: 'Ann' }] })).why === '#11 is already in the Order',
		'nobody is brought in twice',
	);
	const yan = await a.req({ t: 'add', people: [{ member: 32, name: 'Yan' }], mon: true });
	check(yan.t === 'ok' && listed(a, 32).mon === 1 && !listed(a, 32).places.length, 'Ann brings in Yan as a Monsignor with no branch');
	check((await b.req({ t: 'reset', member: 32 })).why === 'they are not below you', 'Bea cannot touch Yan');
	const yanCode = await a.req({ t: 'reset', member: 32 });
	check(yanCode.hours === 168, 'a new join code lasts 7 days');

	// The Founder's place goes to the Order's real founder; the app admin keeps every power.
	const magIn = await a.req({ t: 'add', people: [{ member: 18, name: 'Mag' }] });
	const m = await connect(await makePeer(18, 'Mag'), { fields: { code: magIn.codes[0].code } });
	check(
		(await a.req({ t: 'founder', member: 18 })).t === 'ok' && m.state.me.powers.founder && m.state.meta.founder === 18,
		'Ann hands the Founder place to Mag',
	);
	check(a.state.me.powers.top && a.state.me.powers.admin && !a.state.me.powers.founder, 'Ann, the app admin, keeps every power');
	check((await a.req({ t: 'place', member: 18, branch: 'priest', tier: 5 })).why, 'but cannot act on the Founder');
	check((await a.req({ t: 'kick', member: 18 })).why, 'or remove her');
	check((await b.req({ t: 'admin', member: 14, on: true })).why === 'only the Founder names admins', 'a leader names no admins');
	check((await m.req({ t: 'admin', member: 14, on: true })).t === 'ok' && d.state.me.powers.admin, 'Mag makes Dan an admin');
	check((await a.req({ t: 'place', member: 14, branch: 'priest', tier: 2 })).why, 'admins cannot act on each other');
	check((await m.req({ t: 'place', member: 11, branch: 'priest', tier: 4 })).t === 'ok', 'the Founder acts on the app admin');
	check((await m.req({ t: 'admin', member: 11, on: false })).why === 'they have every power already', 'the app admin stays an admin');
	check((await d.req({ t: 'place', member: 13, branch: 'mage', tier: 4 })).t === 'ok', 'Dan, now an admin, places anyone else');
	check((await m.req({ t: 'admin', member: 14, on: false })).t === 'ok' && !d.state.me.powers.admin, 'and Mag takes it back');
	check((await m.req({ t: 'leave' })).why === 'hand the Order to someone else first', 'the Founder cannot just leave');

	// The about page and closing the door.
	check((await a.req({ t: 'about', about: 'We gaze back.', open: false })).t === 'ok' && !a.state.meta.open, 'Ann closes joining');
	const late = await connect(await makePeer(40, 'Late'));
	check((await late.req({ t: 'join' })).why === 'joining is closed right now', 'nobody joins while it is closed');
	check(
		late.state.members.some((x) => x.n === 18) && late.state.count >= 8 && !late.state.log,
		'guests see the heads and a count, not the log',
	);
	await a.req({ t: 'about', open: true });

	// Dice: the server rolls, keeps the roll, and others look it up by id.
	check((await late.req({ t: 'roll', dice: [7] })).why === 'roll 1 to 10 dice: d4, d6, d8, d10, d12, d20, d100', 'only real dice');
	check((await late.req({ t: 'roll', dice: Array(11).fill(6) })).why, 'at most 10 at once');
	check((await late.req({ t: 'roll', dice: [20], mod: 100 })).why === 'the modifier goes from -99 to +99', 'modifiers up to 99');
	const r1 = await late.req({ t: 'roll', dice: [6, 6, 20, 100], mod: -2 });
	const okFaces = (r) =>
		r.dice.every((x) => x.v >= 1 && x.v <= x.s && Number.isInteger(x.v)) && r.total === r.dice.reduce((s, x) => s + x.v, r.mod);
	check(
		r1.t === 'ok' && /^[a-z0-9]{12}$/.test(r1.roll.id) && r1.roll.by === 40 && okFaces(r1.roll) && !('who' in r1.roll),
		'a guest rolls 2d6+d20+d100-2',
		r1,
	);
	const seen = await c2.req({ t: 'getroll', id: r1.roll.id });
	check(
		JSON.stringify(seen.roll) === JSON.stringify(r1.roll) && seen.age >= 0 && seen.age < 5000 && seen.later === 0,
		'another user fetches the same roll by its id, with its age',
		seen,
	);
	await late.req({ t: 'roll', dice: [20] });
	check((await c2.req({ t: 'getroll', id: r1.roll.id })).later === 1, 'and sees when the roller rolled again after it');
	check((await c2.req({ t: 'getroll', id: 'nonexistent1' })).roll === null, 'an unknown id is no roll');
	const tries = [];
	for (let i = 0; i < 9; i++) {
		tries.push(await b.req({ t: 'roll', dice: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6] }));
	}
	check(
		tries.slice(0, 8).every((r) => r.t === 'ok' && okFaces(r.roll)) && tries[8].why === 'too many rolls, wait a moment',
		'a member rolls 8 times a minute, then waits',
	);
	const fake = await connect(await makePeer(12, 'Not Bea'));
	check((await fake.req({ t: 'roll', dice: [20] })).t === 'ok', "someone claiming Bea's number has their own count, not hers");
	const faces = tries.slice(0, 8).flatMap((r) => r.roll.dice.map((x) => x.v));
	check(new Set(faces).size === 6, 'eighty d6 show every face', [...new Set(faces)]);

	// Commendations: the Founder and admins give them to anyone they act on, a leader to those below her.
	const md = await b.req({ t: 'award', member: 13, icon: 'shield', name: 'Shield of the Void', reason: 'Held the line.' });
	await wait(200);
	check(md.t === 'ok' && c2.got.some((x) => x.t === 'medal' && x.medal.name === 'Shield of the Void'), 'Bea commends Cat, who hears of it');
	check(
		(await b.req({ t: 'award', member: 14, icon: 'star', name: 'x' })).why === 'you can only commend members below you',
		'but not Dan, a Priest',
	);
	check((await b.req({ t: 'award', member: 12, icon: 'star', name: 'x' })).why === 'you can only commend members below you', 'nor herself');
	check(
		(await c2.req({ t: 'award', member: 30, icon: 'star', name: 'x' })).why === 'you can only commend members below you',
		'Cat commends nobody',
	);
	check(
		(await b.req({ t: 'award', member: 13, icon: 'banana', name: 'x' })).why === 'a commendation needs a picture and a name',
		'only the Order’s pictures',
	);
	check(
		(await b.req({ t: 'award', member: 13, icon: 'star', name: ' ' })).why === 'a commendation needs a picture and a name',
		'and a name',
	);
	const catCard = (await d.req({ t: 'card', member: 13 })).card;
	check(
		catCard.medals.length === 1 &&
			catCard.medals[0].icon === 'shield' &&
			catCard.medals[0].reason === 'Held the line.' &&
			catCard.medals[0].byName === 'Bea',
		'her card shows it: picture, name, reason, who and when',
		catCard.medals,
	);
	check((await f.req({ t: 'unaward', member: 13, id: md.id })).why, 'Fay cannot take back Bea’s commendation');
	check((await b.req({ t: 'unaward', member: 13, id: md.id })).t === 'ok', 'Bea takes hers back');
	await a.req({ t: 'award', member: 13, icon: 'eye', name: 'First' });
	for (let i = 0; i < 30; i++) await a.req({ t: 'award', member: 13, icon: 'star', name: `Star ${i}` });
	const kept = (await d.req({ t: 'card', member: 13 })).card.medals;
	check(kept.length === 30 && kept[0].name === 'Star 0' && kept[29].name === 'Star 29', 'a member keeps the newest 30', kept.length);
	const fromAnn = kept[29].id;
	await b.req({ t: 'award', member: 13, icon: 'rose', name: 'Rose' });
	const roseId = (await d.req({ t: 'card', member: 13 })).card.medals.find((x) => x.name === 'Rose').id;
	check((await d.req({ t: 'unaward', member: 13, id: roseId })).why, 'Dan, no longer an admin, takes nothing back');
	check((await a.req({ t: 'unaward', member: 13, id: roseId })).t === 'ok', 'an admin takes back anyone’s');
	check((await a.req({ t: 'unaward', member: 13, id: fromAnn })).t === 'ok', 'and her own');

	// The Order's group chat in SlimeBeep: the server asks the relay for an invite, and takes leavers out.
	const inv = await c2.req({ t: 'chat' });
	check(inv.t === 'ok' && inv.code === 'CODE13' && inv.gid === 'g1', 'a member gets an invite to the Order chat', inv);
	check(
		relay.calls.some((x) => x.path === '/link/invite' && x.member === 13 && x.auth === 'Bearer test-link-key'),
		'the server asks the relay with its key, for her number',
	);
	relay.inGroup.add(13);
	const again = await c2.req({ t: 'chat' });
	check(again.t === 'ok' && again.already === true && again.gid === 'g1' && !again.code, 'someone in it already gets no new invite', again);
	check((await late.req({ t: 'chat' })).why === 'not a member', 'guests get no invite');
	relay.down = true;
	check(/could not be reached/.test((await c2.req({ t: 'chat' })).why), 'a relay that fails is reported, not passed on');
	relay.down = false;
	check(
		relay.calls.some((x) => x.path === '/link/remove' && x.member === 17),
		'Eve, removed earlier, was taken out of the chat',
	);
	const kimIn = await a.req({ t: 'add', people: [{ member: 19, name: 'Kim' }] });
	const kim = await connect(await makePeer(19, 'Kim'), { fields: { code: kimIn.codes[0].code } });
	await kim.req({ t: 'leave' });
	await wait(300);
	check(
		relay.calls.some((x) => x.path === '/link/remove' && x.member === 19),
		'someone who leaves is taken out of the chat',
	);
	kim.close();

	// Everything is kept.
	b.close();
	const b2 = await connect(await makePeer(12, 'Bea'));
	check(b2.state.status === 'mismatch', 'another key is not Bea');
	const bAgain = a.state.members.find((x) => x.n === 12);
	check(bAgain && placesOf(a, 12) === 'paladin4', 'Bea is still a Paladin rank 4');
	check(
		a.state.log && a.state.log.some((l) => /Bea \(12\) commended Cat \(13\): Rose/.test(l.text)),
		'the log records commendations',
		a.state.log.slice(-5),
	);

	// Too many messages at once.
	for (let i = 0; i < 40; i++) late.ws.send(JSON.stringify({ t: 'card', member: 12 }));
	await wait(500);
	check(
		late.got.some((x) => x.why === 'slow down'),
		'a flood is slowed down',
	);

	for (const x of [a, d, f, g, m, c2, late, fake, b2, forged]) {
		try {
			x.close();
		} catch (err) {
			/* closed */
		}
	}
	await wait(500);

	// Connections that never sign in are closed after 10 s, and one address holds at most 12.
	const raw = () => new WebSocket(`${BASE}/ws?o=${ORDER}`, { headers: { Origin: 'https://www.bondageprojects.elementfx.com' } });
	const idle = raw();
	let idleTold = false;
	idle.onmessage = (ev) => {
		idleTold = idleTold || JSON.parse(ev.data).why === 'sign in first';
	};
	await wait(11000);
	const poke = await connect(await makePeer(41, 'Poke'));
	await wait(300);
	check(idleTold && idle.readyState >= 2, 'a connection that never signs in is closed after 10 seconds');
	poke.close();
	await wait(300);
	const many = [];
	let refused = 0;
	for (let i = 0; i < 13; i++) {
		const x = raw();
		x.onerror = () => refused++;
		many.push(x);
	}
	await wait(1500);
	check(refused >= 1, `one address can't hold more than 12 connections (${refused} refused)`);
	for (const x of many) {
		x.close();
	}
	await wait(500);

	// Joining: at most 5 from one address an hour (Bea, Cat, Dan, Gus and Eve came from here).
	const visitor = await connect(await makePeer(50, 'Visitor'));
	check(
		(await visitor.req({ t: 'join' })).why === 'too many joined from here, try again in an hour',
		'one address can only join a few an hour',
	);
	visitor.close();
	console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
	relayServer.close();
	process.exit(failed ? 1 : 0);
})();
