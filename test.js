// The Void Order in the real game, headless, never logged in: a fake chat room as Ann (11, the founder), the
// local server (cd server && npm run dev:test), and Bea (12) played from here. Run: node test.js
// SHOTS=1 saves a picture of each tab to shots/.
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
const check = (name, ok, got) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 500)})`}`);
	if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Bea, a second member played from here.
const { subtle } = globalThis.crypto;
async function peer(member, name) {
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
			ws.send(JSON.stringify({ t: 'auth', member, name, pub: { x: jwk.x, y: jwk.y }, sig }));
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

/** A page with the game, Ann in a fake chat room with Bea, and the add-on pointed at the local server. */
async function gamePage(browser, settings = {}) {
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
		(server, order, settings) => {
			cancelAnimationFrame(GameAnimationFrameId);
			GameRun = () => {};
			Player.Type = CharacterType.PLAYER;
			Player.MemberNumber = 11;
			Player.Name = Player.Nickname = 'Ann';
			Player.GhostList = [];
			Player.BlackList = [];
			Player.WhiteList = [];
			Player.FriendList = [];
			Player.ExtensionSettings = { ...settings };
			CharacterAppearanceSetDefault(Player);
			const bea = CharacterLoadOnline(
				{
					ID: 'b',
					Name: 'Bea',
					Nickname: 'Bea',
					MemberNumber: 12,
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
				11,
			);
			ChatRoomData = {
				Name: 'Void Hall',
				Visibility: ['All'],
				Admin: [11],
				Whitelist: [],
				Ban: [],
				BlockCategory: [],
				Character: [],
				MapData: {},
			};
			ChatRoomCharacter = [Player, bea];
			CurrentScreen = 'ChatRoom';
			window.sent = [];
			window.local = [];
			window.synced = [];
			ServerSend = (msg, data) => window.sent.push([msg, data]);
			ChatRoomSendLocal = (text) => window.local.push(String(text));
			ServerPlayerExtensionSettingsSync = (k) => window.synced.push(k);
			window.VoidOrderServer = `${server}/ws?o=${order}`;
		},
		SERVER,
		ORDER,
		settings,
	);
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

(async () => {
	await new Promise((r) => web.listen(PORT, r));
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
	let bea;
	try {
		const { page, errors } = await gamePage(browser);
		check('/void is registered once the game is ready', true);
		await page.waitForFunction(() => window.synced.includes('VoidOrder'), { timeout: 10000 });
		const saved = await page.evaluate(() => Player.ExtensionSettings.VoidOrder);
		check('a key is made and saved in the account settings', typeof saved === 'string' && saved.length > 20);

		// Founding.
		await page.evaluate(() => Commands.find((c) => c.Tag === 'void').Action('', '/void', []));
		await page.waitForFunction(() => /Found the Order/.test(document.getElementById('void-panel')?.innerText || ''), { timeout: 10000 });
		await shot(page, '01-found');
		await type(page, 'textarea', 'We gaze into the Void, and it gazes back.');
		await type(page, 'input:not([type])', 'test-founding-code', 1);
		await click(page, 'Found the Order');
		await page.waitForFunction(() => /Orders/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 });
		const tabs = await page.evaluate(() => [...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent).join('|'));
		check('founding gives the founder every tab', tabs === 'Orders|Members|The Order|Applications|Manage|My card', tabs);

		// Joining questions, then Bea applies.
		await click(page, 'Manage');
		await type(page, 'textarea', 'Why the Void?\nWho sent you?', 2);
		await click(page, 'Save the about page');
		await wait(400);
		bea = await peer(12, 'Bea');
		check('Bea sees the questions as a guest', bea.state.status === 'guest' && bea.state.meta.questions.length === 2, bea.state);
		await bea.req({ t: 'apply', name: 'Bea', answers: ['To serve.', 'Kikuri'] });
		await wait(400);
		const badge = await page.evaluate(() => document.querySelector('#void-panel nav .badge')?.textContent);
		check('the Applications tab shows one waiting', badge === '1', badge);
		await click(page, 'Applications');
		await shot(page, '02-applications');
		check('the application shows the answers', /To serve\.[\s\S]*Kikuri/.test(await panelText(page)));
		await click(page, 'Let in');
		await wait(500);
		check('Let in makes Bea a member', bea.state.status === 'member', bea.state.status);

		// The ladder: rename Head, add Inquisitor in the middle.
		await click(page, 'Manage');
		await type(page, '.ladder input:not([type])', 'Void Lord', 0);
		await click(page, '＋ Add a rank');
		await type(page, '.ladder input:not([type])', 'Inquisitor', 4);
		await type(page, '.ladder input:not([type])', '≈][≈', 5);
		await click(page, '↑', 2);
		await page.evaluate(() => {
			const boxes = [...document.querySelectorAll('#void-panel .ladder .rk')][1].querySelectorAll('input[type=checkbox]');
			for (const c of boxes) {
				c.checked = true;
				c.dispatchEvent(new Event('change'));
			}
		});
		await click(page, 'Save ranks');
		await wait(500);
		check(
			'the ladder saves: Void Lord, Inquisitor, Member',
			bea.state.ranks.map((r) => r.name).join() === 'Void Lord,Inquisitor,Member' &&
				bea.state.ranks[1].sym === '≈][≈' &&
				bea.state.ranks[1].perms.length === 3,
			bea.state.ranks,
		);
		await shot(page, '03-manage');

		// Promote Bea to Inquisitor from the members-below list.
		const inq = bea.state.ranks[1].id;
		await page.evaluate((inq) => {
			const sel = document.querySelector('#void-panel main select');
			sel.value = inq;
			sel.dispatchEvent(new Event('change'));
		}, inq);
		await wait(500);
		check('the rank picker makes Bea an Inquisitor', bea.state.me.rank === inq, bea.state.me);
		await page.evaluate(() => {
			const t = document.querySelector('#void-panel main .box input');
			t.value = 'Keeper of Cameras';
			t.dispatchEvent(new Event('input'));
		});
		await click(page, 'Set title');
		await wait(400);
		check('Set title gives Bea her title', bea.state.me.title === 'Keeper of Cameras', bea.state.me);

		// A photo session from the panel.
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
		await shot(page, '04-new-session');
		await click(page, 'Send');
		await wait(500);
		const sess = [...bea.orders.values()].find((o) => o.title === 'Uniform photos');
		check('the session reaches Bea with its time', !!sess && sess.kind === 'session' && sess.when > Date.now() + 2 * 864e5, sess);
		await bea.req({ t: 'ack', id: sess.id, a: 'yes' });
		await wait(400);
		check("Ann sees Bea's answer", /Coming \(1\): Bea/.test(await panelText(page)), await panelText(page));

		// Members and the ID card.
		await bea.req({ t: 'profile', bio: 'Watcher of the Void.' });
		await click(page, 'Members');
		await wait(300);
		await shot(page, '06-members');
		check(
			'the member list groups by rank with the symbols',
			/Void Lord[\s\S]*Ann[\s\S]*≈\]\[≈ Inquisitor ≈\]\[≈[\s\S]*Bea/.test(await panelText(page)),
			await panelText(page),
		);
		await page.evaluate(() => [...document.querySelectorAll('#void-panel .member')].find((m) => /Bea/.test(m.textContent)).click());
		await page.waitForSelector('#void-card', { timeout: 5000 });
		const card = await page.evaluate(() => document.getElementById('void-card').innerText);
		check(
			"Bea's ID card: rank, title, bio",
			/Bea[\s\S]*#12[\s\S]*Inquisitor[\s\S]*Keeper of Cameras[\s\S]*Watcher of the Void/.test(card),
			card,
		);
		await shot(page, '07-card');
		await page.evaluate(() => document.getElementById('void-card').remove());

		// Someone showing their ID in the room: the card comes from the server.
		await page.evaluate(() => {
			const h = ChatRoomMessageHandlers.find((x) => x.Description === 'The Void Order ID cards');
			h.Callback({ Type: 'Hidden', Content: 'VoidOrder', Dictionary: [{ card: true }] }, ChatRoomCharacter[1], '', {});
		});
		await page.waitForSelector('#void-card', { timeout: 5000 });
		check(
			'a card shown in the room opens for Void Order users',
			/Shown in this room/.test(await page.evaluate(() => document.getElementById('void-card').innerText)),
		);
		await page.evaluate(() => document.getElementById('void-card').remove());

		// Showing my own.
		await click(page, 'My card');
		await page.evaluate(() => (window.sent = []));
		await click(page, 'Show my ID in this room');
		const shown = await page.evaluate(() => window.sent.map(([m, d]) => `${m}:${d.Type}:${d.Content}`));
		check(
			'Show my ID sends the emote and the hidden note',
			shown.includes('ChatRoomChat:Emote:shows their ID card of The Void Order.') && shown.includes('ChatRoomChat:Hidden:VoidOrder'),
			shown,
		);
		await shot(page, '08-me');

		// My room shows in the list.
		await wait(2500);
		check('my public room shows to the Order', bea.state.members.find((m) => m.n === 11)?.room === 'Void Hall', bea.state.members);
		await page.evaluate(() => (ChatRoomData.Visibility = ['Admin']));
		await wait(2500);
		check('a private room is not shown', bea.state.members.find((m) => m.n === 11)?.room === '', bea.state.members);

		// Orders only go down the ladder, so Ann hands the Order to Bea, who then orders everyone below her: Ann gets a
		// note (escaped: the game shows notes as HTML), a toast and a badge.
		await click(page, 'The Order');
		await page.evaluate(() => {
			const sel = document.querySelector('#void-panel main select');
			sel.value = '12';
		});
		await click(page, 'Hand it over');
		await click(page, 'Hand it over');
		await wait(500);
		check('Ann hands the Order to Bea from The Order tab', bea.state.meta.founder === 12 && bea.state.me.power === -1, bea.state.meta);
		await click(page, 'Orders');
		await page.evaluate(() => (window.local = []));
		const o2 = await bea.req({
			t: 'order',
			kind: 'order',
			title: 'Polish the altar <img src=x>',
			body: 'Before Friday.',
			to: { all: true },
		});
		await wait(500);
		const after = await page.evaluate(() => ({
			local: window.local.join('\n'),
			toast: document.querySelector('.void-toast')?.textContent,
			badge: document.querySelector('#void-panel nav .badge')?.textContent,
		}));
		check(
			'a new order shows as a note, a toast and a badge',
			/New order from Bea: Polish the altar &lt;img src=x&gt;/.test(after.local) &&
				!/<img/.test(after.local) &&
				/Polish the altar <img src=x>/.test(after.toast || '') &&
				after.badge === '1',
			after,
		);
		await shot(page, '05-orders');
		await click(page, '✔ Done');
		await wait(400);
		const acked = await bea.req({ t: 'orders' });
		await wait(200);
		const mineSeen = bea.orders.get(o2.id);
		check('Done answers the order; Bea sees it', mineSeen && mineSeen.acks && mineSeen.acks[11] && mineSeen.acks[11].a === 'done', [
			acked.t,
			mineSeen,
		]);

		// A session reminder.
		await page.evaluate(() => (window.local = []));
		await bea.req({ t: 'order', kind: 'session', title: 'Quick shoot', to: { all: true }, when: Date.now() + 10 * 60000 });
		await page.waitForFunction(() => window.local.some((l) => /Quick shoot starts in 10 min/.test(l)), { timeout: 6000 }).catch(() => {});
		check(
			'a session 10 minutes away brings a reminder',
			await page.evaluate(() => window.local.some((l) => /Quick shoot starts in 10 min/.test(l))),
			await page.evaluate(() => window.local),
		);

		// Another device: the same account settings sign in as the same member.
		const second = await gamePage(browser, { VoidOrder: saved });
		await second.page.evaluate(() => Commands.find((c) => c.Tag === 'void').Action('', '/void', []));
		await second.page
			.waitForFunction(() => /Orders/.test(document.querySelector('#void-panel nav')?.innerText || ''), { timeout: 10000 })
			.catch(() => {});
		const tabs2 = await second.page.evaluate(() =>
			[...document.querySelectorAll('#void-panel nav button')].map((b) => b.textContent.replace(/\d+$/, '')).join('|'),
		);
		check(
			'another device with the same account signs in as the same member',
			tabs2 === 'Orders|Members|The Order|Applications|Manage|My card',
			tabs2,
		);
		const noteOnLogin = await second.page.evaluate(() => window.local.join('\n'));
		check('signing in tells you about unanswered orders', /1 unanswered order/.test(noteOnLogin), noteOnLogin);
		check('no page errors', errors.length === 0 && second.errors.length === 0, [...errors, ...second.errors]);
	} finally {
		if (bea) bea.close();
		await browser.close();
		web.close();
	}
	console.log(failed ? `${failed} FAILED` : 'All checks passed');
	process.exit(failed ? 1 : 0);
})();
