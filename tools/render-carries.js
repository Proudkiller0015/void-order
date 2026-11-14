// Renders the Armory's items in each carry, on a slim outfit and a wide one, past the edge as the add-on draws them.
// Run: BC_ROOT=<a Bondage Club checkout's BondageClub folder> CHROME=<chrome.exe> node tools/render-carries.js [item…]
// Writes shots/carries/<item>.png: one row per outfit, one column per carry option.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = process.env.BC_ROOT;
const CHROME = process.env.CHROME;
const PORT = Number(process.env.WEB_PORT) || 8189;
const HERE = path.join(__dirname, '..');
const OUT = path.join(HERE, 'shots', 'carries');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const web = http.createServer((req, res) => {
	const url = decodeURIComponent(req.url.split('?')[0]);
	const p = url.startsWith('/void-assets/')
		? path.join(HERE, 'assets', url.slice('/void-assets/'.length))
		: url.startsWith('/void-src/')
			? path.join(HERE, 'src', url.slice('/void-src/'.length))
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** The outfits: the game's default clothes, and a wide one (a yukata with long back hair). */
const OUTFITS = {
	slim: [],
	wide: ['Yukata1', 'HairBack20'],
};

(async () => {
	if (!ROOT || !CHROME) {
		console.error('Set BC_ROOT and CHROME.');
		process.exit(2);
	}
	fs.mkdirSync(OUT, { recursive: true });
	await new Promise((r) => web.listen(PORT, r));
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
	const page = await browser.newPage();
	await page.setViewport({ width: 2000, height: 1000 });
	await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 120000 });
	await page.waitForFunction(() => typeof Asset !== 'undefined' && Asset.length > 1000 && typeof Player !== 'undefined' && !!Player, {
		timeout: 120000,
	});
	await wait(1000);
	await page.evaluate(() => {
		cancelAnimationFrame(GameAnimationFrameId);
		GameRun = () => {};
		window.VoidOrderServer = 'ws://127.0.0.1:9/ws';
		window.VoidOrderAssets = `${location.origin}/void-assets/`;
		window.VoidOrderSrc = `${location.origin}/void-src/`;
		ServerSend = () => {};
	});
	await page.addScriptTag({ path: path.join(HERE, 'void.js') });
	await page.waitForFunction(
		() => window.VoidOrderModules && window.VoidOrderModules.overflow && !!AssetGet('Female3DCG', 'ItemHandheld', 'QueensWrath'),
		{
			timeout: 20000,
		},
	);
	await page.evaluate(() => {
		Player.Type = CharacterType.PLAYER;
		Player.MemberNumber = 11;
		Player.OnlineSharedSettings = { GameVersion };
		CharacterAppearanceSetDefault(Player);
		ChatRoomCharacter = [Player];
		CurrentScreen = 'ChatRoom';
	});
	const wanted = process.argv.slice(2);
	const items = await page.evaluate(() =>
		Asset.filter((a) => a.Group.Name === 'ItemHandheld' && /^Void|^QueensWrath$/.test(a.Name)).map((a) => {
			const data = ModularItemDataLookup[`ItemHandheld${a.Name}`];
			const carry = data && data.modules.find((m) => m.Key === 'Position');
			return {
				name: a.Name,
				carries: carry ? carry.Options.length : 1,
				labels: carry ? carry.Options.map((o) => AssetTextGet(`ItemHandheld${a.Name}Option${o.Name}`)) : ['held'],
			};
		}),
	);
	for (const it of items.filter((x) => !wanted.length || wanted.includes(x.name))) {
		const shots = [];
		for (const [outfit, clothes] of Object.entries(OUTFITS)) {
			for (let p = 0; p < it.carries; p++) {
				const png = await page.evaluate(
					async (name, p, clothes) => {
						CharacterAppearanceSetDefault(Player);
						for (const name of clothes) {
							const a = Asset.find((x) => x.Name === name && x.Group.Category === 'Appearance');
							if (!a) continue;
							if (a.Group.Name.startsWith('Cloth')) ['Cloth', 'ClothLower', 'ClothOuter'].forEach((g) => InventoryRemove(Player, g));
							InventoryWear(Player, a.Name, a.Group.Name);
						}
						InventoryWear(Player, name, 'ItemHandheld');
						const item = InventoryGet(Player, 'ItemHandheld');
						const data = ModularItemDataLookup[`ItemHandheld${name}`];
						if (data && data.modules.some((m) => m.Key === 'Position')) {
							ExtendedItemSetOptionByRecord(
								Player,
								item,
								{ ...(item.Property?.TypeRecord || {}), Position: p },
								{ push: false, refresh: true },
							);
						}
						CharacterRefresh(Player, false);
						for (let i = 0; i < 12; i++) {
							CharacterLoadCanvas(Player);
							await new Promise((r) => setTimeout(r, 150));
						}
						MainCanvas.fillStyle = '#2a2d3a';
						MainCanvas.fillRect(0, 0, 2000, 1000);
						DrawCharacter(Player, 750, 0, 1);
						const c = document.createElement('canvas');
						c.width = 1000;
						c.height = 1000;
						c.getContext('2d').drawImage(MainCanvas.canvas, 500, 0, 1000, 1000, 0, 0, 1000, 1000);
						return c.toDataURL('image/png');
					},
					it.name,
					p,
					clothes,
				);
				shots.push({ outfit, p, png });
			}
		}
		// One sheet per item: slim on top, wide below, one column per carry.
		const sheet = await page.evaluate(
			async (shots, cols, labels) => {
				const c = document.createElement('canvas');
				c.width = cols * 500;
				c.height = 2 * 500 + 40;
				const g = c.getContext('2d');
				g.fillStyle = '#1b1d26';
				g.fillRect(0, 0, c.width, c.height);
				g.fillStyle = '#ddd';
				g.font = '22px sans-serif';
				labels.forEach((l, i) => g.fillText(`${i}: ${l}`, i * 500 + 10, 28));
				for (const s of shots) {
					const img = new Image();
					img.src = s.png;
					await img.decode();
					g.drawImage(img, s.p * 500, 40 + (s.outfit === 'slim' ? 0 : 500), 500, 500);
				}
				return c.toDataURL('image/png');
			},
			shots,
			it.carries,
			it.labels,
		);
		fs.writeFileSync(path.join(OUT, `${it.name}.png`), Buffer.from(sheet.split(',')[1], 'base64'));
		console.log(it.name, it.labels.join(' | '));
	}
	await browser.close();
	web.close();
})().catch((e) => {
	console.error('FAILED', e);
	process.exit(1);
});
