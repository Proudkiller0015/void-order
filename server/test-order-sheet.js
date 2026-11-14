// Checks the Order's bounty sheet reader: node test-order-sheet.js. The fixture is made up (the repo is public).
import { readFileSync } from 'node:fs';
import { csvRows, parseOrderSheet, sheetDate } from './src/order-sheet.js';

let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const CSV = readFileSync(new URL('./test/fixtures/order-sheet.csv', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 14);

const rows = csvRows('a,"b, c","say ""hi""","two\nlines"\n1,2,3,4');
check(
	rows.length === 2 && rows[0][1] === 'b, c' && rows[0][2] === 'say "hi"' && rows[0][3] === 'two\nlines',
	'CSV quotes, commas and line breaks',
	rows,
);
check(sheetDate('8/8/2025 14:06:29') === Date.UTC(2025, 7, 8, 14, 6, 29) && Number.isNaN(sheetDate('never')), 'the sheet’s dates');

const { bounties, problems } = parseOrderSheet(CSV, NOW);
check(!problems.length, 'the sheet reads cleanly', problems);
check(
	bounties.map((b) => b.name).join() === 'Target Five,Target Four,Target One',
	'only bounties with a member number and not expired, newest first',
	bounties.map((b) => b.name),
);
const one = bounties.find((b) => b.name === 'Target One');
check(
	one &&
		one.member === 100001 &&
		one.key === '8/8/2025 14:06:29|100001' &&
		one.reason === 'Too bratty, by order of the Inquisition' &&
		one.reward === '500 credits, from the Order' &&
		one.where === 'The Void Hall' &&
		one.instructions === 'Alive, in chains' &&
		one.look.startsWith('Tall, silver hair') &&
		one.personality === 'Quick, sly',
	'every field of a bounty, found by its question',
	one,
);
check(bounties.find((b) => b.name === 'Target Four')?.expires === 'never', 'an expiry that isn’t a date keeps the bounty');
check(!bounties.some((b) => b.name === 'Target Three'), 'an expired bounty is dropped');
check(!bounties.some((b) => b.name === 'Target Two'), 'a bounty without a member number is left out');
const reordered = CSV.split('\n')
	.map((l) => {
		const cells = csvRows(l)[0] || [];
		return cells.length ? [cells[8], ...cells.slice(0, 8), ...cells.slice(9)].map((c) => `"${c.replace(/"/g, '""')}"`).join(',') : l;
	})
	.join('\n');
check(parseOrderSheet(reordered, NOW).bounties.length === 3, 'columns are found by their questions, in any order');
check(
	parseOrderSheet('', NOW).problems.length > 0 && parseOrderSheet('a,b\n1,2', NOW).problems.length > 0,
	'a changed sheet gives problems, not errors',
);

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
