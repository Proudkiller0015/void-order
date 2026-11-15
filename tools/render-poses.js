// Renders hand-held items across the game's arm poses: one row per item (and carry), one column per pose.
// Run: BC_ROOT=<BondageClub folder> CHROME=<chrome.exe> node tools/render-poses.js <out name> <item[:carry][@weapon]>…
// Writes shots/poses/<out name>.png, and <out name>-hands.png: the same, cropped to the hands at twice the size.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = process.env.BC_ROOT;
const CHROME = process.env.CHROME;
const PORT = Number(process.env.WEB_PORT) || 8189;
const HERE = path.join(__dirname, '..');
const OUT = path.join(HERE, 'shots', 'poses');
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
/** The poses, as the game names them (BodyUpper, BodyHands and BodyFull ones; BaseUpper is no pose at all). */
const POSES = (
	process.env.POSES || 'BaseUpper,TapedHands,Yoked,OverTheHead,BackBoxTie,BackElbowTouch,BackCuffs,Kneel,AllFours,Hogtied'
).split(',');

(async () => {
	if (!ROOT || !CHROME) {
		console.error('Set BC_ROOT and CHROME.');
		process.exit(2);
	}
	fs.mkdirSync(OUT, { recursive: true });
	await new Promise((r) => web.listen(PORT, r));
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
	const page = await browser.newPage();
	if (process.env.FUSAM || process.env.ERRORS) page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 160)));
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
	if (process.env.FUSAM) {
		// ADD-ONS: the owner's own FUSAM list (and extra script URLs), loaded before Oculus Nihili as in their browser.
		await page.evaluate((list) => {
			localStorage.setItem('fusam.settings', JSON.stringify({ enabledDistributions: JSON.parse(list) }));
			Player.AccountName = 'TEST';
			Player.Name = 'Test';
			Player.MemberNumber = 11;
		}, process.env.FUSAM);
		// PRE: scripts that must run before FUSAM (ER, as in the owner's browser): local paths or URLs.
		for (const u of (process.env.PRE || '').split(' ').filter(Boolean))
			await page.addScriptTag(/^https?:/.test(u) ? { url: u } : { path: u }).catch((e) => console.log('pre', u, e.message));
		await page
			.addScriptTag({ url: 'https://sidiousious.gitlab.io/bc-addon-loader/fusam.js', type: 'module' })
			.catch((e) => console.log('fusam', e.message));
		for (const u of (process.env.SCRIPTS || '').split(' ').filter(Boolean)) await page.addScriptTag({ url: u }).catch((e) => console.log('script', u, e.message));
		await wait(Number(process.env.ADDON_WAIT) || 30000);
		console.log('mods', await page.evaluate(() => (window.bcModSdk ? bcModSdk.getModsInfo().map((m) => m.name + ' ' + m.version).join(', ') : 'no sdk')));
		console.log('fusam', await page.evaluate(() => JSON.stringify(window.FUSAM ? Object.entries(FUSAM.addons || {}).map(([k, v]) => k + ':' + (v.status || '')) : 'none')));
	}
	if (process.env.HOOKINFO) {
		console.log('hooks', await page.evaluate(() => {
			const out = [];
			for (const [name, info] of bcModSdk.getPatchingInfo()) {
				if (/GL|DrawImage|Canvas|AppearanceBuild|DrawCharacter/.test(name)) out.push(name + ' <- ' + [...info.hookedByMods, ...Object.keys(info.patchedByMods || {})].join('/'));
			}
			return out.join(' | ') + ' || GLDrawCanvas ' + (window.GLDrawCanvas ? GLDrawCanvas.width + 'x' + GLDrawCanvas.height : '?');
		}));
	}
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
	if (process.env.NOHAND) {
		await page.evaluate(() => {
			for (const a of Asset) if (a.Group.Name === 'ItemHandheld') a.Layer = a.Layer.filter((l) => l.Name !== 'Hand');
		});
	}
	const [outName, ...specs] = process.argv.slice(2);
	const rows = specs.map((spec) => {
		const m = /^([A-Za-z]+)(?::(\d+))?(?:@(\d+))?$/.exec(spec);
		return {
			spec,
			item: m[1],
			carry: Number(m[2] || 0),
			weapon: Number(m[3] || 0),
			layers: !!process.env.LAYERS,
			probe: process.env.PROBE || '',
			wear: (process.env.WEAR || '').split(',').filter(Boolean),
			nogl: !!process.env.NOGL,
			prop: process.env.PROP ? JSON.parse(process.env.PROP) : null,
			color: process.env.COLOR ? JSON.parse(process.env.COLOR) : null,
			// HANDS_AT: where the hands are in a pose that moves them (as drawn, x,y,size), e.g. "Kneel:870,590,200".
			handsAt: Object.fromEntries(
				(process.env.HANDS_AT || '')
					.split(' ')
					.filter(Boolean)
					.map((s) => s.split(':'))
					.map(([p, r]) => [p, r.split(',').map(Number)]),
			),
		};
	});
	const full = [];
	for (const row of rows) {
		for (const pose of POSES) {
			const shot = await page.evaluate(
				async (row, pose) => {
					window.LAYERS = row.layers;
					if (row.nogl) GLVersion = 'No WebGL';
					CharacterAppearanceSetDefault(Player);
					// WEAR: extra clothes, "Group:Asset,…" (a cloth asset replaces the default clothes).
					for (const spec of row.wear) {
						const [group, asset] = spec.split(':');
						if (group.startsWith('Cloth')) ['Cloth', 'ClothLower', 'ClothOuter'].forEach((g) => InventoryRemove(Player, g));
						InventoryWear(Player, asset, group);
					}
					InventoryWear(Player, row.item, 'ItemHandheld');
					const item = InventoryGet(Player, 'ItemHandheld');
					const data = ModularItemDataLookup[`ItemHandheld${row.item}`];
					if (data) {
						const rec = { ...(item.Property?.TypeRecord || {}) };
						if (data.modules.some((m) => m.Key === 'Position')) rec.Position = row.carry;
						if (data.modules.some((m) => m.Key === 'w')) rec.w = row.weapon;
						ExtendedItemSetOptionByRecord(Player, item, rec, { push: false, refresh: true });
						if (row.prop) Object.assign(item.Property, row.prop);
						if (row.color) item.Color = row.color;
					}
					PoseSetActive(Player, pose === 'BaseUpper' ? null : pose, true);
					CharacterRefresh(Player, false);
					for (let i = 0; i < 12; i++) {
						CharacterLoadCanvas(Player);
						await new Promise((r) => setTimeout(r, 150));
					}
					MainCanvas.fillStyle = '#2a2d3a';
					MainCanvas.fillRect(0, 0, 2000, 1000);
					DrawCharacter(Player, 750, 0, 1);
					const cut = (x, y, w, h, s) => {
						const c = document.createElement('canvas');
						c.width = w * s;
						c.height = h * s;
						c.getContext('2d').drawImage(MainCanvas.canvas, x, y, w, h, 0, 0, w * s, h * s);
						return c.toDataURL('image/png');
					};
					return {
						full: cut(500, 0, 1000, 1000, 0.5),
						hands: row.handsAt[pose]
							? cut(row.handsAt[pose][0], row.handsAt[pose][1], row.handsAt[pose][2], row.handsAt[pose][2], 560 / row.handsAt[pose][2])
							: cut(750 + 110, 300, 280, 280, 2),
						got: ((Player.ActivePose || []).join('+') || 'BaseUpper') + (row.probe ? ` ${String(eval(row.probe))}` : ''),
						layers: window.LAYERS
							? Player.AppearanceLayers.map((l) => `${l.Asset.Group.Name}/${l.Asset.Name}/${l.Name || ''}:${l.Priority}`).join(' ')
							: '',
					};
				},
				row,
				pose,
			);
			full.push({ ...shot, row: row.spec, pose });
			if (process.env.LAYERING) {
				// The game's Layering screen on this item, as a player opens it from the item's menu.
				await page.evaluate(async () => {
					document.querySelectorAll('body > input, body > select, body > button').forEach((e) => (e.style.display = 'none'));
					MainCanvas.fillStyle = '#2a2d3a';
					MainCanvas.fillRect(0, 0, 2000, 1000);
					DrawCharacter(Player, 0, 0, 1);
					await Layering.Init(InventoryGet(Player, 'ItemHandheld'), Player);
				});
				await wait(2500);
				await page.evaluate(() => Layering.Resize?.(true));
				await wait(500);
				const file = path.join(OUT, `${outName}-layering-${row.spec.replace(/[^A-Za-z0-9@]/g, '_')}.png`);
				const info = await page.evaluate(() => {
					const r = document.getElementById(Layering.ID.root);
					// The login screen's own fields sit over it here (the render page never leaves login): out of the way.
					document
						.querySelectorAll('body > input, body > select, body > button, #InputName, #InputPassword')
						.forEach((e) => (e.style.display = 'none'));
					return r ? { text: r.innerText, rect: r.getBoundingClientRect().toJSON() } : null;
				});
				console.log('layering', JSON.stringify(info));
				await page.screenshot({ path: file });
				await page.evaluate(() => {
					try {
						Layering.Exit?.();
					} catch (e) {
						console.warn('layering exit', e);
					}
					document.getElementById('layering')?.remove();
				});
			}
		}
	}
	for (const [name, key, size] of [
		[outName, 'full', 500],
		[`${outName}-hands`, 'hands', 560],
	]) {
		const sheet = await page.evaluate(
			async (shots, cols, rows, key, size) => {
				const c = document.createElement('canvas');
				c.width = 160 + cols.length * size;
				c.height = 40 + rows.length * size;
				const g = c.getContext('2d');
				g.fillStyle = '#1b1d26';
				g.fillRect(0, 0, c.width, c.height);
				g.fillStyle = '#ddd';
				g.font = '18px sans-serif';
				cols.forEach((l, i) => g.fillText(l, 160 + i * size + 6, 26));
				rows.forEach((l, i) => g.fillText(l, 6, 40 + i * size + 24));
				for (const s of shots) {
					const img = new Image();
					img.src = s[key];
					await img.decode();
					g.drawImage(img, 160 + cols.indexOf(s.pose) * size, 40 + rows.indexOf(s.row) * size, size, size);
				}
				return c.toDataURL('image/png');
			},
			full,
			POSES,
			rows.map((r) => r.spec),
			key,
			size,
		);
		fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(sheet.split(',')[1], 'base64'));
	}
	console.log(full.map((s) => `${s.row} ${s.pose} -> ${s.got} ${s.layers}`).join(String.fromCharCode(10)));
	await browser.close();
	web.close();
})().catch((e) => {
	console.error('FAILED', e);
	process.exit(1);
});
