// Checks the hunt board parser against saved copies of the board: node test-hunt-board.js.
// The fixtures are real pages from vo-p.com with every player's name, member number, photo and notes replaced.
// HUNT_FILES=a.html,b.html also parses other saved copies; LIVE=1 fetches the live board and every page it lists.
import { readFileSync } from 'node:fs';
import { decodeEntities, huntBoardPages, parseHuntBoard } from './src/hunt-board.js';

let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const same = (got, want, what) => check(JSON.stringify(got) === JSON.stringify(want), what, got);
const fixture = (name) => readFileSync(new URL(`./test/fixtures/${name}`, import.meta.url), 'utf8');

const PAGE_1 = fixture('hunt-board.html');
const PAGE_2 = fixture('hunt-board-2.html');

// Entity decoding.
same(
	decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#039;e&#39;'),
	'a & b <c> "d" \'e\'',
	'decodes the basic named and decimal entities',
);
same(
	decodeEntities('&#x1F4B0; &#128683; &mdash; &middot; &rarr; &ldquo;q&rdquo;'),
	'💰 🚫 — · → “q”',
	'decodes hex, astral and typographic entities',
);
same(decodeEntities('&bogus; &amp &#xD800; &#0;'), '&bogus; & \ufffd \ufffd', 'leaves unknown names and replaces invalid code points');

// Page 1.
const one = parseHuntBoard(PAGE_1);
check(one.ok, 'page 1 parses cleanly', one.problems);
same(one.page, { n: 1, of: 2 }, 'page 1 knows it is 1 of 2');
same(one.totals, { board: 102, open: 101, hunted: 1, wanted: 30, debtors: 30 }, 'page 1 totals');
same([one.contracts.length, one.wanted.length, one.debtors.length], [60, 8, 8], 'page 1 has 60 contracts and 8 + 8 wanted rows');
same(one.pages, ['https://vo-p.com/hunt_board.php?p=2'], 'page 1 points at page 2');
same(
	one.contracts[0],
	{
		name: 'Ivy & “Moth”',
		code: 'BH-003170',
		member: 100037,
		reward: 1500,
		bonus: 100,
		terms: 'taunted — alive only',
		quote: 'Run & hide!',
		notes: "Catch me off guard. I'm fine with gags <3",
		postedBy: 'Void Order Prison',
		hunter: '',
		status: 'open',
		tracking: 'live',
		url: null,
		photo: 'https://vo-p.com/uploads/hunt_100037_photo.png',
	},
	'first card, entities in the name, quote and notes decoded',
);
same(
	one.contracts[1],
	{
		name: 'Target 2',
		code: 'BH-003169',
		member: 100074,
		reward: 12000,
		bonus: 500,
		terms: 'taunted — alive only',
		quote: 'Try harder.',
		notes: 'Likes a chase.\n\nAsk before anything permanent.',
		postedBy: 'Void Order Prison',
		hunter: '',
		status: 'open',
		tracking: null,
		url: null,
		photo: null,
	},
	'a card with no photo and no tracking, line breaks kept in the notes',
);
const withFile = one.contracts.find((c) => c.code === 'BH-003168');
same(
	withFile && [withFile.url, withFile.bonus, withFile.terms, withFile.quote],
	['https://vo-p.com/inmate?id=570', 0, '', ''],
	'a card with a prison file and no bonus or quote',
);
same(
	one.contracts.find((c) => c.code === 'BH-003166')?.notes,
	'Rope & tape — "no silent snatching", please 🙂\nLimits in bio ❤️',
	'notes with named, decimal and hex entities',
);
same(
	['live', 'known', null].map((t) => one.contracts.filter((c) => c.tracking === t).length),
	[4, 48, 8],
	'tracking states on page 1',
);
check(
	one.contracts.every((c) => /^BH-\d{6}$/.test(c.code) && Number.isInteger(c.member) && c.reward > 0 && c.postedBy),
	'every card has a code, member number, reward and poster',
);
same(
	one.wanted[0],
	{
		name: 'Escapee 1',
		code: 'VOP-000408',
		threat: 'CRITICAL',
		lastSeen: 'Room 1',
		escaped: 45,
		sightings: 6,
		bounty: 217657242,
		url: 'https://vo-p.com/inmate?id=421',
	},
	'first most wanted row',
);
same(
	one.wanted.find((w) => w.code === 'VOP-000556'),
	{
		name: 'Escapee 5',
		code: 'VOP-000556',
		threat: 'HIGH',
		lastSeen: null,
		escaped: 50,
		sightings: 0,
		bounty: 28078224,
		url: 'https://vo-p.com/inmate?id=564',
	},
	'a wanted row with no sightings',
);
same(
	one.debtors[0],
	{
		name: 'Escapee 9',
		code: 'VOP-000093',
		threat: 'CRITICAL',
		lastSeen: 'VOP Casino',
		escaped: 38,
		sightings: 12,
		bounty: 8574355,
		url: 'https://vo-p.com/inmate?id=60',
	},
	'casino debtors go in their own list',
);

// Page 2.
const two = parseHuntBoard(PAGE_2, 'https://vo-p.com/hunt-board?p=2');
check(two.ok, 'page 2 parses cleanly', two.problems);
same([two.page, two.contracts.length], [{ n: 2, of: 2 }, 42], 'page 2 is 2 of 2 with 42 contracts');
same(two.pages, ['https://vo-p.com/hunt_board.php'], 'page 2 points back at page 1');
same(one.contracts.length + two.contracts.length, one.totals.board, 'both pages together hold the whole board');
same(new Set([...one.contracts, ...two.contracts].map((c) => c.code)).size, 102, 'no card appears twice across pages');
const hunted = two.contracts.filter((c) => c.status === 'hunted');
same(
	hunted.map((c) => [c.code, c.hunter, c.bonus, c.tracking]),
	[['BH-003045', 'Hunter One', 10000, 'live']],
	'the one card being hunted, with its hunter',
);
same(huntBoardPages(PAGE_1), one.pages, 'huntBoardPages agrees with parseHuntBoard');

// Pager gaps are filled from the pager's own link pattern.
const pager = (links) =>
	`<div class="hb-page"><div data-sec="board"><p>Showing 60 of 400 bounties &middot; page 1 of 7</p><nav class="hb-pager">${links}</nav></div></div>`;
same(
	huntBoardPages(
		pager('<a href="hunt_board.php" aria-current="page">1</a><a href="hunt_board.php?p=2">2</a><a href="hunt_board.php?p=7">7</a>'),
	),
	[2, 3, 4, 5, 6, 7].map((n) => `https://vo-p.com/hunt_board.php?p=${n}`),
	'pages missing from the pager are filled in',
);
same(huntBoardPages('<html><body>nothing</body></html>'), [], 'no pager, no other pages');

// A changed or broken page gives ok:false and a reason, never an exception.
const broken = {
	'an empty string': '',
	null: null,
	'a number': 42,
	'an unrelated page': '<!doctype html><html><head><title>Maintenance</title></head><body><h1>Back soon</h1></body></html>',
	'cards renamed': PAGE_1.replaceAll('class="hb-card"', 'class="bounty-card"'),
	'member numbers moved': PAGE_1.replaceAll('class="hb-member"', 'class="hb-bc"'),
	'the page cut in half': PAGE_1.slice(0, PAGE_1.length >> 1),
	'stray markup': '<div class="hb-page"><div class="hb-grid"><div class="hb-card" id="BH-1"><<<>>></div></div></div><script>"</div>',
	'unclosed tags and comments': `<div class="hb-page"><div class="hb-grid"><div class="hb-card"><div class="hb-name">X<!-- `,
};
for (const [what, html] of Object.entries(broken)) {
	let r;
	let threw = null;
	try {
		r = parseHuntBoard(html);
	} catch (e) {
		threw = e;
	}
	check(!threw && r && r.ok === false && r.problems.length > 0, `${what}: ok:false with problems`, threw ? String(threw) : r?.problems);
}
const moved = parseHuntBoard(broken['member numbers moved']);
check(
	moved.problems.some((p) => p.startsWith('BH-003170: no member number')),
	'a missing field names the card it is missing from',
	moved.problems.slice(0, 3),
);
same(moved.contracts.length, 60, 'cards with a missing field are still returned');

// Other saved copies, and the live board.
for (const file of (process.env.HUNT_FILES || '').split(',').filter(Boolean)) {
	const r = parseHuntBoard(readFileSync(file, 'utf8'));
	check(r.ok, `${file}: ${r.contracts.length} contracts, ${r.wanted.length} wanted, ${r.debtors.length} debtors`, r.problems);
}
if (process.env.LIVE) {
	const get = async (url) => {
		const res = await fetch(url, { headers: { 'User-Agent': 'VoidOrderAddon/1.0' } });
		return { url: res.url, html: await res.text() };
	};
	const first = await get('https://vo-p.com/hunt-board');
	const r = parseHuntBoard(first.html, first.url);
	check(r.ok, `live page 1: ${r.contracts.length} contracts, ${r.wanted.length} wanted, ${r.debtors.length} debtors`, r.problems);
	let count = r.contracts.length;
	for (const url of r.pages) {
		const next = await get(url);
		const p = parseHuntBoard(next.html, next.url);
		check(p.ok, `live ${url}: ${p.contracts.length} contracts`, p.problems);
		count += p.contracts.length;
	}
	same(count, r.totals.board, 'live pages add up to the board total');
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
