// Everything the server reads from the Void Order Prison's site (vo-p.com) goes through here, so that when the site
// offers an API, only this file changes. Today it reads the public pages.
//
// What the rest of the server sees:
//   fetchHunting(page) → { ok, problems, contracts, wanted, debtors, totals, page, pages }
//     the volunteers' hunting board, one page: see hunt-board.js (Contract, Wanted, HuntBoard) for each field;
//     `pages` are the other pages' numbers.
//   fetchBounties(page) → the bounty board of escaped inmates (to come).
//   fetchInmate(id) → one inmate's file: { id, member, status, threat, bounty, escaped, sightings } (to come).
// Each never throws: a page that can't be fetched or read gives ok: false with the problems.
import { HUNT_BOARD_URL, huntBoardPages, parseHuntBoard } from './hunt-board.js';

/** How the server introduces itself to the site. */
const AGENT = 'VoidOrderAddon/1.0';

/** A page's HTML, or '' with the reason in `problems`. */
async function page(url, problems) {
	try {
		const res = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(15000) });
		if (!res.ok) {
			problems.push(`HTTP ${res.status}`);
			return '';
		}
		return await res.text();
	} catch (e) {
		problems.push(`fetch failed: ${String(e)}`);
		return '';
	}
}

/**
 * One page of the volunteers' hunting board.
 * @param {number} n the page (1 first)
 * @param {string} [base] the board's address (a test server points elsewhere)
 */
export async function fetchHunting(n = 1, base = HUNT_BOARD_URL) {
	const url = n > 1 ? `${base}?p=${n}` : base;
	const problems = [];
	const html = await page(url, problems);
	if (!html) {
		return { ok: false, problems, contracts: [], wanted: [], debtors: [], totals: null, page: null, pages: [] };
	}
	const board = parseHuntBoard(html, base);
	const pages = huntBoardPages(html, base)
		.map((u) => Number(new URL(u).searchParams.get('p') || 1))
		.filter((p) => Number.isInteger(p) && p !== n);
	return { ...board, pages: [...new Set(pages)].sort((a, b) => a - b) };
}
