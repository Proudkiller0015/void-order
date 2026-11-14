// The Armory's items in the real game, headless, never logged in: registered before sign-in, worn, drawn past the
// edge of the character, seen by a player without the add-on, and a game that changed under the add-on.
// Run: BC_ROOT=<a Bondage Club checkout's BondageClub folder> CHROME=<chrome.exe> node test-items.js. SHOTS=1 saves
// pictures to shots/.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = process.env.BC_ROOT;
const CHROME = process.env.CHROME;
if (!ROOT || !CHROME) {
	console.error('Set BC_ROOT (a Bondage Club checkout: its BondageClub folder) and CHROME (the Chrome executable).');
	process.exit(2);
}
const PORT = 8179;
const SHOTS = !!process.env.SHOTS;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
/** @type {Set<string>} Paths the test server answers 404 to, for a part of the add-on that didn't load. */
const blocked = new Set();
const web = http.createServer((req, res) => {
	const url = decodeURIComponent(req.url.split('?')[0]);
	const p = url.startsWith('/void-assets/')
		? path.join(__dirname, 'assets', url.slice('/void-assets/'.length))
		: url.startsWith('/void-src/')
			? path.join(__dirname, 'src', url.slice('/void-src/'.length))
			: path.join(ROOT, url);
	fs.readFile(p, (err, data) => {
		if (err || blocked.has(url)) {
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
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Saves the game's canvas (the screen without the login page's form on top). */
const shot = async (page, name) => {
	if (!SHOTS) return;
	fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
	const data = await page.evaluate(() => MainCanvas.canvas.toDataURL('image/png'));
	fs.writeFileSync(path.join(__dirname, 'shots', `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
};

/** The pixel width of a PNG file. */
const pngWidth = (file) => fs.readFileSync(file).readUInt32BE(16);
/** The Armory weapon whose drawing reaches furthest right, and how far (x of its right edge in the 500 px picture). */
function widestRight() {
	const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'items', 'items.json'), 'utf8'));
	let best = { right: 0 };
	for (const item of data.items.filter((i) => i.name !== 'QueensWrath')) {
		for (const layer of item.def.Layer) {
			const file = path.join(__dirname, 'assets', 'items', 'img', `${item.source}_${layer.Name}.png`);
			if (layer.HasImage === false || !fs.existsSync(file)) continue;
			const right = (layer.Left || 0) + pngWidth(file);
			if (right > best.right) {
				best = {
					right,
					item: item.name,
					w: layer.AllowTypes ? [].concat(layer.AllowTypes.w ?? 0)[0] : 0,
					position: layer.AllowTypes ? [].concat(layer.AllowTypes.Position ?? 0)[0] : 0,
				};
			}
		}
	}
	return best;
}

/**
 * A page with the game, a fake signed-in player (Ann, 11) and Bea (13) in a fake chat room. `hostile` is code run
 * before the add-on loads (a changed game), `after` once its modules have had time to load; `vanilla` leaves the
 * add-on out.
 */
async function gamePage(browser, { hostile = '', after = '', vanilla = false, assets = '' } = {}) {
	const page = await browser.newPage();
	await page.setViewport({ width: 2000, height: 1000 });
	const errors = [];
	const warnings = [];
	// Only errors that pass through the add-on's own files count: in a game missing a function, the game's own code
	// calling it throws too, and that isn't ours to prevent.
	page.on('pageerror', (e) => {
		const stack = String(e.stack || '');
		if (!stack.includes('\n') || /void\.js|\/void-src\//.test(stack)) {
			errors.push(process.env.STACKS ? stack || String(e.message) : String(e.message).split('\n')[0]);
		}
	});
	page.on('console', (m) => {
		if (/Oculus Nihili/.test(m.text())) warnings.push(m.text());
	});
	await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 120000 });
	await page.waitForFunction(() => typeof Asset !== 'undefined' && Asset.length > 1000 && typeof Player !== 'undefined' && !!Player, {
		timeout: 120000,
	});
	await wait(1000);
	await page.evaluate((assets) => {
		cancelAnimationFrame(GameAnimationFrameId);
		GameRun = () => {};
		window.VoidOrderServer = 'ws://127.0.0.1:9/ws';
		window.VoidOrderAssets = assets || `${location.origin}/void-assets/`;
		window.VoidOrderSrc = `${location.origin}/void-src/`;
		window.sent = [];
		ServerSend = (msg, data) => window.sent.push([msg, data]);
	}, assets);
	if (hostile) {
		await page.evaluate(hostile);
	}
	if (!vanilla) {
		await page.addScriptTag({ path: path.join(__dirname, 'void.js') });
		await page
			.waitForFunction(
				() => window.VoidOrderModules && window.VoidOrderModules.overflow && !!AssetGet('Female3DCG', 'ItemHandheld', 'QueensWrath'),
				{
					timeout: 15000,
				},
			)
			.catch(() => {});
		await wait(500);
	}
	if (after) {
		await page.evaluate(after);
	}
	// Signed in, in a room with Bea.
	await page.evaluate(() => {
		Player.Type = CharacterType.PLAYER;
		Player.MemberNumber = 11;
		Player.Name = Player.Nickname = 'Ann';
		Player.OnlineSharedSettings = { GameVersion };
		Player.FriendList = [];
		Player.WhiteList = [];
		Player.BlackList = [];
		Player.GhostList = [];
		CharacterAppearanceSetDefault(Player);
		const bea = CharacterLoadOnline(
			{
				ID: 'b',
				Name: 'Bea',
				Nickname: 'Bea',
				MemberNumber: 13,
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
		CharacterAppearanceSetDefault(bea);
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
	});
	await wait(1200);
	return { page, errors, warnings };
}

/** Waits for the characters' pictures to load, redrawing them meanwhile. */
const settle = (page) =>
	page.evaluate(async () => {
		for (let i = 0; i < 25; i++) {
			for (const c of ChatRoomCharacter) CharacterLoadCanvas(c);
			await new Promise((r) => setTimeout(r, 200));
		}
	});

/**
 * Draws a character on an empty screen and measures how its weapon meets the left and right edges of its 500 px
 * picture: how many rows have colour just outside the edge, and of the rows with colour just inside, how many carry on
 * outside (a weapon drawn past the edge in the right place carries on across it).
 */
const edges = (page, { member, zoom = 1, inverted = false }) =>
	page.evaluate(
		({ member, zoom, inverted }) => {
			const c = ChatRoomCharacter.find((x) => x.MemberNumber === member);
			const was = window.CharacterAppearsInverted;
			if (inverted) window.CharacterAppearsInverted = () => true;
			MainCanvas.fillStyle = '#123456';
			MainCanvas.fillRect(0, 0, 2000, 1000);
			const X = 700;
			// No zone outlines: the game draws them over a character with a focused group, and one runs along the edge.
			const focus = c.FocusGroup;
			c.FocusGroup = null;
			DrawCharacter(c, X, 0, zoom);
			c.FocusGroup = focus;
			window.CharacterAppearsInverted = was;
			const left = X + CharacterAppearanceXOffset(c, c.HeightRatio) * zoom;
			const right = left + 500 * c.HeightRatio * zoom;
			const data = MainCanvas.getImageData(0, 0, 2000, 1000).data;
			const filled = (x, y) => {
				const i = (Math.round(y) * 2000 + Math.round(x)) * 4;
				return !(data[i] === 0x12 && data[i + 1] === 0x34 && data[i + 2] === 0x56);
			};
			const side = (edge, dir) => {
				let outside = 0;
				let inside = 0;
				let both = 0;
				for (let y = 0; y < 1000; y++) {
					const out = filled(edge + dir * 6, y);
					const inn = filled(edge - dir * 6, y);
					if (out) outside++;
					if (inn) {
						inside++;
						if (out || filled(edge + dir * 6, y + 1) || filled(edge + dir * 6, y - 1)) both++;
					}
				}
				return { outside, inside, carried: inside ? both / inside : 1 };
			};
			return { left: side(left, -1), right: side(right, 1) };
		},
		{ member, zoom, inverted },
	);

/** Everything a player does that touches the hooked game functions, with what failed. */
const playAround = (page) =>
	page.evaluate(async () => {
		const out = [];
		const step = (name, f) => {
			try {
				f();
			} catch (e) {
				out.push(`${name}: ${e && e.message}`);
			}
		};
		step('wear a vanilla hand item', () => InventoryWear(Player, 'Crop', 'ItemHandheld'));
		step('refresh', () => CharacterRefresh(Player, false));
		for (let i = 0; i < 10; i++) {
			step('redraw', () => ChatRoomCharacter.forEach((c) => CharacterLoadCanvas(c)));
			await new Promise((r) => setTimeout(r, 150));
		}
		step('draw the room', () => ChatRoomCharacterViewDraw());
		step('draw a character', () => DrawCharacter(Player, 100, 0, 1));
		step('item list', () => {
			const g = AssetGroupGet('Female3DCG', 'ItemHandheld');
			Player.FocusGroup = g;
			DialogInventoryBuild(Player, g);
			if (!DialogInventory.length) throw new Error('empty item list');
		});
		step('activities', () => {
			const list = ActivityAllowedForGroup(ChatRoomCharacter[1], 'ItemMouth');
			if (!Array.isArray(list)) throw new Error('no activity list');
		});
		step('wardrobe', () => {
			CharacterAppearanceLoadCharacter(Player);
			AppearanceRun();
		});
		step('chat', () => ServerSend('ChatRoomChat', { Content: 'hello', Type: 'Chat' }));
		step('outfit to the server and back', () => {
			const bundle = ServerAppearanceBundle(Player.Appearance);
			ServerAppearanceLoadFromBundle(Player, 'Female3DCG', bundle, 11);
		});
		return out;
	});

(async () => {
	await new Promise((r) => web.listen(PORT, r));
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: 'new',
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
	});
	const version = await (async () => {
		const p = await browser.newPage();
		await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 120000 });
		await p.waitForFunction(() => typeof GameVersion === 'string', { timeout: 60000 });
		const v = await p.evaluate(() => GameVersion);
		await p.close();
		return v;
	})();
	console.log(`Game ${version}`);

	// ---- The items, worn and drawn
	{
		const { page, errors } = await gamePage(browser);
		const items = await page.evaluate(() =>
			Asset.filter((a) => a.Group.Name === 'ItemHandheld' && /^(Void[A-Z]|QueensWrath$)/.test(a.Name)).map((a) => a.Name),
		);
		check('the ten Armory items are registered', items.length === 10, items);
		const listed = await page.evaluate(() => {
			const g = AssetGroupGet('Female3DCG', 'ItemHandheld');
			Player.FocusGroup = g;
			DialogInventoryBuild(Player, g);
			return DialogInventory.filter((i) => /^(Void[A-Z]|QueensWrath$)/.test(i.Asset.Name)).length;
		});
		check('they are in the hand item list', listed === 10, listed);
		const widest = widestRight();
		await page.evaluate((widest) => {
			CharacterNaked(Player);
			InventoryWear(Player, 'QueensWrath', 'ItemHandheld');
			CharacterRefresh(Player, false);
			const bea = ChatRoomCharacter[1];
			CharacterNaked(bea);
			InventoryWear(bea, widest.item, 'ItemHandheld');
			ExtendedItemSetOptionByRecord(
				bea,
				InventoryGet(bea, 'ItemHandheld'),
				{ w: widest.w, Position: widest.position },
				{ push: false, refresh: true },
			);
			CharacterRefresh(bea, false);
		}, widest);
		await settle(page);
		const names = await page.evaluate(() => ChatRoomCharacter.map((c) => InventoryGet(c, 'ItemHandheld')?.Asset.Description));
		check(
			'Ann holds Queen’s Wrath, Bea the weapon reaching furthest right',
			names[0] === "Queen's Wrath scythe" && /^Void /.test(names[1]),
			names,
		);
		const ann = await edges(page, { member: 11 });
		check('Queen’s Wrath is drawn past the left edge', ann.left.outside > 20, ann.left);
		check('and carries on across it where it crosses', ann.left.carried > 0.8, ann.left);
		await shot(page, 'items-wrath');
		const bea = await edges(page, { member: 13 });
		check(
			`${widest.item} (right edge at ${widest.right} px) is drawn past the right edge`,
			widest.right <= 500 || bea.right.outside > 20,
			bea.right,
		);
		check('and carries on across it', bea.right.carried > 0.8, bea.right);
		await shot(page, 'items-upside-down');
		const zoomed = await edges(page, { member: 11, zoom: 0.6 });
		await shot(page, 'items-zoomed');
		check('zoomed out, it still carries on across the edge', zoomed.left.outside > 10 && zoomed.left.carried > 0.8, zoomed.left);
		const upside = await edges(page, { member: 11, inverted: true });
		check(
			'upside down, it is drawn past the other edge and carries on',
			upside.right.outside > 20 && upside.right.carried > 0.8,
			upside.right,
		);
		await shot(page, 'items-upside-down');
		// The room, three characters side by side.
		const room = await page.evaluate(() => {
			const cat = CharacterLoadOnline(
				{
					ID: 'c',
					Name: 'Cat',
					Nickname: 'Cat',
					MemberNumber: 14,
					AssetFamily: 'Female3DCG',
					Appearance: ServerAppearanceBundle(Player.Appearance),
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
			ChatRoomCharacter = [Player, ChatRoomCharacter[1], cat];
			return InventoryGet(cat, 'ItemHandheld')?.Asset.Name;
		});
		check('a third player’s outfit with Queen’s Wrath loads', room === 'QueensWrath', room);
		await settle(page);
		const roomErr = await page.evaluate(() => {
			try {
				MainCanvas.clearRect(0, 0, 2000, 1000);
				ChatRoomCharacterViewDraw();
				return '';
			} catch (e) {
				return String(e);
			}
		});
		check('the room draws', !roomErr, roomErr);
		await shot(page, 'items-room');
		const wardrobe = await page.evaluate(() => {
			try {
				CharacterAppearanceLoadCharacter(Player);
				MainCanvas.clearRect(0, 0, 2000, 1000);
				AppearanceRun();
				return '';
			} catch (e) {
				return String(e);
			}
		});
		check('the wardrobe draws', !wardrobe, wardrobe);
		await shot(page, 'items-wardrobe');
		// An outfit from another version of the add-on: a weapon number this one doesn't have.
		const odd = await page.evaluate(() => {
			const bundle = [
				{
					Group: 'ItemHandheld',
					Name: 'VoidPistols',
					Property: { TypeRecord: { w: 999, Position: 7 } },
					Color: ['Default', 'Default', 'Default'],
				},
			];
			const c = CharacterLoadNPC('NPC_Odd');
			ServerAppearanceLoadFromBundle(c, 'Female3DCG', bundle, 11);
			CharacterRefresh(c, false);
			return JSON.stringify(InventoryGet(c, 'ItemHandheld')?.Property?.TypeRecord ?? null);
		});
		check('an outfit with a weapon number this version lacks loads (the number is reset)', odd !== 'null' && !/999/.test(odd), odd);
		// Someone without the add-on sends Ann's outfit back without her weapon.
		const kept = await page.evaluate(() => {
			Player.FriendList = [];
			Player.WhiteList = [];
			Player.BlackList = [];
			Player.GhostList = [];
			const item = InventoryGet(Player, 'ItemHandheld');
			const r1 = ValidationResolveRemoveDiff(item, ValidationCreateDiffParams(Player, 13));
			ChatRoomCharacter[1].OnlineSharedSettings = { OculusNihili: '2.0.0' };
			const r2 = ValidationResolveRemoveDiff(item, ValidationCreateDiffParams(Player, 13));
			return [r1.valid, !!r1.item, r2.item === null || r2.valid];
		});
		check('a player without the add-on can’t take your weapon off by accident', kept[0] === false && kept[1], kept);
		check('a player with the add-on can', kept[2] === true, kept);
		check('no errors with the items', !errors.length, errors);
		await page.close();
	}

	// ---- Without the drawing module, the weapon is cut off at the edge as before
	{
		blocked.add('/void-src/overflow.js');
		const { page, errors } = await gamePage(browser);
		blocked.clear();
		await page.evaluate(() => {
			CharacterNaked(Player);
			InventoryWear(Player, 'QueensWrath', 'ItemHandheld');
			CharacterRefresh(Player, false);
		});
		await settle(page);
		const cut = await edges(page, { member: 11 });
		check('without src/overflow.js, Queen’s Wrath stops at the edge', cut.left.outside === 0 && cut.left.inside > 20, cut.left);
		check('and nothing errors', !errors.length, errors);
		await page.close();
	}

	// ---- A player without the add-on sees someone holding Armory items
	{
		const { page, errors } = await gamePage(browser, { vanilla: true });
		const seen = await page.evaluate(() => {
			const bundle = [
				{ Group: 'ItemHandheld', Name: 'QueensWrath', Color: ['#2A2233'] },
				{ Group: 'Cloth', Name: 'CollegeOutfit1' },
			];
			const c = CharacterLoadNPC('NPC_Seen');
			const ok = ServerAppearanceLoadFromBundle(c, 'Female3DCG', bundle, 13);
			CharacterRefresh(c, false);
			CharacterLoadCanvas(c);
			DrawCharacter(c, 0, 0, 1);
			return { hand: InventoryGet(c, 'ItemHandheld')?.Asset.Name ?? null, cloth: InventoryGet(c, 'Cloth')?.Asset.Name ?? null, ok };
		});
		check(
			'without the add-on, the weapon is left out and the rest of the outfit loads',
			seen.hand === null && seen.cloth === 'CollegeOutfit1',
			seen,
		);
		check('and nothing errors', !errors.length, errors);
		await page.close();
	}

	// ---- A game that changed under the add-on
	const SAVE = (name) =>
		`window.__saved = window.__saved || {}; window.__saved[${JSON.stringify(name)}] = window[${JSON.stringify(name)}]; window[${JSON.stringify(name)}] = undefined;`;
	const RESTORE = `for (const [k, v] of Object.entries(window.__saved || {})) window[k] = v;`;
	/** @type {[string, { hostile?: string, after?: string, assets?: string }, RegExp][]} */
	const changes = [
		...[
			'CommonFetch',
			'AssetTextGet',
			'ValidationResolveRemoveDiff',
			'CharacterAppearanceBuildCanvas',
			'DrawCharacter',
			'DrawImageEx',
			'CommonDrawAppearanceBuild',
			'AssetAdd',
			'DrawImageCanvas',
		].map(
			(name) => /** @type {[string, any, RegExp]} */ ([`the game has no ${name}`, { hostile: SAVE(name), after: RESTORE }, /switched off/]),
		),
		[
			'the mod SDK is missing',
			{ hostile: 'window.__sdk = window.bcModSdk; window.bcModSdk = undefined;', after: 'window.bcModSdk = window.__sdk;' },
			/switched off/,
		],
		[
			'adding an item throws',
			{
				hostile: `const add = AssetAdd; window.AssetAdd = (g, def, ...r) => { if (/^Void|QueensWrath/.test(def.Name)) throw new Error('changed'); return add(g, def, ...r); };`,
			},
			/Weapon items switched off/,
		],
		[
			'the character drawing callbacks changed',
			{
				hostile: `const build = CommonDrawAppearanceBuild; window.CommonDrawAppearanceBuild = (c, cb) => { if (cb.drawImageBlink.length === 0) throw new TypeError('drawImageBlink needs 4 arguments'); return build(c, cb); };`,
			},
			/Long weapons switched off/,
		],
		['the add-on’s pictures are unreachable', { assets: 'http://127.0.0.1:9/void-assets/' }, /Weapon items switched off/],
	];
	for (const [what, opts, said] of changes) {
		const { page, errors, warnings } = await gamePage(browser, opts);
		await page.evaluate(() => {
			if (AssetGet('Female3DCG', 'ItemHandheld', 'QueensWrath')) {
				InventoryWear(Player, 'QueensWrath', 'ItemHandheld');
				InventoryWear(ChatRoomCharacter[1], 'VoidSniperRifles', 'ItemHandheld');
			}
		});
		const failedSteps = await playAround(page);
		check(
			`${what}: the game carries on (room, characters, items, activities, wardrobe, chat, outfits)`,
			!failedSteps.length && !errors.length,
			{
				failedSteps,
				errors,
			},
		);
		check(
			`${what}: the add-on says what it switched off`,
			warnings.some((w) => said.test(w)),
			warnings,
		);
		if (what === 'the character drawing callbacks changed') {
			await shot(page, 'items-hostile');
		}
		await page.close();
	}

	await browser.close();
	web.close();
	console.log(`\n${version}: ${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
})();
