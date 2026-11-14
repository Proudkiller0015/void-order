// The Void Order in the real game, headless, never logged in: fake chat rooms as Ann (11, the app admin, who founds
// the Order) and Fay (15, a Paladin who leads), the local server (cd server && npm run dev:test), and Bea, Cat, Dan and
// Gus played from here. Run: node test.js. SHOTS=1 saves pictures to shots/.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

// A local Bondage Club checkout (its BondageClub folder) and a Chrome to run it in.
const ROOT = process.env.BC_ROOT;
const CHROME = process.env.CHROME;
if (!ROOT || !CHROME) {
	console.error('Set BC_ROOT (a Bondage Club checkout: its BondageClub folder) and CHROME (the Chrome executable).');
	process.exit(2);
}
const PORT = 8178;
const SERVER = process.env.SERVER || 'ws://127.0.0.1:8788';
const ORDER = `c${Date.now().toString(36)}`;
const SHOTS = !!process.env.SHOTS;
const TYPES = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.png': 'image/png',
	'.csv': 'text/csv',
	'.txt': 'text/plain',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.mp3': 'audio/mpeg',
};
/** The hunt board's pages, from the server's fixtures; Bea (12) has the first page's first contract. */
const BOARD = ['hunt-board.html', 'hunt-board-2.html'].map((f) =>
	fs.readFileSync(path.join(__dirname, 'server', 'test', 'fixtures', f), 'utf8'),
);
BOARD[0] = BOARD[0].replace('BC #100037', 'BC #12');
/**
 * A stand-in for the SlimeBeep relay's link API (dev:test points the server here): invites are 'CODE<member>'. It
 * serves the hunt board too (dev:test's HUNT_BOARD_URL).
 */
const relay = http.createServer((req, res) => {
	if (req.url.startsWith('/hunt-board')) {
		res.writeHead(200, { 'content-type': 'text/html' });
		return res.end(BOARD[/[?&]p=2\b/.test(req.url) ? 1 : 0]);
	}
	let body = '';
	req.on('data', (d) => (body += d));
	req.on('end', () => {
		const member = JSON.parse(body || '{}').member;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(req.url === '/link/invite' ? { code: `CODE${member}`, gid: 'g1' } : { removed: true }));
	});
});
const web = http.createServer((req, res) => {
	const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
	fs.readFile(p, (err, data) => {
		if (err) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream' });
		res.end(data);
	});
});
let failed = 0;
let passed = 0;
const check = (name, ok, got) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 500)})`}`);
	if (ok) passed++;
	else failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Members played from here.
const { subtle } = globalThis.crypto;
async function peer(member, name, code = '') {
	const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const jwk = await subtle.exportKey('jwk', pair.publicKey);
	const ws = new WebSocket(`${SERVER}/ws?o=${ORDER}`, { headers: { Origin: 'http://localhost' } });
	const c = { got: [], state: null, orders: new Map(), rid: 0 };
	ws.onmessage = async (e) => {
		const x = JSON.parse(e.data);
		c.got.push(x);
		if (x.t === 'hello') {
			const sig = Buffer.from(
				await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${x.nonce}|void|${member}`)),
			).toString('base64url');
			ws.send(JSON.stringify({ t: 'auth', member, name, pub: { x: jwk.x, y: jwk.y }, sig, ...(code ? { code } : {}) }));
		}
		if (x.t === 'state') c.state = x;
		if (x.t === 'orders') c.orders = new Map(x.orders.map((o) => [o.id, o]));
		if (x.t === 'order') c.orders.set(x.o.id, x.o);
	};
	c.req = async (x) => {
		const rid = ++c.rid;
		ws.send(JSON.stringify({ ...x, rid }));
		for (let i = 0; i < 100; i++) {
			const r = c.got.find((y) => y.rid === rid);
			if (r) return r;
			await wait(30);
		}
		return { t: 'timeout' };
	};
	c.close = () => ws.close();
	for (let i = 0; i < 100 && !c.state; i++) await wait(30);
	return c;
}

/**
 * A page with the game: `me` in a fake chat room with `other`, and the add-on pointed at the local server.
 * @param {any} browser
 * `slimebeep` puts a stand-in for SlimeBeep's add-on API on the page, recording the groups it joins in `sbJoined`.
 * @param {{ me: [number, string], other: [number, string], settings?: object, slimebeep?: boolean }} who
 */
async function gamePage(browser, { me, other, settings = {}, slimebeep = false }) {
	const page = await browser.newPage();
	await page.setViewport({ width: 1600, height: 900 });
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
	await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 120000 });
	await page.waitForFunction(() => typeof Asset !== 'undefined' && Asset.length > 1000 && typeof Player !== 'undefined' && !!Player, {
		timeout: 120000,
	});
	await wait(1500);
	await page.evaluate(
		(server, order, settings, me, other) => {
			cancelAnimationFrame(GameAnimationFrameId);
			GameRun = () => {};
			Player.Type = CharacterType.PLAYER;
			Player.MemberNumber = me[0];
			Player.Name = Player.Nickname = me[1];
			Player.GhostList = [];
			Player.BlackList = [];
			Player.WhiteList = [];
			Player.FriendList = [];
			Player.ExtensionSettings = { ...settings };
			Player.OnlineSharedSettings = { GameVersion };
			CharacterAppearanceSetDefault(Player);
			const them = CharacterLoadOnline(
				{
					ID: 'o',
					Name: other[1],
					Nickname: other[1],
					MemberNumber: other[0],
					AssetFamily: 'Female3DCG',
					Appearance: [],
					Title: '',
					Ownership: null,
					Lovership: [],
					ItemPermission: 1,
					BlockItems: [],
					LimitedItems: [],
					FavoriteItems: [],
					WhiteList: [],
					BlackList: [],
					OnlineSharedSettings: {},
					ArousalSettings: {},
					Game: {},
					Inventory: [],
				},
				me[0],
			);
			ChatRoomData = {
				Name: 'Void Hall',
				Visibility: ['All'],
				Admin: [me[0]],
				Whitelist: [],
				Ban: [],
				BlockCategory: [],
				Character: [],
				MapData: {},
			};
			ChatRoomCharacter = [Player, them];
			CurrentScreen = 'ChatRoom';
			window.sent = [];
			window.local = [];
			window.synced = [];
			ServerSend = (msg, data) => window.sent.push([msg, data]);
			ChatRoomSendLocal = (text) => window.local.push(String(text));
			ServerPlayerExtensionSettingsSync = (k) => window.synced.push(k);
			window.VoidOrderServer = `${server}/ws?o=${order}`;
			// Every dice tray that opens, in order.
			window.trays = [];
			new MutationObserver(() => {
				const t = document.getElementById('void-dice');
				if (t && window.trays[window.trays.length - 1] !== t.dataset.roll) window.trays.push(t.dataset.roll);
			}).observe(document.body, { childList: true });
		},
		SERVER,
		ORDER,
		settings,
		me,
		other,
	);
	if (slimebeep) {
		await page.evaluate(() => {
			window.sbJoined = [];
			window.SlimeBeep = {
				api: {
					joinGroup: async (code) => {
						window.sbJoined.push(code);
						return { ok: true, gid: 'g1' };
					},
					group: () => null,
				},
			};
		});
	}
	await page.addScriptTag({ path: path.join(__dirname, 'void.js') });
	await page.waitForFunction(() => Commands.some((c) => c.Tag === 'void'), { timeout: 10000 });
	return { page, errors };
}
const shot = async (page, name) => {
	if (!SHOTS) return;
	fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
	await wait(150);
	await page.screenshot({ path: path.join(__dirname, 'shots', `${name}.png`) });
};
/** Clicks the panel button (or tab) whose text starts with `text`, the `nth` one. */
const click = (page, text, nth = 0) =>
	page.evaluate(
		(text, nth) => {
			const b = [...document.querySelectorAll('#void-panel button')].filter((x) => x.textContent.trim().startsWith(text))[nth];
			if (!b) return false;
			b.click();
			return true;
		},
		text,
		nth,
	);
/** Types into the panel's nth input/textarea matching `sel`. */
const type = (page, sel, text, nth = 0) =>
	page.evaluate(
		(sel, text, nth) => {
			const el = document.querySelectorAll(`#void-panel ${sel}`)[nth];
			el.value = text;
			el.dispatchEvent(new Event('input'));
			el.blur();
		},
		sel,
		text,
		nth,
	);
const panelText = (page) => page.evaluate(() => document.getElementById('void-panel')?.innerText || '');
const slash = (page, args) => page.evaluate((args) => Commands.find((c) => c.Tag === 'void').Action(args, `/void ${args}`, []), args);
/**
 * In Manage, places the member named `name` from the add-a-branch line of their box: picks the branch, the rank and
 * the chapter (each pick redraws the panel), then clicks Place.
 */
async function placeVia(page, name, branch, tier, chapter = '') {
	const pick = (i, value) =>
		page.evaluate(
			(name, i, value) => {
				const box = [...document.querySelectorAll('#void-panel .box')].find((b) =>
					b.querySelector('.row .grow')?.textContent.startsWith(`${name} #`),
				);
				const line = [...box.querySelectorAll('.place')].pop();
				const sel = line.querySelectorAll('select')[i];
				sel.value = value;
				sel.dispatchEvent(new Event('change'));
			},
			name,
			i,
			value,
		);
	await pick(0, branch);
	await pick(1, String(tier));
	if (chapter) await pick(2, chapter);
	return page.evaluate((name) => {
		const box = [...document.querySelectorAll('#void-panel .box')].find((b) =>
			b.querySelector('.row .grow')?.textContent.startsWith(`${name} #`),
		);
		const b = [...box.querySelectorAll('.place button')].pop();
		b.click();
		return b.textContent;
	}, name);
}
/** The ID lines of the open card, as written (the card shows some in capitals). */
/** Clicks the checkbox of the setting whose label starts with `text`, in the panel's ⚙ Settings tab. */
async function toggleSetting(page, text) {
	await click(page, '⚙ Settings');
	return page.evaluate((text) => {
		const l = [...document.querySelectorAll('#void-panel label.check')].find((x) => x.textContent.trim().startsWith(text));
		const c = l.querySelector('input');
		c.checked = !c.checked;
		c.dispatchEvent(new Event('change'));
		return c.checked;
	}, text);
}
/** Picks a choice (by its text) for the setting whose label starts with `text`, in the ⚙ Settings tab. */
async function chooseSetting(page, text, choice) {
	await click(page, '⚙ Settings');
	return page.evaluate(
		(text, choice) => {
			const row = [...document.querySelectorAll('#void-panel .setting')].find((x) => x.textContent.trim().startsWith(text));
			const sel = row.querySelector('select');
			sel.value = [...sel.options].find((o) => o.textContent === choice).value;
			sel.dispatchEvent(new Event('change'));
		},
		text,
		choice,
	);
}
const cardText = (page) => page.evaluate(() => [...document.querySelectorAll('#void-card .id .ln')].map((l) => l.textContent).join('\n'));
const openCardOf = async (page, name) => {
	await page.evaluate(() => document.getElementById('void-card')?.remove());
	await page.evaluate(
		(name) => [...document.querySelectorAll('#void-panel .member')].find((m) => m.textContent.startsWith(name)).click(),
		name,
	);
	await page.waitForSelector('#void-card', { timeout: 5000 });
};

(async () => {
	await new Promise((r) => web.listen(PORT, r));
	await new Promise((r) => relay.listen(8799, '127.0.0.1', r));
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
	const peers = [];
	try {
		const { page, errors } = await gamePage(browser, { me: [11, 'Ann'], other: [12, 'Bea'] });
		check('/void is registered once the game is ready', true);
		await page.waitForFunction(() => window.synced.includes('VoidOrder'), { timeout: 10000 });
		const saved = await page.evaluate(() => Player.ExtensionSettings.VoidOrder);
		check('a key is made and saved in the account settings', typeof saved === 'string' && saved.length > 20);

		// Founding.
		await slash(page, '');
		await page.waitForFunction(() => /Found the Order/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 10000 });
		await shot(page, '01-found');
		await type(page, 'textarea', 'We gaze into the Void, and it gazes back.');
		await type(page, 'input:not([type])', 'test-founding-code', 1);
		await click(page, 'Found the Order');
		await page.waitForFunction(() => /Orders/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 });
		const tabs = await page.evaluate(() => [...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent).join('|'));
		check('founding gives the Founder every tab', tabs === 'Orders|Members|The Order|Dice|🎯 Hunt board|Manage|My card|⚙ Settings', tabs);

		// Bea joins at once and waits for a place; Ann places her from Manage as a Paladin rank 5.
		const bea = await peer(12, 'Bea');
		peers.push(bea);
		await bea.req({ t: 'join', name: 'Bea' });
		await wait(400);
		const badge = await page.evaluate(() => document.querySelector('#void-panel nav .badge')?.textContent);
		check('Manage shows one member awaiting a place', badge === '1', badge);
		await click(page, 'Manage');
		check('Bea is listed under Awaiting placement', /Awaiting placement · 1\s+Bea #12/i.test(await panelText(page)), await panelText(page));
		await shot(page, '02-awaiting-placement');
		await placeVia(page, 'Bea', 'paladin', 5);
		await wait(500);
		check('Ann places Bea: Paladin rank 5', JSON.stringify(bea.state.me.places) === '[{"b":"paladin","t":5,"c":""}]', bea.state.me);

		// More members, placed by the hierarchy.
		const cat = await peer(13, 'Cat');
		const dan = await peer(14, 'Dan');
		peers.push(cat, dan);
		for (const [p, name] of [
			[cat, 'Cat'],
			[dan, 'Dan'],
		])
			await p.req({ t: 'join', name });
		check(
			'Bea, leading the Paladins, places Cat: Knight of Salvatoris',
			(await bea.req({ t: 'place', member: 13, branch: 'paladin', tier: 2, chapter: 'salvatoris' })).t === 'ok',
		);
		// Gus was a Paladin before the add-on: Bea brings him in as a Crusader, and he joins with his code.
		const gusIn = await bea.req({ t: 'add', people: [{ member: 16, name: 'Gus' }], branch: 'paladin', tier: 4 });
		const gus = await peer(16, 'Gus', gusIn.codes[0].code);
		peers.push(gus);
		check(
			'Bea brings Gus in as a Crusader with a join code',
			gus.state.status === 'member' && gus.state.me.places[0].t === 4,
			gus.state.me,
		);
		await wait(400);
		await placeVia(page, 'Cat', 'mage', 3, 'conjurers');
		await wait(400);
		check('Ann adds Cat to the Mages, Conjurers: a hybrid', cat.state.me.places.length === 2, cat.state.me);
		await placeVia(page, 'Dan', 'priest', 3, 'vox-nihil');
		await wait(400);
		await cat.req({ t: 'profile', form: 'f', bio: 'Blade and spell.' });
		await dan.req({ t: 'profile', form: 'f' });
		// Ann makes herself a Monsignor from her own box.
		await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .box')].find((b) => /\(you\)/.test(b.textContent));
			const c = [...box.querySelectorAll('label.check')].find((l) => /Monsignor/.test(l.textContent)).querySelector('input');
			c.checked = true;
			c.dispatchEvent(new Event('change'));
		});
		await wait(500);
		check('Ann makes herself a Monsignor', bea.state.members.find((m) => m.n === 11)?.mon === 1);

		// Fay joins from the game: at once, from the join button.
		const fay = await gamePage(browser, { me: [15, 'Fay'], other: [11, 'Ann'], slimebeep: true });
		await slash(fay.page, '');
		await fay.page.waitForFunction(() => /Join the Order/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 10000 });
		await click(fay.page, 'Join the Order');
		await fay.page.waitForFunction(() => /Orders/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 });
		const fayStatus = await fay.page.evaluate(() => document.querySelector('#void-panel .status').textContent);
		check('Fay joins at once, awaiting placement', fayStatus === 'Awaiting placement', fayStatus);
		await click(page, 'Members');
		await click(page, 'Manage');
		await placeVia(page, 'Fay', 'paladin', 4);
		await wait(600);
		const fayTabs = await fay.page.evaluate(() =>
			[...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent).join('|'),
		);
		check('placed as a Paladin rank 4, Fay leads: she gets Manage', /Manage/.test(fayTabs), fayTabs);
		await fay.page.waitForFunction(() => window.sbJoined.length > 0, { timeout: 8000 }).catch(() => {});
		check(
			'running SlimeBeep, Fay is put in the Order chat once she is a member',
			(await fay.page.evaluate(() => window.sbJoined.join())) === 'SB-g1-CODE15' &&
				(await fay.page.evaluate(() => window.local.some((l) => /in the Void Order chat in SlimeBeep/.test(l)))),
			await fay.page.evaluate(() => [window.sbJoined, window.local]),
		);

		// The members by branch, then by rank from 5 down to 1.
		await click(page, 'Members');
		await wait(200);
		const list = await panelText(page);
		check(
			'the member list: the Founder, Monsignor, then each branch by rank',
			/𓁹‿𓁹 Founder 𓁹‿𓁹\s+Ann #11[\s\S]*🎇 Monsignor 🎇 · 1[\s\S]*Ann #11[\s\S]*☨✙☨ Priest ☨✙☨ · 1[\s\S]*Leaders of spiritual[\s\S]*HIGH PRIEST \/ HIGH PRIESTESS\s+Dan #14 · High Priestess · Vox Nihil[\s\S]*✦⸸✦ Paladin ✦⸸✦ · 4[\s\S]*CHAMPION\s+Bea #12 · Champion[\s\S]*CRUSADER[\s\S]*Fay #15 · Crusader[\s\S]*Gus #16 · Crusader[\s\S]*KNIGHT\s+Cat #13 · Knight · Salvatoris\s+Warmage[\s\S]*☿⸸☿ Mage ☿⸸☿ · 1[\s\S]*…MANCER\s+Cat #13 · Spellblade · Conjurers/.test(
				list,
			),
			list,
		);
		await shot(page, '03-members-by-branch');

		// ID cards in the Order's format.
		await openCardOf(page, 'Dan');
		const dCard = await cardText(page);
		check(
			'an ID card: the motto, (Branch) - (Rank), the chapter',
			dCard === 'Praise the Void! 𓁹‿𓁹\n☨✙☨Priest - High Priestess☨✙☨\nVox Nihil',
			dCard,
		);
		await shot(page, '04-card');
		await openCardOf(page, 'Cat');
		const cCard = await cardText(page);
		check(
			"a hybrid's card: the title, then each branch with rank and chapter",
			cCard === 'Praise the Void! 𓁹‿𓁹\nWarmage\n✦⸸✦Paladin - Knight, Salvatoris✦⸸✦\n☿⸸☿Mage - Spellblade, Conjurers☿⸸☿',
			cCard,
		);
		check(
			'the card keeps the name, number, bio and member-since',
			/Cat[\s\S]*Member #13[\s\S]*Blade and spell\.[\s\S]*In the Order since/.test(
				await page.evaluate(() => document.getElementById('void-card').innerText),
			),
		);
		await shot(page, '05-card-hybrid');
		await page.evaluate(() => document.getElementById('void-card').remove());
		await openCardOf(page, 'Ann');
		check(
			"the Founder's card: Founder and Monsignor",
			/^Praise the Void! 𓁹‿𓁹\n.*Founder.*\n.*Monsignor/.test(await cardText(page)),
			await cardText(page),
		);
		await page.evaluate(() => document.getElementById('void-card').remove());

		// Commendations: Ann commends Cat from Manage; the card shows the medal, and Ann takes it back from there.
		await click(page, 'Manage');
		/** Clicks a button in a member's box in Manage: the one whose text starts with `text`, or the medal picture `icon`. */
		const inBox = (name, text, icon = '') =>
			page.evaluate(
				(name, text, icon) => {
					const box = [...document.querySelectorAll('#void-panel .box')].find((b) =>
						b.querySelector('.row .grow')?.textContent.startsWith(`${name} #`),
					);
					const b = icon
						? box.querySelector(`.medal-pick button[data-icon="${icon}"]`)
						: [...box.querySelectorAll('button')].find((x) => x.textContent.startsWith(text));
					b.click();
				},
				name,
				text,
				icon,
			);
		await inBox('Cat', '🎖 Commend');
		await inBox('Cat', '', 'shield');
		await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .box')].find((b) =>
				b.querySelector('.row .grow')?.textContent.startsWith('Cat #'),
			);
			const [name, reason] = box.querySelectorAll('input:not([type])');
			name.value = 'Shield of the Void';
			name.dispatchEvent(new Event('input'));
			reason.value = 'Held the gate <b>alone</b>.';
			reason.dispatchEvent(new Event('input'));
		});
		await inBox('Cat', 'Award');
		await wait(500);
		await click(page, 'Members');
		await openCardOf(page, 'Cat');
		const medalCard = await page.evaluate(() => {
			const card = document.getElementById('void-card');
			return {
				row: card.querySelectorAll('.medals svg').length,
				tip: card.querySelector('.medals svg title')?.textContent,
				text: card.innerText,
				bold: !!card.querySelector('.commend b b'),
			};
		});
		check(
			'the card shows the medal and its commendation, text as written',
			medalCard.row === 1 &&
				/^Shield of the Void: Held the gate <b>alone<\/b>\. \(from Ann, /.test(medalCard.tip || '') &&
				/COMMENDATIONS[\s\S]*Shield of the Void · Held the gate <b>alone<\/b>\.[\s\S]*from Ann/.test(medalCard.text) &&
				!medalCard.bold,
			medalCard,
		);
		await shot(page, '17-card-commendations');
		await page.evaluate(() =>
			[...document.querySelectorAll('#void-card .commend button')].find((b) => b.textContent === 'Take back').click(),
		);
		await page.waitForFunction(() => !document.querySelector('#void-card .medals'), { timeout: 5000 }).catch(() => {});
		check(
			'Ann takes it back from the card',
			await page.evaluate(() => !!document.getElementById('void-card') && !document.querySelector('#void-card .medals')),
		);
		await page.evaluate(() => document.getElementById('void-card')?.remove());
		await fay.page.evaluate(() => (window.local = []));
		await bea.req({ t: 'award', member: 15, icon: 'star', name: 'Steadfast' });
		await fay.page
			.waitForFunction(() => window.local.some((l) => /Bea commended you: Steadfast/.test(l)), { timeout: 5000 })
			.catch(() => {});
		check('Fay hears she was commended', await fay.page.evaluate(() => window.local.some((l) => /Bea commended you: Steadfast/.test(l))));

		// A branch leader's Manage: only the Paladins below her, and those awaiting a place.
		const eve = await peer(17, 'Eve');
		peers.push(eve);
		await eve.req({ t: 'join', name: 'Eve' });
		await wait(400);
		await click(fay.page, 'Manage');
		await wait(200);
		const fm = await panelText(fay.page);
		check('a rank 4 Paladin manages Cat (rank 2) and places Eve', /Awaiting placement · 1\s+Eve #17[\s\S]*Cat #13/i.test(fm), fm);
		check('but not Bea (rank 5), Gus (rank 4), Dan (a Priest) or Ann', !/Bea #12|Gus #16|Dan #14|Ann #11/.test(fm), fm);
		const fayRanks = await fay.page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .box')].find((b) => /^Cat #13/.test(b.textContent));
			return [...box.querySelectorAll('.place')].map(
				(l) =>
					[...l.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent).join('/')).join(' | ') ||
					l.innerText.replace(/\s+/g, ' '),
			);
		});
		check(
			"Cat's Paladin ranks go up to Paladin (3) for Fay; her Mage branch is read-only",
			fayRanks[0].startsWith('1. Squire/2. Knight/3. Paladin |') && /Mage.*Spellblade/.test(fayRanks[1]),
			fayRanks,
		);
		await placeVia(fay.page, 'Eve', 'paladin', 1);
		await wait(400);
		check('Fay places Eve as a Squire', JSON.stringify(eve.state.me.places) === '[{"b":"paladin","t":1,"c":""}]', eve.state.me);
		await shot(fay.page, '06-manage-branch-leader');

		// A photo session from the panel to a group: the Paladins.
		await click(page, 'Orders');
		await click(page, '＋ New order');
		await click(page, '📸 Photo session');
		await type(page, 'input:not([type])', 'Uniform photos', 0);
		await type(page, 'textarea', 'Club room, full uniform.', 0);
		await page.evaluate(() => {
			const el = document.querySelector('#void-panel input[type=datetime-local]');
			const t = new Date(Date.now() + 3 * 864e5);
			t.setSeconds(0, 0);
			el.value = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
			el.dispatchEvent(new Event('input'));
		});
		await click(page, 'Branches, ranks and chapters');
		await click(page, '✦⸸✦ Paladin');
		await shot(page, '07-new-session');
		await click(page, 'Send');
		await wait(500);
		const sess = [...bea.orders.values()].find((o) => o.title === 'Uniform photos');
		check(
			'the session reaches the Paladins with its time, not Dan',
			!!sess &&
				sess.kind === 'session' &&
				sess.when > Date.now() + 2 * 864e5 &&
				JSON.stringify(sess.to) === '{"groups":["paladin"]}' &&
				![...dan.orders.values()].some((o) => o.title === 'Uniform photos'),
			sess,
		);
		await bea.req({ t: 'ack', id: sess.id, a: 'yes' });
		await wait(400);
		check("Ann sees Bea's answer", /Coming \(1\): Bea/.test(await panelText(page)), await panelText(page));

		// Orders flow down: Bea, rank 5, orders everyone below her; Fay gets a note (escaped: the game shows notes as
		// HTML), a toast and a badge.
		await click(fay.page, 'Orders');
		await fay.page.evaluate(() => (window.local = []));
		const o2 = await bea.req({
			t: 'order',
			kind: 'order',
			title: 'Polish the shields <img src=x>',
			body: 'Before Friday.',
			to: { all: true },
		});
		await wait(500);
		const after = await fay.page.evaluate(() => ({
			local: window.local.join('\n'),
			toast: [...document.querySelectorAll('.void-toast')].map((t) => t.textContent).join(' | '),
			badge: document.querySelector('#void-panel nav .badge')?.textContent,
		}));
		check(
			'a new order shows as a note, a toast and a badge',
			/New order from Bea: Polish the shields &lt;img src=x&gt;/.test(after.local) &&
				!/<img/.test(after.local) &&
				/Polish the shields <img src=x>/.test(after.toast || '') &&
				after.badge === '2',
			after,
		);
		check('it does not reach Dan, a Priest', ![...dan.orders.values()].some((o) => o.id === o2.id));
		await shot(fay.page, '08-orders');
		await click(fay.page, '✔ Done');
		await wait(400);
		const mineSeen = bea.orders.get(o2.id);
		check(
			'Done answers the order; Bea sees it',
			mineSeen && mineSeen.acks && mineSeen.acks[15] && mineSeen.acks[15].a === 'done',
			mineSeen,
		);

		// A session reminder.
		await fay.page.evaluate(() => (window.local = []));
		await bea.req({ t: 'order', kind: 'session', title: 'Quick shoot', to: { all: true }, when: Date.now() + 10 * 60000 });
		await fay.page
			.waitForFunction(() => window.local.some((l) => /Quick shoot starts in 10 min/.test(l)), { timeout: 6000 })
			.catch(() => {});
		check(
			'a session 10 minutes away brings a reminder',
			await fay.page.evaluate(() => window.local.some((l) => /Quick shoot starts in 10 min/.test(l))),
			await fay.page.evaluate(() => window.local),
		);

		// The Void dice: Ann rolls d20 + 2d6 + 3 from the tray.
		// Animations only run in the tab in front, as in the game.
		await page.bringToFront();
		await click(page, 'Dice');
		await click(page, 'd20');
		await click(page, 'd6');
		await click(page, 'd6');
		await type(page, 'input[type=number]', '3');
		await page.evaluate(() => (window.sent = []));
		await click(page, '🎲 Roll');
		await page.waitForSelector('#void-dice', { timeout: 5000 });
		await wait(450);
		check('the tray tumbles, not yet settled', await page.evaluate(() => !document.getElementById('void-dice').dataset.settled));
		await shot(page, '09-dice-rolling');
		await page.waitForFunction(() => document.getElementById('void-dice')?.dataset.settled === '1', { timeout: 4000 });
		await shot(page, '10-dice-settled');
		const tray = await page.evaluate(() => {
			const t = document.getElementById('void-dice');
			return { id: t.dataset.roll, faces: t.dataset.faces, text: t.innerText };
		});
		const sent = await page.evaluate(() => window.sent.map(([m, d]) => ({ m, ...d })));
		const emote = sent.find((x) => x.Type === 'Emote');
		const hidden = sent.find((x) => x.Type === 'Hidden');
		const faces = tray.faces.split(',').map(Number);
		const total = faces.reduce((a, b) => a + b, 3);
		check(
			'the roll goes to the room: an emote with the faces, and a hidden note with its id',
			emote &&
				emote.Content === `rolls the Void dice: d20+2d6+3: ${faces.join(' + ')} + 3 = ${total}` &&
				hidden &&
				hidden.Content === 'VoidOrder' &&
				hidden.Dictionary[0].roll === tray.id,
			{ sent, tray },
		);
		const fromServer = await gus.req({ t: 'getroll', id: tray.id });
		check(
			'the server made the roll: the same faces, by Ann',
			fromServer.roll &&
				fromServer.roll.by === 11 &&
				fromServer.roll.dice.map((d) => d.v).join() === faces.join() &&
				fromServer.roll.total === total,
			fromServer,
		);
		check('the tray names the roller and the total', new RegExp(`Ann rolls d20\\+2d6\\+3[\\s\\S]*= ${total}`).test(tray.text), tray.text);

		// Fay, in the same room, gets the hidden note: her client fetches the roll and plays the same dice.
		await fay.page.bringToFront();
		await fay.page.evaluate((id) => {
			const h = ChatRoomMessageHandlers.find((x) => x.Description === 'Oculus Nihili: ID cards, dice and marks');
			h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ roll: id }] }, ChatRoomCharacter[1], '', {});
		}, tray.id);
		await fay.page.waitForSelector('#void-dice', { timeout: 5000 });
		await wait(1600);
		const seen = await fay.page.evaluate(() => {
			const t = document.getElementById('void-dice');
			return { faces: t.dataset.faces, text: t.innerText };
		});
		check('another Void user sees the same roll fall', seen.faces === tray.faces && /Ann rolls d20\+2d6\+3/.test(seen.text), seen);
		await shot(fay.page, '11-dice-seen-by-another');
		await fay.page.evaluate(() => document.getElementById('void-dice')?.click());

		// A roll shown by someone who didn't make it is not played; nor is a flood from one person.
		await fay.page.evaluate(() => (window.trays = []));
		await fay.page.evaluate((id) => {
			const h = ChatRoomMessageHandlers.find((x) => x.Description === 'Oculus Nihili: ID cards, dice and marks');
			h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ roll: id }] }, { MemberNumber: 99, Name: 'Mallory' }, '', {});
		}, tray.id);
		await wait(800);
		check("a roll id shown by someone else than the roller isn't played", (await fay.page.evaluate(() => window.trays.length)) === 0);
		await slash(page, 'roll 2d6+1');
		await wait(300);
		const rolled = await page.evaluate(() => window.sent.filter((x) => x[1].Type === 'Hidden').map((x) => x[1].Dictionary[0].roll));
		check(
			'/void roll 2d6+1 rolls from the chat',
			rolled.length === 2 &&
				(await page.evaluate(() => window.sent.some(([, d]) => /^rolls the Void dice: 2d6\+1: \d+ \+ \d+ \+ 1 = \d+$/.test(d.Content)))),
		);
		await fay.page.evaluate((ids) => {
			const h = ChatRoomMessageHandlers.find((x) => x.Description === 'Oculus Nihili: ID cards, dice and marks');
			for (const id of [...ids, ...ids, ...ids])
				h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ roll: id }] }, ChatRoomCharacter[1], '', {});
		}, rolled);
		await wait(5000);
		const played = await fay.page.evaluate(() => window.trays);
		check('six notes from one person in a moment play one roll', played.length === 1, played);
		await slash(page, 'roll 2d7');
		check('a die the Void has not is refused', await page.evaluate(() => window.local.some((l) => /The Void rolls d4, d6/.test(l))));

		// The Void mark over members in the room who run the add-on (Fay's room: Fay, Ann, and Zed, who isn't a member).
		const fp = fay.page;
		check(
			'a member tells the room she runs the add-on',
			await fp.evaluate(() =>
				window.sent.some(([, d]) => d.Type === 'Hidden' && d.Dictionary[0].here === true && d.Dictionary[0].reply === true),
			),
		);
		await fp.evaluate(() => {
			ChatRoomCharacter.push(
				CharacterLoadOnline(
					{
						ID: 'z',
						Name: 'Zed',
						Nickname: 'Zed',
						MemberNumber: 99,
						AssetFamily: 'Female3DCG',
						Appearance: [],
						Title: '',
						Ownership: null,
						Lovership: [],
						ItemPermission: 1,
						BlockItems: [],
						LimitedItems: [],
						FavoriteItems: [],
						WhiteList: [],
						BlackList: [],
						OnlineSharedSettings: {},
						ArousalSettings: {},
						Game: {},
						Inventory: [],
					},
					15,
				),
			);
			document.getElementById('void-panel')?.remove();
		});
		/** Draws a character's overlay at 0,0 on a cleared canvas, and whether the mark's middle got painted. */
		const marked = (i) =>
			fp.evaluate((i) => {
				for (const c of ChatRoomCharacter) c.OnlineSharedSettings = { GameVersion, ...c.OnlineSharedSettings };
				MainCanvas.clearRect(0, 0, 2000, 1000);
				ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[i], 0, 0, 1);
				return MainCanvas.getImageData(347, 97, 1, 1).data[3] > 0;
			}, i);
		check('Ann, who hasn’t said she is here, has no mark yet', !(await marked(1)));
		await fp.evaluate(() => (window.sent = []));
		const hello = (i) =>
			fp.evaluate((i) => {
				const h = ChatRoomMessageHandlers.find((x) => x.Description === 'Oculus Nihili: ID cards, dice and marks');
				h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ here: true, reply: true }] }, ChatRoomCharacter[i], '', {});
			}, i);
		await hello(1);
		await hello(2);
		check('once she says so, Ann (the Founder) has the mark', await marked(1));
		check(
			'and is answered, so she sees Fay’s',
			await fp.evaluate(() => window.sent.some(([, d]) => d.Type === 'Hidden' && d.Dictionary[0].here === true && !d.Dictionary[0].reply)),
		);
		check('Zed runs the add-on but is no member: no mark', !(await marked(2)));
		check('Fay has her own mark', await marked(0));
		await fp.evaluate(() => {
			MainCanvas.fillStyle = '#1a1024';
			MainCanvas.fillRect(0, 0, 2000, 1000);
			CharacterAppearanceSetDefault(ChatRoomCharacter[1]);
			DrawCharacter(ChatRoomCharacter[0], 250, 0, 1);
			DrawCharacter(ChatRoomCharacter[1], 750, 0, 1);
			MouseX = 750 + 347;
			MouseY = 97;
			ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[0], 250, 0, 1);
			ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[1], 750, 0, 1);
		});
		// The login screen's page elements are still up in this fake room: hidden for the picture.
		await fp.evaluate(() => document.querySelectorAll('body > :not(canvas)').forEach((el) => el.classList.add('vo-test-hidden')));
		await fp.addStyleTag({ content: '.vo-test-hidden { visibility: hidden !important; }' });
		await shot(fp, '14-room-marks');
		await fp.evaluate(() => document.querySelectorAll('.vo-test-hidden').forEach((el) => el.classList.remove('vo-test-hidden')));
		await fp.evaluate(() => ChatRoomCharacterViewClickCharacter(ChatRoomCharacter[1], 750, 0, 1, 347, 97));
		await fp.waitForSelector('#void-card', { timeout: 5000 }).catch(() => {});
		check(
			"clicking Ann's mark opens her ID card",
			/Ann[\s\S]*Member #11/.test(await fp.evaluate(() => document.getElementById('void-card')?.innerText || '')),
		);
		await fp.evaluate(() => document.getElementById('void-card')?.remove());
		await slash(fp, '');
		await toggleSetting(fp, 'Void mark over members');
		check('the setting turns the marks off', !(await marked(1)));
		await toggleSetting(fp, 'Void mark over members');
		check('and on again', await marked(1));

		// The hunt board: a copy of the prison's public board, with everyone's notes; a target over Bea, who has a bounty.
		await page.bringToFront();
		await click(page, '🎯 Hunt board');
		await page
			.waitForFunction(() => /Contracts · 102/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 15000 })
			.catch(() => {});
		const board = await panelText(page);
		check(
			'the hunt board lists the contracts, with their notes, and the most wanted',
			/Updated[\s\S]*CONTRACTS · 102[\s\S]*Ivy & “Moth” BC #12[\s\S]*BH-003170[\s\S]*1,500 credits \+ 100 \(taunted — alive only\)[\s\S]*“Run & hide!”[\s\S]*Their wants and limits\s+Catch me off guard[\s\S]*MOST WANTED[\s\S]*Escapee 1 VOP-000408[\s\S]*CRITICAL/.test(
				board,
			),
			board.slice(0, 900),
		);
		await shot(page, '18-hunt-board');
		const targeted = () =>
			page.evaluate(() => {
				for (const c of ChatRoomCharacter) c.OnlineSharedSettings = { GameVersion, ...c.OnlineSharedSettings };
				document.getElementById('MainCanvas').getContext('2d').clearRect(0, 0, 2000, 1000);
				ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[1], 0, 0, 1);
				// A point on the red ring, off the cross.
				const px = document.getElementById('MainCanvas').getContext('2d').getImageData(343, 133, 1, 1).data;
				return px[3] > 0 && px[0] > 150;
			});
		check('Bea, with an open contract, has a target in the room', await targeted());
		await page.evaluate(() => {
			document.getElementById('void-panel')?.remove();
			MouseX = 347;
			MouseY = 137;
			ChatRoomCharacterViewClickCharacter(ChatRoomCharacter[1], 0, 0, 1, 347, 137);
		});
		await page.waitForSelector('#void-panel .contract.focus', { timeout: 5000 }).catch(() => {});
		check(
			'clicking the target opens her contract on the board',
			await page.evaluate(() => document.querySelector('#void-panel .contract.focus')?.id === 'hunt-BH-003170'),
		);
		await page.evaluate(() => document.querySelectorAll('body > :not(canvas)').forEach((el) => el.classList.add('vo-test-hidden')));
		await page.addStyleTag({ content: '.vo-test-hidden { visibility: hidden !important; }' });
		await page.evaluate(() => {
			const g = document.getElementById('MainCanvas').getContext('2d');
			g.fillStyle = '#1a1024';
			g.fillRect(0, 0, 2000, 1000);
			CharacterAppearanceSetDefault(ChatRoomCharacter[1]);
			DrawCharacter(ChatRoomCharacter[0], 250, 0, 1);
			DrawCharacter(ChatRoomCharacter[1], 750, 0, 1);
			MouseX = 750 + 347;
			MouseY = 137;
			ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[0], 250, 0, 1);
			ChatRoomCharacterViewDrawOverlay(ChatRoomCharacter[1], 750, 0, 1);
		});
		await shot(page, '19-room-target');
		await page.evaluate(() => document.querySelectorAll('.vo-test-hidden').forEach((el) => el.classList.remove('vo-test-hidden')));
		await toggleSetting(page, 'A target over people with a bounty');
		check('the setting turns the targets off', !(await targeted()));
		await toggleSetting(page, 'A target over people with a bounty');

		// Someone showing their ID in the room: the card comes from the server.
		await page.evaluate(() => {
			const h = ChatRoomMessageHandlers.find((x) => x.Description === 'Oculus Nihili: ID cards, dice and marks');
			h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ card: true }] }, ChatRoomCharacter[1], '', {});
		});
		await page.waitForSelector('#void-card', { timeout: 5000 });
		check(
			'a card shown in the room opens for Void Order users',
			/Bea[\s\S]*Paladin - Champion[\s\S]*Shown in this room/.test(
				await page.evaluate(() => document.getElementById('void-card').innerText),
			),
		);
		await page.evaluate(() => document.getElementById('void-card').remove());

		// My card: the form of rank names, and showing it.
		await click(fay.page, 'My card');
		await click(fay.page, 'Join the Order chat in SlimeBeep');
		await wait(500);
		check(
			'My card has a button to join the Order chat when SlimeBeep runs',
			/You’re in the Void Order chat in SlimeBeep/.test(await panelText(fay.page)),
			await panelText(fay.page),
		);
		const forms = await fay.page.evaluate(() =>
			[...document.querySelector('#void-panel main select').options].map((o) => o.textContent).join('|'),
		);
		check('the form picker shows your rank in each form', forms === 'Feminine (Crusader)|Masculine (Crusader)|Neutral (Crusader)', forms);
		await fay.page.evaluate(() => (window.sent = []));
		await click(fay.page, 'Show my ID in this room');
		const shown = await fay.page.evaluate(() => window.sent.map(([m, d]) => `${m}:${d.Type}:${d.Content}`));
		check(
			'Show my ID sends the emote and the hidden note',
			shown.includes('ChatRoomChat:Emote:shows their ID card of The Void Order.') && shown.includes('ChatRoomChat:Hidden:VoidOrder'),
			shown,
		);
		await shot(fay.page, '12-my-card');
		await page.bringToFront();
		await page.waitForFunction(() => !document.getElementById('void-dice'), { timeout: 8000 });
		await click(page, 'My card');
		check('without SlimeBeep there is no chat button', !/Join the Order chat/.test(await panelText(page)));
		await click(page, 'The Order');
		const about = await panelText(page);
		check(
			'The Order tab lists each branch with its description and ranks',
			/☿⸸☿ Mage ☿⸸☿\s+Masters of mental powers[\s\S]*5\. Grand Sage · 4\. Sage · 3\. …mancer · 2\. Primary · 1\. Novitate[\s\S]*Inquisitor \+ Paladin: Commisar/.test(
				about,
			),
			about,
		);
		await shot(page, '13-the-order');

		// Settings: one list, in the panel's ⚙ tab and the game's Settings > Extensions page.
		await click(fp, '⚙ Settings');
		const groups = await fp.evaluate(() => [...document.querySelectorAll('#void-panel main h3')].map((h) => h.textContent).join('|'));
		check('the ⚙ tab groups the settings', groups === 'Notifications|Rooms|Panel|SlimeBeep|Privacy', groups);
		await shot(fp, '15-settings');
		await toggleSetting(fp, 'Pop-ups for new orders');
		await fp.evaluate(() => {
			window.local = [];
			document.querySelectorAll('.void-toast').forEach((t) => t.remove());
		});
		await bea.req({ t: 'order', kind: 'notice', title: 'Quiet notice', to: { members: [15] } });
		await wait(600);
		check(
			'with pop-ups off a notice comes as a chat line, without a pop-up',
			await fp.evaluate(() => window.local.some((l) => /Quiet notice/.test(l)) && !document.querySelector('.void-toast')),
		);
		await toggleSetting(fp, 'Pop-ups for new orders');
		await chooseSetting(fp, 'Who sees my public room', 'Nobody');
		await wait(2600);
		check(
			'“Who sees my public room: Nobody” hides Fay’s room from Bea',
			bea.state.members.find((m) => m.n === 15)?.room === '',
			bea.state.members.find((m) => m.n === 15),
		);
		await chooseSetting(fp, 'Who sees my public room', 'Everyone in the Order');
		await wait(2600);
		check(
			'and Everyone shows it again',
			bea.state.members.find((m) => m.n === 15)?.room === 'Void Hall',
			bea.state.members.find((m) => m.n === 15),
		);

		// The Extensions page: Ann turns off other people's dice there; the panel agrees.
		await page.bringToFront();
		const ext = await page.evaluate(() => {
			const e = PreferenceExtensionsSettings.OculusNihili;
			e.load();
			e.run();
			// "Play dice others roll in my room", the seventh checkbox: rows of 72 from 170, at x 400.
			MouseX = 420;
			MouseY = 170 + 6 * 72 + 20;
			e.click();
			return { text: e.ButtonText, image: /^data:image\/png/.test(e.Image) };
		});
		check('Settings > Extensions lists Oculus Nihili with its eye', ext.text === 'Oculus Nihili' && ext.image, ext);
		await page.evaluate(() => document.querySelectorAll('body > :not(canvas)').forEach((el) => el.classList.add('vo-test-hidden')));
		await page.addStyleTag({ content: '.vo-test-hidden { visibility: hidden !important; }' });
		// Drawn twice: the checkbox ticks are pictures the game loads on first use.
		const drawExtensions = () =>
			page.evaluate(() => {
				const g = document.getElementById('MainCanvas').getContext('2d');
				g.fillStyle = '#eee';
				g.fillRect(0, 0, 2000, 1000);
				PreferenceExtensionsSettings.OculusNihili.run();
			});
		await drawExtensions();
		await wait(500);
		await drawExtensions();
		await shot(page, '16-extensions-page');
		await page.evaluate(() => document.querySelectorAll('.vo-test-hidden').forEach((el) => el.classList.remove('vo-test-hidden')));
		await slash(page, '');
		await click(page, '⚙ Settings');
		const diceBox = await page.evaluate(
			() =>
				[...document.querySelectorAll('#void-panel label.check')]
					.find((l) => /Play dice others roll/.test(l.textContent))
					.querySelector('input').checked,
		);
		check('a checkbox clicked on the Extensions page shows in the panel', diceBox === false);
		await toggleSetting(page, 'Play dice others roll');

		// The ⸸ tab's side, the look, and the open/close key.
		await chooseSetting(page, 'Side tab position', 'Right');
		await chooseSetting(page, 'Look', 'Lighter');
		check('the lighter look applies', await page.evaluate(() => /#2b2140/.test(document.getElementById('void-look').textContent)));
		await chooseSetting(page, 'Look', 'Void dark');
		await click(page, 'none');
		await page.keyboard.press('F2');
		check('the key picker takes F2', /F2/.test(await panelText(page)), await panelText(page));
		await page.evaluate(() => document.querySelector('#void-panel .x').click());
		check(
			'with the panel shut, the ⸸ tab sits on the right',
			await page.evaluate(() => document.getElementById('void-tab')?.classList.contains('right')),
		);
		await page.keyboard.press('F2');
		check('F2 opens the panel', await page.evaluate(() => !!document.getElementById('void-panel')));
		await page.keyboard.press('F2');
		check('and closes it', await page.evaluate(() => !document.getElementById('void-panel')));
		await slash(page, '');

		// My room shows in the list; a private one doesn't.
		await wait(2500);
		check('my public room shows to the Order', bea.state.members.find((m) => m.n === 11)?.room === 'Void Hall', bea.state.members);
		await page.evaluate(() => (ChatRoomData.Visibility = ['Admin']));
		await wait(2500);
		check('a private room is not shown', bea.state.members.find((m) => m.n === 11)?.room === '', bea.state.members);

		// Another device: the same account settings sign in as the same member.
		const fayKey = await fay.page.evaluate(() => Player.ExtensionSettings.VoidOrder);
		const second = await gamePage(browser, { me: [15, 'Fay'], other: [11, 'Ann'], settings: { VoidOrder: fayKey }, slimebeep: true });
		await slash(second.page, '');
		await second.page
			.waitForFunction(() => /Manage/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 })
			.catch(() => {});
		const tabs2 = await second.page.evaluate(() =>
			[...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent.replace(/\d+$/, '')).join('|'),
		);
		check(
			'another device with the same account signs in as the same member',
			tabs2 === 'Orders|Members|The Order|Dice|🎯 Hunt board|Manage|My card|⚙ Settings',
			tabs2,
		);
		const noteOnLogin = await second.page.evaluate(() => window.local.join('\n'));
		check('signing in tells you about unanswered orders', /3 unanswered orders/.test(noteOnLogin), noteOnLogin);
		await wait(2500);
		check(
			'the second device does not put Fay in the Order chat again',
			(await second.page.evaluate(() => window.sbJoined.length)) === 0,
			await second.page.evaluate(() => window.sbJoined),
		);
		check('no page errors', errors.length === 0 && fay.errors.length === 0 && second.errors.length === 0, [
			...errors,
			...fay.errors,
			...second.errors,
		]);
	} finally {
		for (const p of peers) p.close();
		await browser.close();
		web.close();
		relay.close();
	}
	console.log(failed ? `${failed} FAILED, ${passed} passed` : `All ${passed} checks passed`);
	process.exit(failed ? 1 : 0);
})();
