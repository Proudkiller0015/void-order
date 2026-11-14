// The attacks the November security review found, each tried against the server: npm run dev:test first (ADMIN 11),
// then node test-security.js. A fresh Order each run (?o=). Before the fixes the attacks here went through (12 failures).
const BASE = process.env.SERVER || 'ws://127.0.0.1:8788';
const ORDER = `s${Date.now().toString(36)}`;
const { subtle } = globalThis.crypto;
let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function makePeer(member, name) {
	const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const jwk = await subtle.exportKey('jwk', pair.publicKey);
	return { member, name, priv: pair.privateKey, pub: { x: jwk.x, y: jwk.y } };
}
const sign = async (who, text) => b64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.priv, new TextEncoder().encode(text)));

/** Signs `who` in (with a reset or join code in `code` if given); keeps every message and the newest state. */
async function connect(who, code) {
	const ws = new WebSocket(`${BASE}/ws?o=${ORDER}`, { headers: { Origin: 'https://www.bondageprojects.elementfx.com' } });
	const c = { ws, got: [], state: null, orders: new Map(), rid: 0, sent: [] };
	ws.onmessage = (e) => {
		const x = JSON.parse(e.data);
		c.got.push(x);
		if (x.t === 'state') c.state = x;
		if (x.t === 'orders') c.orders = new Map(x.orders.map((o) => [o.id, o]));
		if (x.t === 'order') c.orders.set(x.o.id, x.o);
		if (x.t === 'unorder') c.orders.delete(x.id);
	};
	while (!c.got.length) await wait(20);
	const hello = c.got.find((x) => x.t === 'hello');
	const sig = await sign(who, `${hello.nonce}|void|${who.member}`);
	ws.send(JSON.stringify({ t: 'auth', member: who.member, name: who.name, pub: who.pub, sig, ...(code ? { code } : {}) }));
	await wait(300);
	c.req = async (x) => {
		c.sent = c.sent.filter((t) => Date.now() - t < 10000);
		if (c.sent.length >= 25) await wait(10100 - (Date.now() - c.sent[0]));
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
async function joined(member, name) {
	const c = await connect(await makePeer(member, name));
	await c.req({ t: 'join', name });
	return c;
}
const ordersNow = async (c) => {
	await c.req({ t: 'orders' });
	return c.orders;
};

(async () => {
	const ann = await connect(await makePeer(11, 'Ann'));
	check((await ann.req({ t: 'found', about: 'x', code: 'test-founding-code', myName: 'Ann' })).t === 'ok', 'Ann founds the Order');
	const bea = await joined(12, 'Bea');
	const cat = await joined(13, 'Cat');
	const gwen = await joined(30, 'Gwen');
	const pat = await joined(31, 'Pat');
	const lea = await joined(40, 'Lea');
	// Five joins per address an hour: the others are brought in by Ann and sign in with their join codes.
	const broughtIn = async (member, name, branch, tier) => {
		const r = await ann.req({ t: 'add', people: [{ member, name }], branch, tier });
		check(r.t === 'ok' && r.codes && r.codes[0], `Ann brings in ${name}`, r);
		return connect(await makePeer(member, name), r.codes[0].code);
	};
	const sam = await broughtIn(41, 'Sam', 'inquisitor', 5);
	const tom = await broughtIn(42, 'Tom', 'paladin', 2);
	const place = async (member, branch, tier) => {
		const r = await ann.req({ t: 'place', member, branch, tier });
		check(r.t === 'ok', `Ann places #${member}: ${branch} ${tier}`, r);
	};
	await place(12, 'paladin', 5);
	await place(30, 'mage', 5);
	await place(30, 'priest', 1);
	await place(31, 'priest', 4);
	await place(40, 'paladin', 4);
	await place(13, 'paladin', 1);

	// 1. Problem reports: claiming the app admin's number with another key reads and wipes nothing.
	check((await cat.req({ t: 'report', feature: 'Orders', error: 'boom from Cat' })).t === 'ok', 'a member files a report');
	const stranger = await connect(await makePeer(11, 'Ann?'));
	check(stranger.state && stranger.state.status === 'mismatch', 'a stranger claiming #11 is signed in as a mismatch');
	check((await stranger.req({ t: 'reports' })).t !== 'reports', 'the stranger cannot read the reports');
	check((await stranger.req({ t: 'clearreports' })).t !== 'ok', 'the stranger cannot clear them');
	const seen = await ann.req({ t: 'reports' });
	check(seen.t === 'reports' && seen.reports.some((r) => r.error === 'boom from Cat'), 'the reports are all still there', seen);
	const fake12 = await connect(await makePeer(12, 'Bea?'));
	check((await fake12.req({ t: 'report', feature: 'Orders', error: 'planted' })).t === 'ok', 'a stranger may still file a report');
	const planted = (await ann.req({ t: 'reports' })).reports.find((r) => r.error === 'planted');
	check(planted && !planted.players.includes(12), "but it names nobody: Bea's number isn't credited", planted);
	stranger.close();
	fake12.close();

	// 2. A hybrid member: Gwen is Mage 5 and Priest 1; Pat is Priest 4 and over her in Priest only.
	check((await pat.req({ t: 'kick', member: 30 })).t !== 'ok', 'Pat cannot remove Gwen');
	const code = await pat.req({ t: 'reset', member: 30 });
	check(code.t !== 'ok' && !code.code, "Pat cannot make Gwen's reset code (it would hand him her number)", code);
	check((await pat.req({ t: 'issue', member: 30, weapon: 1, on: true })).t !== 'ok', 'Pat cannot issue Gwen weapons');
	check((await pat.req({ t: 'award', member: 30, icon: '⭐', name: 'Test', reason: 'x' })).t !== 'ok', 'Pat cannot commend Gwen');
	// Orders are messages, not powers: a leader still reaches a hybrid member in the branch they lead (by design).
	check(
		(await pat.req({ t: 'order', title: 'Priests, pray', to: { members: [30] } })).t === 'ok',
		"Pat's order still reaches Gwen in the Priests",
	);
	check((await ann.req({ t: 'reset', member: 30 })).t === 'ok', 'Ann (over everyone) still makes reset codes');
	check((await bea.req({ t: 'reset', member: 42 })).t === 'ok', 'a leader still makes them for those below her');

	// 3. The app admin stays in the Order, so her number can never be joined by someone else.
	check((await ann.req({ t: 'leave' })).t !== 'ok', 'the app admin cannot leave');
	check((await ann.req({ t: 'founder', member: 12 })).t === 'ok', "Ann hands the Founder's place to Bea");
	check((await bea.req({ t: 'kick', member: 11 })).t !== 'ok', 'the new Founder cannot remove the app admin');
	check((await bea.req({ t: 'add', people: [{ member: 11, name: 'Ann' }] })).t !== 'ok', 'nobody brings #11 in');
	const s11 = await connect(await makePeer(11, 'Ann?'));
	check((await s11.req({ t: 'join', name: 'Ann?' })).t !== 'ok', "a stranger cannot join with the app admin's number");
	check(!(s11.state && s11.state.me && s11.state.me.powers && s11.state.me.powers.top), 'and has no powers');
	s11.close();

	// 4. An order whose author left reaches only those who were below that author.
	const posted = await lea.req({ t: 'order', title: 'Paladins, assemble', to: { all: true } });
	check(posted.t === 'ok', 'Lea (Paladin 4) posts an order to everyone below her');
	const id = [...(await ordersNow(lea)).keys()].pop();
	check(!(await ordersNow(sam)).has(id), 'Sam (Inquisitor 5) does not get it');
	check((await ordersNow(tom)).has(id), 'Tom (Paladin 2) does');
	check((await lea.req({ t: 'leave' })).t === 'ok', 'Lea leaves the Order');
	check(!(await ordersNow(sam)).has(id), "with Lea gone, Sam still doesn't get her order");
	check((await sam.req({ t: 'ack', id, a: 'yes' })).t !== 'ok', 'and cannot answer it');
	check((await ordersNow(tom)).has(id), 'Tom, who was below her, still has it');

	// Small ones: no object keys as member numbers; Queen's Wrath lent only to members, back when they go.
	const card = await cat.req({ t: 'card', member: '__proto__' });
	check(card.t === 'card' && card.card === null, '"__proto__" is no member card', card);
	check((await bea.req({ t: 'founder', member: '__proto__' })).t !== 'ok', '"__proto__" is no member to hand the Order to');
	check((await ann.req({ t: 'lend', member: 999999 })).t !== 'ok', "Queen's Wrath is lent only to a member");
	check((await ann.req({ t: 'lend', member: 13 })).t === 'ok', 'Ann lends it to Cat');
	check((await cat.req({ t: 'leave' })).t === 'ok', 'Cat leaves the Order');
	await wait(300);
	check(ann.state && !ann.state.lent, 'and the lend ends with her', ann.state && ann.state.lent);

	for (const c of [ann, bea, gwen, pat, sam, tom]) c.close();
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
