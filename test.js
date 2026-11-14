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
// Ports can move (WEB_PORT, RELAY_PORT) when another test run holds the usual ones.
const PORT = Number(process.env.WEB_PORT) || 8178;
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
	if (req.url.startsWith('/bounty-board')) {
		res.writeHead(200, { 'content-type': 'text/html' });
		return res.end(fs.readFileSync(path.join(__dirname, 'server', 'test', 'fixtures', 'bounty-board.html')));
	}
	if (req.url.startsWith('/order-sheet.csv')) {
		res.writeHead(200, { 'content-type': 'text/csv' });
		return res.end(fs.readFileSync(path.join(__dirname, 'server', 'test', 'fixtures', 'order-sheet.csv')));
	}
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
// The game from BC_ROOT, the add-on's own pictures under /void-assets/ and its modules under /void-src/.
const web = http.createServer((req, res) => {
	const url = decodeURIComponent(req.url.split('?')[0]);
	const p = url.startsWith('/void-assets/')
		? path.join(__dirname, 'assets', url.slice('/void-assets/'.length))
		: url.startsWith('/void-src/')
			? path.join(__dirname, 'src', url.slice('/void-src/'.length))
			: path.join(ROOT, url);
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
async function gamePage(browser, { me, other, settings = {}, slimebeep = false, grabber = false }) {
	const page = await browser.newPage();
	await page.setViewport({ width: 1600, height: 900 });
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
	if (process.env.DEBUG) page.on('console', (m) => console.log(`[${me[1]}] ${m.text()}`));
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
			// As a room's sync would: Ann may use items on Bea.
			them.AllowItem = true;
			ChatRoomCharacter = [Player, them];
			CurrentScreen = 'ChatRoom';
			window.sent = [];
			window.local = [];
			window.synced = [];
			ServerSend = (msg, data) => window.sent.push([msg, data]);
			ChatRoomSendLocal = (text) => window.local.push(String(text));
			ServerPlayerExtensionSettingsSync = (k) => window.synced.push(k);
			window.VoidOrderServer = `${server}/ws?o=${order}`;
			window.VoidOrderAssets = `${location.origin}/void-assets/`;
			window.VoidOrderSrc = `${location.origin}/void-src/`;
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
	if (grabber) {
		// Another add-on, loaded first, that sends typing to the chat box while `grabOn` (as some add-ons do).
		await page.evaluate(() => {
			window.addEventListener(
				'keydown',
				() => {
					const chat = document.getElementById('InputChat');
					if (window.grabOn && chat && document.activeElement !== chat) chat.focus();
				},
				true,
			);
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
	await new Promise((r) => relay.listen(Number(process.env.RELAY_PORT) || 8799, '127.0.0.1', r));
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
	const peers = [];
	try {
		const { page, errors } = await gamePage(browser, { me: [11, 'Ann'], other: [12, 'Bea'], grabber: true });
		check('/void is registered once the game is ready', true);
		await page.waitForFunction(() => window.synced.includes('VoidOrder'), { timeout: 10000 });
		const saved = await page.evaluate(() => Player.ExtensionSettings.VoidOrder);
		check('a key is made and saved in the account settings', typeof saved === 'string' && saved.length > 20);

		// Founding.
		await slash(page, '');
		await page.waitForFunction(() => /Found the Order/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 10000 });
		await shot(page, '01-found');
		await type(page, 'textarea', 'We gaze into the Void, and it gazes back.');
		await type(page, 'input:not([type])', 'test-founding-code', 0);
		await click(page, 'Found the Order');
		await page.waitForFunction(() => /Orders/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 });
		const tabs = await page.evaluate(() => [...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent).join('|'));
		check(
			'founding gives the Founder every tab',
			tabs === 'Orders|Members|The Order|Dice|Armory|🎯 Hunt board|Manage|My card|🐞 Reports|⚙ Settings',
			tabs,
		);

		// Bea joins at once and waits for a place; Ann places her from Manage as a Paladin rank 5.
		const bea = await peer(12, 'Bea');
		peers.push(bea);
		await bea.req({ t: 'join', name: 'Bea' });
		await wait(400);
		const badge = await page.evaluate(() => document.querySelector('#void-panel nav .badge')?.textContent);
		check('Manage shows one member awaiting a place', badge === '1', badge);
		await click(page, 'Manage');
		check(
			'Bea is listed under the Neophytes',
			/Neophytes \(not yet in a branch\) · 1\s+Bea #12/i.test(await panelText(page)),
			await panelText(page),
		);
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
		check('Fay joins at once, a Neophyte', fayStatus === 'Neophyte', fayStatus);
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
			/𓁹‿𓁹 Keeper of the Eye 𓁹‿𓁹\s+Ann #11[\s\S]*Founder: not yet handed over[\s\S]*🎇 Monsignor 🎇 · 1[\s\S]*Ann #11[\s\S]*☨✙☨ Priest ☨✙☨ · 1[\s\S]*Leaders of spiritual[\s\S]*HIGH PRIEST \/ HIGH PRIESTESS\s+Dan #14 · High Priestess · Vox Nihil[\s\S]*✦⸸✦ Paladin ✦⸸✦ · 4[\s\S]*CHAMPION\s+Bea #12 · Champion[\s\S]*CRUSADER[\s\S]*Fay #15 · Crusader[\s\S]*Gus #16 · Crusader[\s\S]*KNIGHT\s+Cat #13 · Knight · Salvatoris\s+Warmage[\s\S]*☿⸸☿ Mage ☿⸸☿ · 1[\s\S]*…MANCER\s+Cat #13 · Spellblade · Conjurers/.test(
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
			"the app admin's card: Keeper of the Eye (while she holds the Founder's place) and Monsignor",
			/^Praise the Void! 𓁹‿𓁹\n.*Keeper of the Eye.*\n.*Monsignor/.test(await cardText(page)) && !/Founder/.test(await cardText(page)),
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

		// The Armory: the app admin has every weapon (early access) and carries her own; she issues one to Cat.
		await click(page, 'Armory');
		await page.waitForSelector('#weapon-100', { timeout: 10000 }).catch(() => {});
		const arms = await page.evaluate(() => {
			const box = (id) => document.getElementById(`weapon-${id}`);
			return {
				count: document.querySelectorAll('#void-panel .weapon').length,
				wrath: box(100)?.innerText,
				wrathKind: box(100)?.previousElementSibling?.textContent,
				wabbajackStats: !!box(98)?.querySelector('.stats'),
				wabbajackPlain: !!box(98)?.querySelector('.void-sprite.none'),
				shotgun: box(1)?.innerText,
				shotgunPicture: box(1)?.querySelector('.void-sprite img')?.getAttribute('src'),
			};
		});
		check(
			'the Armory lists the catalog: pictures, rarity, Void and stats; the app admin holds every weapon',
			arms.count === 100 &&
				/Queen's Wrath[\s\S]*Legendary[\s\S]*Void Order[\s\S]*Slime’s signature[\s\S]*2 tons[\s\S]*Held by Ann/.test(arms.wrath) &&
				/^Scythes · 1$/.test(arms.wrathKind || '') &&
				!arms.wabbajackStats &&
				arms.wabbajackPlain &&
				/Old sawed-off shotgun[\s\S]*Common[\s\S]*\+3 Base damage · \+1 Speed/.test(arms.shotgun) &&
				/\/void-assets\/weapons\/1\.png$/.test(arms.shotgunPicture || ''),
			arms,
		);
		await page.evaluate(() => [...document.querySelectorAll('#weapon-100 button')].find((b) => b.textContent === 'Carry').click());
		await wait(500);
		check('Ann carries her Queen’s Wrath', bea.state.members.find((m) => m.n === 11)?.carry === 100);
		await page.evaluate(() => document.getElementById('weapon-1').scrollIntoView());
		await page
			.waitForFunction(() => [...document.querySelectorAll('#void-panel img')].slice(0, 6).every((i) => i.complete), { timeout: 5000 })
			.catch(() => {});
		await shot(page, '20-armory');
		await click(page, 'Manage');
		await page.waitForFunction(() => !!document.querySelector('#void-panel .box select'), { timeout: 5000 }).catch(() => {});
		await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .box')].find((b) =>
				b.querySelector('.row .grow')?.textContent.startsWith('Cat #'),
			);
			const issue = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Issue');
			const sel = issue.previousElementSibling;
			sel.value = '7';
			sel.dispatchEvent(new Event('change'));
			issue.click();
		});
		await wait(500);
		await cat.req({ t: 'carry', weapon: 7 });
		check('Ann issues a weapon to Cat from Manage', (cat.state.me.weapons || []).join() === '7');
		await click(page, 'Members');
		await openCardOf(page, 'Ann');
		await page.waitForSelector('#void-card .carried img', { timeout: 5000 }).catch(() => {});
		check(
			'the ID card shows only what is carried (Queen’s Wrath in its own slot), not the whole armory',
			await page.evaluate(
				() =>
					/Queen's Wrath[\s\S]*Bound, comes when called/.test(document.querySelector('#void-card .carried')?.innerText || '') &&
					document.querySelectorAll('#void-card .carried').length === 1 &&
					!document.querySelector('#void-card .arms') &&
					/0 of 4 carried · slime body · 100 weapons in their armory/.test(document.getElementById('void-card')?.innerText || ''),
			),
			await page.evaluate(() => document.getElementById('void-card')?.innerText),
		);
		await page.evaluate(() => document.getElementById('void-card')?.remove());
		await openCardOf(page, 'Cat');
		await page.waitForFunction(() => document.querySelector('#void-card .carried img')?.complete, { timeout: 5000 }).catch(() => {});
		check(
			"Cat's card shows her weapon",
			/\+/.test(await page.evaluate(() => document.querySelector('#void-card .carried .stats')?.textContent || '')),
		);
		await shot(page, '21-card-weapon');
		await page.evaluate(() => document.getElementById('void-card')?.remove());

		// A branch leader's Manage: only the Paladins below her, and the Neophytes.
		const eve = await peer(17, 'Eve');
		peers.push(eve);
		await eve.req({ t: 'join', name: 'Eve' });
		await wait(400);
		await click(fay.page, 'Manage');
		await wait(200);
		const fm = await panelText(fay.page);
		check(
			'a rank 4 Paladin manages Cat (rank 2) and places Eve',
			/Neophytes \(not yet in a branch\) · 1\s+Eve #17[\s\S]*Cat #13/i.test(fm),
			fm,
		);
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
			.waitForFunction(() => /Order of Void bounties · 3/i.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 20000 })
			.catch(() => {});
		const board = await panelText(page);
		check(
			'the hunt board lists the contracts, with their notes, and the most wanted',
			/Updated[\s\S]*HUNTING BOARD \(VOLUNTEERS\) · 102[\s\S]*Ivy & “Moth” BC #12[\s\S]*BH-003170[\s\S]*1,500 credits \+ 100 \(taunted — alive only\)[\s\S]*“Run & hide!”[\s\S]*Their wants and limits\s+Catch me off guard[\s\S]*MOST WANTED[\s\S]*Escapee 1 VOP-000408[\s\S]*CRITICAL/.test(
				board,
			),
			board.slice(0, 900),
		);
		check(
			'then the bounty board (escaped inmates, with their files) and the Order’s own bounties',
			/BOUNTY BOARD \(ESCAPED\) · 2[\s\S]*Escapee & One BC #100101[\s\S]*L\$ 217,657,242[\s\S]*Their file[\s\S]*HOLY ORDER OF VOID BOUNTIES · 3[\s\S]*Target Five BC #100005[\s\S]*Until 12\/31\/2099[\s\S]*A battle to the death/.test(
				board,
			),
			board.slice(board.indexOf('BOUNTY BOARD'), board.indexOf('BOUNTY BOARD') + 900),
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
		// An Order bounty on someone in the room: a target only if the game lets you use items on them, and none once hidden.
		const orderTarget = (allow) =>
			page.evaluate((allow) => {
				const was = window.ServerChatRoomGetAllowItem;
				window.ServerChatRoomGetAllowItem = () => allow;
				const bea = ChatRoomCharacter[1];
				const n = bea.MemberNumber;
				bea.MemberNumber = 100004;
				const g = document.getElementById('MainCanvas').getContext('2d');
				g.clearRect(0, 0, 2000, 1000);
				ChatRoomCharacterViewDrawOverlay(bea, 0, 0, 1);
				bea.MemberNumber = n;
				window.ServerChatRoomGetAllowItem = was;
				const px = g.getImageData(343, 133, 1, 1).data;
				return px[3] > 0 && px[0] > 150;
			}, allow);
		check('someone with an Order bounty has a target when the game lets you use items on them', await orderTarget(true));
		check('and none when it doesn’t', !(await orderTarget(false)));
		await click(page, '🎯 Hunt board');
		await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .contract')].find((b) => /Target Four BC #100004/.test(b.innerText));
			[...box.querySelectorAll('button')].find((b) => b.textContent === 'Hide').click();
		});
		await wait(800);
		check('hidden by the Founder, it has no target any more', !(await orderTarget(true)));
		await click(page, '🎯 Hunt board');
		await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .contract')].find((b) => /Target Four BC #100004/.test(b.innerText));
			[...box.querySelectorAll('button')].find((b) => b.textContent === 'Show again').click();
		});
		await wait(800);
		check('shown again, it has its target back', await orderTarget(true));

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
			shown.includes('ChatRoomChat:Emote:shows their ID card of the Holy Order of Void.') &&
				shown.includes('ChatRoomChat:Hidden:VoidOrder'),
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
		check('the ⚙ tab groups the settings', groups === 'Notifications|Rooms|Panel|SlimeBeep|Privacy|Problems|Weapon actions', groups);
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

		// Settings > Extensions: the add-on's entry opens the panel's ⚙ Settings tab and leaves the game on its list.
		await page.bringToFront();
		await page.evaluate(() => document.getElementById('void-panel')?.remove());
		const ext = await page.evaluate(async () => {
			const was = [CurrentModule, CurrentScreen];
			const hadChat = !!document.getElementById('InputChat');
			await CommonSetScreen('Character', 'Preference');
			await PreferenceOpenSubscreen('Extensions');
			const e = PreferenceExtensionsSettings.OculusNihili;
			PreferenceExtensionsDisplay.find((d) => d.Button === 'Oculus Nihili').click();
			await new Promise((r) => setTimeout(r, 300));
			const out = {
				text: e.ButtonText,
				image: /^data:image\/png/.test(e.Image),
				tab: document.querySelector('#void-panel nav .on')?.textContent || '',
				current: PreferenceExtensionsCurrent,
				subscreen: PreferenceSubscreen?.name,
			};
			await CommonSetScreen(...was);
			// This test room had no chat box; going back to it made the game's, which later checks make for themselves.
			if (!hadChat) document.getElementById('InputChat')?.remove();
			return out;
		});
		check('Settings > Extensions lists Oculus Nihili with its eye', ext.text === 'Oculus Nihili' && ext.image, ext);
		check(
			'choosing it opens the ⚙ Settings tab and the game stays on its list',
			/Settings/.test(ext.tab) && ext.current === null && ext.subscreen === 'Extensions',
			ext,
		);

		// The ⸸ tab (off now that there is a bubble), its side, the look, and the open/close key.
		await toggleSetting(page, 'Show the side tab');
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

		// The Void bubble: a click opens and closes the panel, a drag moves it without opening, and it stays where it was left.
		const bubble = () =>
			page.evaluate(() => {
				const b = document.getElementById('void-bubble');
				const r = b?.getBoundingClientRect();
				return b ? { x: Math.round(r.left), y: Math.round(r.top), badge: b.querySelector('.badge')?.textContent || '' } : null;
			});
		const press = (dx, dy) =>
			page.evaluate(
				(dx, dy) => {
					const b = document.getElementById('void-bubble');
					const r = b.getBoundingClientRect();
					const x = r.left + r.width / 2;
					const y = r.top + r.height / 2;
					const at = (type, cx, cy, buttons) =>
						b.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, button: 0, buttons, pointerId: 7, bubbles: true }));
					at('pointerdown', x, y, 1);
					if (dx || dy) {
						at('pointermove', x + dx / 2, y + dy / 2, 1);
						at('pointermove', x + dx, y + dy, 1);
					}
					at('pointerup', x + dx, y + dy, 0);
				},
				dx,
				dy,
			);
		const b0 = await bubble();
		check('the Void bubble is there, on the right', !!b0 && b0.x > 1400, b0);
		const ordersBadge = Number(await page.evaluate(() => document.querySelector('#void-panel nav .badge')?.textContent || 0));
		check('its badge counts the orders waiting', !!b0 && Number(b0.badge || 0) >= ordersBadge, { b0, ordersBadge });
		await press(0, 0);
		check('a click on it opens the panel', await page.evaluate(() => !!document.getElementById('void-panel')));
		await press(0, 0);
		check('another closes it', await page.evaluate(() => !document.getElementById('void-panel')));
		await press(-300, -200);
		const b1 = await bubble();
		check(
			'a drag moves it, and doesn’t open the panel',
			b1.x === b0.x - 300 && b1.y === b0.y - 200 && (await page.evaluate(() => !document.getElementById('void-panel'))),
			{ b0, b1 },
		);
		await page.evaluate(() => document.getElementById('void-bubble').remove());
		await wait(2500);
		const b2 = await bubble();
		check('drawn again, it is where it was left', !!b2 && b2.x === b1.x && b2.y === b1.y, { b1, b2 });
		await slash(page, '');
		await toggleSetting(page, 'Show the Void bubble');
		check('the setting hides it', await page.evaluate(() => !document.getElementById('void-bubble')));
		await toggleSetting(page, 'Show the Void bubble');

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
			tabs2 === 'Orders|Members|The Order|Dice|Armory|🎯 Hunt board|Manage|My card|⚙ Settings',
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
		// Another add-on that sends typing to the chat box (a window capture listener, there before ours, and a document
		// listener after it): keys typed in the panel's fields stay there and the other add-on never sees them.
		{
			await slash(page, '');
			await click(page, 'Manage');
			const kept = await page.evaluate(() => {
				const chat = document.createElement('input');
				chat.id = 'InputChat';
				document.body.append(chat);
				window.grabOn = true;
				let documentSaw = 0;
				const later = () => documentSaw++;
				document.addEventListener('keydown', later, true);
				const results = [];
				for (const field of [...document.querySelectorAll('#void-panel main input, #void-panel main textarea')].slice(0, 2)) {
					field.focus();
					for (const type of ['keydown', 'keypress', 'keyup']) {
						field.dispatchEvent(new KeyboardEvent(type, { key: 'a', bubbles: true, cancelable: true }));
					}
					results.push(document.activeElement === field);
				}
				document.removeEventListener('keydown', later, true);
				// Typing in the chat box itself, with the panel open, is not touched.
				chat.focus();
				chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
				const chatKept = document.activeElement === chat;
				window.grabOn = false;
				chat.remove();
				return { results, documentSaw, chatKept };
			});
			check(
				'with another add-on grabbing keys for the chat, the panel’s fields keep the focus',
				kept.results.length === 2 && kept.results.every(Boolean),
				kept,
			);
			check('and listeners after ours never see keys typed in the panel', kept.documentSaw === 0, kept);
			check('typing in the chat box is untouched', kept.chatKept, kept);
			const esc = await page.evaluate(() => {
				const field = document.querySelector('#void-panel main input');
				field.focus();
				field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
				return !document.getElementById('void-panel');
			});
			check('Esc in a field still closes the panel', esc);
		}
		// A feature that fails shows a small notice once; the player sees what a report sends and sends it on a click;
		// the app admin is told and reads it under Reports.
		await second.page.close();
		const problemText = () => fay.page.evaluate(() => [...document.querySelectorAll('.void-problem')].map((t) => t.innerText).join('\n'));
		await fay.page.evaluate(() => VoidOrder.report('Test feature', new Error('forced failure 42')));
		await wait(300);
		check(
			'a failure shows the problem notice',
			/Test feature switched off after a game change/.test(await problemText()),
			await problemText(),
		);
		await fay.page.evaluate(() => VoidOrder.report('Test feature', new Error('forced failure 43')));
		await wait(300);
		check(
			'the same failure again shows no second notice',
			(await fay.page.evaluate(() => document.querySelectorAll('.void-problem').length)) === 1,
		);
		await fay.page.evaluate(() =>
			[...document.querySelectorAll('.void-problem button')].find((b) => b.textContent === 'Send report').click(),
		);
		await wait(200);
		const reportShown = await problemText();
		check(
			'before sending, the player sees exactly what goes',
			/Feature: Test feature/.test(reportShown) &&
				/Error: forced failure 42/.test(reportShown) &&
				/Member: #15/.test(reportShown) &&
				/Add-on: /.test(reportShown),
			reportShown,
		);
		check('nothing is sent before the second click', !(await page.evaluate(() => /New problem report/.test(document.body.innerText))));
		await fay.page.evaluate(() => [...document.querySelectorAll('.void-problem button')].find((b) => b.textContent === 'Send').click());
		await fay.page
			.waitForFunction(() => /Sent\. Thank you!/.test(document.querySelector('.void-problem')?.innerText || ''), { timeout: 5000 })
			.catch(() => {});
		check('the report is sent', /Sent\. Thank you!/.test(await problemText()), await problemText());
		await page
			.waitForFunction(
				() => [...document.querySelectorAll('.void-toast')].some((t) => /New problem report: Test feature/.test(t.textContent)),
				{ timeout: 5000 },
			)
			.catch(() => {});
		check(
			'the app admin is told about the new kind',
			await page.evaluate(() =>
				[...document.querySelectorAll('.void-toast')].some((t) => /New problem report: Test feature/.test(t.textContent)),
			),
		);
		await slash(page, '');
		await click(page, '🐞 Reports');
		await page
			.waitForFunction(() => /forced failure/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 5000 })
			.catch(() => {});
		const reportsText = await panelText(page);
		check(
			'the app admin reads it under Reports, with its count and player',
			/Test feature: forced failure 42/.test(reportsText) && /1 report from 1 player/.test(reportsText) && /#15/.test(reportsText),
			reportsText,
		);
		await click(fay.page, '⚙ Settings').catch(() => {});
		await slash(fay.page, '');
		await click(fay.page, '⚙ Settings');
		const fayProblems = await panelText(fay.page);
		check('⚙ Settings lists the problem', /problems/i.test(fayProblems) && /Test feature switched off/.test(fayProblems), fayProblems);
		// Personal badges: Ann gives Fay one in Manage; it shows on Fay's ID card.
		await click(page, 'Manage');
		await page
			.waitForFunction(
				() => [...document.querySelectorAll('#void-panel select option')].some((o) => o.textContent === 'Badge: Slime Queen'),
				{ timeout: 5000 },
			)
			.catch(() => {});
		const gave = await page.evaluate(() => {
			const box = [...document.querySelectorAll('#void-panel .box')].find((b) => /^Fay #15/.test(b.innerText));
			const sel = box && [...box.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'slime-queen'));
			if (!sel) return false;
			sel.value = 'slime-queen';
			sel.dispatchEvent(new Event('change'));
			return true;
		});
		check('an admin has a badge picker on a member', gave);
		await wait(800);
		await slash(page, 'card 15');
		await page.waitForSelector('#void-card', { timeout: 5000 }).catch(() => {});
		const badgeSrc = await page.evaluate(() => document.querySelector('#void-card img.badge')?.getAttribute('src') || '');
		check("Fay's ID card shows her badge", /\/void-assets\/badges\/slime-queen-160\.png$/.test(badgeSrc), badgeSrc);
		await page.evaluate(() => document.getElementById('void-card')?.remove());
		// Weapon actions, with the real Armory items: each kind's actions in the activity menu while holding it.
		const annKey = await page.evaluate(() => Player.ExtensionSettings.VoidOrder);
		const armed = await gamePage(browser, { me: [11, 'Ann'], other: [12, 'Bea'], settings: { VoidOrder: annKey } });
		const ap = armed.page;
		await ap.waitForFunction(() => !!AssetGet('Female3DCG', 'ItemHandheld', 'VoidSwords') && !!window.VoidOrderModules?.actions, {
			timeout: 30000,
		});
		await wait(2500);
		const hold = (pg, name, record) =>
			pg.evaluate(
				(name, record) => {
					InventoryWear(Player, name, 'ItemHandheld');
					if (record)
						InventoryGet(Player, 'ItemHandheld').Property = {
							...(InventoryGet(Player, 'ItemHandheld').Property || {}),
							TypeRecord: record,
						};
					CharacterRefresh(Player, false);
				},
				name,
				record,
			);
		const menuOn = (pg, group) =>
			pg.evaluate(
				(group) => ActivityAllowedForGroup(ChatRoomCharacter[1], group).map((a) => `${a.Activity.Name}:${a.Item ? a.Item.Asset.Name : ''}`),
				group,
			);
		const kinds = [
			['VoidPistols', 'ItemTorso', 'VoidShoot'],
			['VoidSMGs', 'ItemTorso', 'VoidShoot'],
			['VoidRifles', 'ItemArms', 'VoidShoot'],
			['VoidSniperRifles', 'ItemHead', 'VoidAim'],
			['VoidShotguns', 'ItemNeck', 'VoidMuzzle'],
			['VoidCrossbows', 'ItemTorso', 'VoidLoose'],
			['VoidSwords', 'ItemArms', 'VoidSlash'],
			['VoidGlowingBlades', 'ItemTorso', 'VoidStab'],
			['VoidShortBlades', 'ItemNeck', 'VoidNeck'],
		];
		const missing = [];
		for (const [item, group, act] of kinds) {
			await hold(ap, item);
			if (!(await menuOn(ap, group)).includes(`${act}:${item}`)) missing.push(`${item} ${act}`);
		}
		check('each kind of weapon puts its actions in the activity menu, with the weapon', missing.length === 0, missing);
		await hold(ap, 'VoidSwords', { w: 0 });
		check('the menu labels them', (await ap.evaluate(() => ActivityDictionaryText('Label-ChatOther-ItemArms-VoidSlash'))) === 'Slash');
		const pic = await ap.evaluate(async () => {
			const act = ActivityAllowedForGroup(ChatRoomCharacter[1], 'ItemArms').find((a) => a.Activity.Name === 'VoidSlash');
			ChatRoomCharacter[1].FocusGroup = AssetGroupGet('Female3DCG', 'ItemArms');
			const btn = ElementButton.CreateForActivity('void-test-act', act, ChatRoomCharacter[1], () => {});
			document.body.append(btn);
			const img = btn.querySelector('img');
			await new Promise((r) => setTimeout(r, 1500));
			const out = { src: img ? img.src : '', ok: !!img && img.complete && img.naturalWidth > 0 };
			btn.remove();
			ChatRoomCharacter[1].FocusGroup = null;
			return out;
		});
		check('the action button shows the weapon item’s picture', pic.ok, pic);
		const runOn = (pg, group, name) =>
			pg.evaluate(
				(group, name) => {
					window.sent = [];
					const act = ActivityAllowedForGroup(ChatRoomCharacter[1], group).find((a) => a.Activity.Name === name);
					ActivityRun(Player, ChatRoomCharacter[1], AssetGroupGet('Female3DCG', group), act);
				},
				group,
				name,
			);
		const lineOf = (pg) =>
			pg.evaluate(() => {
				const m = window.sent.find(
					([t, d]) => t === 'ChatRoomChat' && Array.isArray(d.Dictionary) && d.Dictionary.some((e) => e.Tag === 'VoidOrderAction'),
				);
				if (!m) return null;
				const tag = (t) => (m[1].Dictionary.find((e) => e.Tag === t) || {}).Text;
				// A plain Action: every game shows the text in place of its 'Beep' placeholder.
				return { type: m[1].Type, content: m[1].Content, text: tag('Beep'), action: tag('VoidOrderAction') };
			});
		await runOn(ap, 'ItemArms', 'VoidSlash');
		await wait(1500);
		const slashed = await lineOf(ap);
		check(
			'a slash sends a line players without the add-on read',
			!!slashed &&
				slashed.type === 'Action' &&
				slashed.content === 'Beep' &&
				slashed.text === "Ann slashes at Bea's arm with the Recider." &&
				slashed.action === 'VoidSlash',
			slashed,
		);
		check('an attack rolls Void dice', await ap.evaluate(() => window.sent.some(([t, d]) => t === 'ChatRoomChat' && d.Type === 'Hidden')));
		const selfMenu = await ap.evaluate(() => ActivityAllowedForGroup(Player, 'ItemHands').map((a) => a.Activity.Name));
		check('your own hands offer the upkeep', selfMenu.includes('VoidHone'), selfMenu);
		// Not sexual: no arousal for either, nothing in the activity preferences, and a target with them off is still slashed.
		const arousal = () =>
			ap.evaluate(() => ({
				me: Player.ArousalSettings.Progress,
				bea: ChatRoomCharacter[1].ArousalSettings && ChatRoomCharacter[1].ArousalSettings.Progress,
				prefs: JSON.stringify(Player.ArousalSettings.Activity || ''),
			}));
		await ap.evaluate(() => {
			Player.ArousalSettings.Active = 'Hybrid';
			Player.ArousalSettings.Progress = 10;
			ChatRoomCharacter[1].ArousalSettings = { ...(ChatRoomCharacter[1].ArousalSettings || {}), Active: 'Hybrid', Progress: 10 };
		});
		const aroused0 = await arousal();
		await runOn(ap, 'ItemArms', 'VoidSlash');
		await hold(ap, 'VoidPistols');
		await runOn(ap, 'ItemTorso', 'VoidShoot');
		await hold(ap, 'QueensWrath');
		await runOn(ap, 'ItemTorso', 'VoidReap');
		await wait(1500);
		const aroused1 = await arousal();
		check(
			'a slash, a shot and a reap leave both characters’ arousal as it was',
			aroused1.me === aroused0.me && aroused1.bea === aroused0.bea,
			{
				aroused0,
				aroused1,
			},
		);
		check('nothing is added to the activity preferences', aroused1.prefs === aroused0.prefs);
		check(
			'and none of ours is an activity the game knows (so none is listed in the arousal preferences)',
			!(await ap.evaluate(() => AssetAllActivities('Female3DCG').some((a) => /^Void/.test(a.Name)))),
		);
		check(
			'nothing goes out as an Activity message',
			!(await ap.evaluate(() => window.sent.some(([t, d]) => t === 'ChatRoomChat' && d.Type === 'Activity'))),
		);
		const prayer = await ap.evaluate(() => ActivityAllowedForGroup(Player, 'ItemHands').map((a) => a.Activity.Name));
		check(
			'Queen’s Wrath asks the Void for help, it never channels it',
			prayer.includes('VoidAskVoid') && !prayer.includes('VoidChannel'),
			prayer,
		);
		await hold(ap, 'VoidSwords', { w: 0 });
		await ap.evaluate(() => (ChatRoomCharacter[1].ArousalSettings.Active = 'Inactive'));
		const offMenu = await menuOn(ap, 'ItemArms');
		check('a target with sexual activities off can still be slashed', offMenu.includes('VoidSlash:VoidSwords'), offMenu);
		const blocked = await ap.evaluate(() => {
			ChatRoomCharacter[1].AllowItem = false;
			const names = ActivityAllowedForGroup(ChatRoomCharacter[1], 'ItemArms').map((a) => a.Activity.Name);
			ChatRoomCharacter[1].AllowItem = true;
			return names;
		});
		check('but not someone you may not use items on', !blocked.includes('VoidSlash'), blocked);
		await ap.evaluate(() => (ChatRoomCharacter[1].ArousalSettings.Active = 'Hybrid'));
		// The game's own messages for our items: none (it has no text for them); and names that read well after "a".
		const quiet = await ap.evaluate(() => {
			window.sent = [];
			const data = ModularItemDataLookup.ItemHandheldVoidRifles;
			const item = InventoryGet(Player, 'ItemHandheld');
			const pos = data.modules.find((m) => m.Name === 'Position');
			window[`${data.functionPrefix}PublishAction`](Player, item, pos.Options[1], pos.Options[0]);
			return window.sent.filter(([t]) => t === 'ChatRoomChat').map(([, d]) => d.Content);
		});
		check('changing a gun’s carry sends no message the game has no text for', quiet.length === 0, quiet);
		const names = await ap.evaluate(() =>
			['VoidRifles', 'VoidGlowingBlades', 'QueensWrath'].map((n) => AssetGet('Female3DCG', 'ItemHandheld', n).Description),
		);
		check('the items read well after the game’s "a"', names.join('|') === "Void rifle|Void glowing blade|Queen's Wrath scythe", names);
		// The carry: moving a gun to port arms says so in the room.
		await hold(ap, 'VoidRifles', { w: 0, Position: 0 });
		await wait(1800);
		await ap.evaluate(() => (window.sent = []));
		await hold(ap, 'VoidRifles', { w: 0, Position: 1 });
		await wait(1800);
		const carryLine = await ap.evaluate(() =>
			window.sent.filter(([t, d]) => t === 'ChatRoomChat' && d.Type === 'Action').map(([, d]) => d.Dictionary[0].Text),
		);
		check(
			'carrying a gun at port arms gets its line (from held().position)',
			carryLine.some((t) => /holds across the chest/.test(t)),
			carryLine,
		);
		// Queen's Wrath: its own set; its owner lends it into someone's hands and recalls it.
		await hold(ap, 'QueensWrath');
		const qwMenu = await menuOn(ap, 'ItemTorso');
		check("Queen's Wrath has its own set", qwMenu.includes('VoidReap:QueensWrath') && qwMenu.includes('VoidCast:QueensWrath'), qwMenu);
		await ap.evaluate(() => InventoryRemove(ChatRoomCharacter[1], 'ItemHandheld'));
		await runOn(ap, 'ItemHands', 'VoidLend');
		await wait(1500);
		const lent = await ap.evaluate(() => ({
			bea: InventoryGet(ChatRoomCharacter[1], 'ItemHandheld')?.Asset.Name || '',
			ann: InventoryGet(Player, 'ItemHandheld')?.Asset.Name || '',
		}));
		check("Lend moves Queen's Wrath into Bea's hands", lent.bea === 'QueensWrath' && lent.ann === '', lent);
		check('the lend is recorded on the server', bea.state && bea.state.lent === 12, bea.state && bea.state.lent);
		const recallMenu = await menuOn(ap, 'ItemHands');
		check(
			'Recall is offered on whoever holds it',
			recallMenu.some((x) => x.startsWith('VoidRecall:')),
			recallMenu,
		);
		await runOn(ap, 'ItemHands', 'VoidRecall');
		await wait(1500);
		const back = await ap.evaluate(() => ({
			bea: InventoryGet(ChatRoomCharacter[1], 'ItemHandheld')?.Asset.Name || '',
			ann: InventoryGet(Player, 'ItemHandheld')?.Asset.Name || '',
		}));
		check("Recall brings it back to Ann's hands", back.ann === 'QueensWrath' && back.bea === '', back);
		check('and the lend ends', bea.state && bea.state.lent === 0, bea.state && bea.state.lent);
		// In anyone else's hands it won't move, and they are told why.
		const zed = await gamePage(browser, { me: [20, 'Zed'], other: [11, 'Ann'] });
		await zed.page.waitForFunction(() => !!AssetGet('Female3DCG', 'ItemHandheld', 'QueensWrath') && !!window.VoidOrderModules?.actions, {
			timeout: 30000,
		});
		await wait(2500);
		await hold(zed.page, 'QueensWrath');
		await wait(2000);
		check(
			"someone else holding it is told they aren't its worthy wielder",
			/does not consider you its worthy wielder/.test(await zed.page.evaluate(() => window.local.join('\n'))),
		);
		const zedMenu = await menuOn(zed.page, 'ItemHands');
		check('only its owner sees Lend', !zedMenu.some((x) => x.startsWith('VoidLend')), zedMenu);
		await runOn(zed.page, 'ItemTorso', 'VoidReap');
		await wait(800);
		const refused = await lineOf(zed.page);
		check("in anyone else's hands it weighs two tons", /weighs two tons and will not budge/.test((refused && refused.text) || ''), refused);
		check('no page errors with the Armory', armed.errors.length === 0 && zed.errors.length === 0, [...armed.errors, ...zed.errors]);
		await armed.page.close();
		await zed.page.close();
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
