// Checks the readers for the Void Order Prison's pages: node test-vop-source.js. The fixtures are made up in the
// site's markup (the repo is public).
import { readFileSync } from 'node:fs';
import { parseBountyBoard } from './src/vop-source.js';

let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got).slice(0, 400)})`}`);
	if (ok) passed++;
	else failed++;
};
const page = readFileSync(new URL('./test/fixtures/bounty-board.html', import.meta.url), 'utf8');

const board = parseBountyBoard(page);
check(board.ok && board.inmates.length === 2, 'the bounty board reads cleanly', board.problems);
check(board.page && board.page.n === 1 && board.page.of === 10 && board.total === 118, 'its page and total', [board.page, board.total]);
const [one, two] = board.inmates;
check(
	one.id === 421 &&
		one.code === 'VOP-000408' &&
		one.member === 100101 &&
		one.name === 'Escapee & One' &&
		one.threat === 'CRITICAL' &&
		one.bounty === 217657242 &&
		one.escapedFor === '2 MO, 4 DAYS' &&
		one.tags.join() === 'Violent' &&
		one.status === 'escaped' &&
		one.url === 'https://vo-p.com/inmate.php?id=421',
	'an inmate: file, prison number, member number, threat, bounty, time out, tags',
	one,
);
check(two.threat === 'HIGH' && two.tags.length === 0 && two.member === 100102, 'another, without tags', two);
const changed = parseBountyBoard(page.replaceAll('card-barcode', 'barcode'));
check(!changed.ok && changed.problems.length === 2, 'a changed page gives problems, not errors', changed.problems);
check(!parseBountyBoard('').ok && !parseBountyBoard(null).ok, 'an empty page is not ok');

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
