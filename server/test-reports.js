// Bug reports and personal badges against the server: npm run dev:test first (ADMIN 11), then node test-reports.js.
// A fresh Order each run (?o=); every connection comes from one address, so the address limit is what stops the sixth.
const BASE = process.env.SERVER || 'ws://127.0.0.1:8788';
const ORDER = `r${Date.now().toString(36)}`;
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

/** Signs `who` in; everything received is kept in `got`. */
async function connect(who) {
	const ws = new WebSocket(`${BASE}/ws?o=${ORDER}`, { headers: { Origin: 'https://www.bondageprojects.elementfx.com' } });
	const c = { ws, got: [], rid: 0 };
	ws.onmessage = (e) => c.got.push(JSON.parse(e.data));
	while (!c.got.length) await wait(20);
	const hello = c.got.find((x) => x.t === 'hello');
	const sig = b64url(
		await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.priv, new TextEncoder().encode(`${hello.nonce}|void|${who.member}`)),
	);
	ws.send(JSON.stringify({ t: 'auth', member: who.member, name: who.name, pub: who.pub, sig }));
	await wait(300);
	c.req = async (x) => {
		const rid = ++c.rid;
		ws.send(JSON.stringify({ ...x, rid }));
		for (let i = 0; i < 100; i++) {
			const r = c.got.find((y) => y.rid === rid);
			if (r) return r;
			await wait(20);
		}
		return { t: 'timeout' };
	};
	return c;
}

const report = (feature, error, extra = {}) => ({
	t: 'report',
	feature,
	error,
	stack: 'at hookRoom (void.js:1550:12)\nat guard (void.js:108:13)',
	version: '2.0.0-beta.2',
	game: 'R134',
	ua: 'Mozilla/5.0 test',
	at: Date.now(),
	...extra,
});

(async () => {
	const admin = await connect(await makePeer(11, 'Ann'));
	check(
		(await admin.req({ t: 'found', code: 'test-founding-code', name: 'Test Order', myName: 'Ann' })).t === 'ok',
		'the app admin founds a test Order',
	);

	// A visitor (not a member) can send a report; the admin, online, is told about the new kind.
	const v1 = await connect(await makePeer(60, 'Visitor one'));
	const first = await v1.req(report('Room hooks', 'ChatRoomMenuDraw is not a function (line 120)'));
	check(first.t === 'ok' && first.kind === true, 'a visitor sends a report and it is a new kind', first);
	await wait(300);
	check(
		admin.got.some((x) => x.t === 'report' && x.report.feature === 'Room hooks'),
		'the online app admin is told about a new kind',
	);

	// The same failure from another player (other numbers in the message) is counted, not stored twice.
	const v2 = await connect(await makePeer(61, 'Visitor two'));
	const again = await v2.req(report('Room hooks', 'ChatRoomMenuDraw is not a function (line 145)'));
	check(again.t === 'ok' && again.kind === false, 'the same failure again is not a new kind', again);
	const told = admin.got.filter((x) => x.t === 'report').length;
	check(told === 1, 'the admin is told once per kind', told);

	// Too big is refused; long fields are cut to size.
	const big = await v2.req(report('Room hooks', 'x'.repeat(5000)));
	check(big.t === 'error' && big.why === 'report too big', 'a report over 4 KB is refused', big);
	const long = await v2.req(report('Extensions page', `y${'z'.repeat(900)}`, { feature: `F${'f'.repeat(200)}` }));
	check(long.t === 'ok', 'a report with long fields is accepted', long);

	// The admin reads them, newest first, with counts and players.
	const list = await admin.req({ t: 'reports' });
	const hooks = list.reports && list.reports.find((r) => r.feature === 'Room hooks');
	check(!!hooks && hooks.count === 2 && hooks.players.length === 2, 'the room-hooks report shows 2 reports from 2 players', hooks);
	const cut = list.reports && list.reports[0];
	check(
		!!cut && cut.feature.length === 60 && cut.error.length === 300,
		'fields are cut (feature 60, error 300) and newest comes first',
		cut && [cut.feature.length, cut.error.length],
	);
	check(list.reports.length === 2, 'two kinds are kept', list.reports.length);

	// Only the app admin reads or clears them.
	const notAdmin = await v1.req({ t: 'reports' });
	check(notAdmin.t === 'error' && notAdmin.why === 'only the app admin reads reports', 'nobody else reads the reports', notAdmin);
	const notClear = await v1.req({ t: 'clearreports' });
	check(notClear.t === 'error', 'nobody else clears them', notClear);

	// Five an hour from one address (3 accepted so far, the too-big one not counted): two more pass, the sixth doesn't.
	const v3 = await connect(await makePeer(62, 'Visitor three'));
	check((await v3.req(report('Dice', 'roll failed'))).t === 'ok', 'a fourth report from this address passes');
	check((await v3.req(report('Dice', 'roll failed'))).t === 'ok', 'a fifth passes');
	const sixth = await v3.req(report('Dice', 'roll failed'));
	check(sixth.t === 'error' && /too many reports/.test(sixth.why), 'the sixth report from one address within the hour is refused', sixth);

	const clear = await admin.req({ t: 'clearreports' });
	check(clear.t === 'ok', 'the app admin clears every report');
	const empty = await admin.req({ t: 'reports' });
	check(Array.isArray(empty.reports) && empty.reports.length === 0, 'none are left after clearing', empty.reports);

	// Personal badges: the index's member has theirs from the start; the Founder and admins give and take them.
	const queen = await connect(await makePeer(255659, 'Samantha'));
	check((await queen.req({ t: 'join', name: 'Samantha' })).t === 'ok', 'the badge owner joins');
	await wait(300);
	const listed = (c, n) => (c.state || {}).members && c.state.members.find((m) => m.n === n);
	const lastState = (c) => [...c.got].reverse().find((x) => x.t === 'state');
	admin.state = lastState(admin);
	check(listed(admin, 255659)?.badge === 'slime-queen', 'the index member shows their badge from the start', listed(admin, 255659));
	const joiner = await connect(await makePeer(63, 'Joiner'));
	check((await joiner.req({ t: 'join', name: 'Joiner' })).t === 'ok', 'a member joins');
	check((await admin.req({ t: 'badge', member: 63, badge: 'slime-queen' })).t === 'ok', 'an admin gives a member a badge');
	await wait(300);
	admin.state = lastState(admin);
	check(listed(admin, 63)?.badge === 'slime-queen', 'the member list shows it', listed(admin, 63));
	const card = await admin.req({ t: 'card', member: 63 });
	check(card.card && card.card.badge === 'slime-queen', 'their ID card carries it', card.card);
	const notTop = await joiner.req({ t: 'badge', member: 11, badge: '' });
	check(notTop.t === 'error', 'a member without the powers gives no badges', notTop);
	const unknown = await admin.req({ t: 'badge', member: 63, badge: 'nope' });
	check(unknown.t === 'error' && unknown.why === 'no such badge', 'an unknown badge is refused', unknown);
	check((await admin.req({ t: 'badge', member: 255659, badge: '' })).t === 'ok', 'an admin takes the default badge away');
	await wait(300);
	admin.state = lastState(admin);
	check(listed(admin, 255659)?.badge === '', 'taken away, it stays off', listed(admin, 255659));

	console.log(failed ? `${failed} FAILED, ${passed} passed` : `all ${passed} passed`);
	process.exit(failed ? 1 : 0);
})();
