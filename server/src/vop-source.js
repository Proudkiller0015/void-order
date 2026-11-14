// Everything the server reads from the Void Order Prison's site (vo-p.com) goes through here, so that when the site
// offers an API, only this file changes. Today it reads the public pages.
//
// What the rest of the server sees:
//   fetchHunting(page) → { ok, problems, contracts, wanted, debtors, totals, page, pages }
//     the volunteers' hunting board, one page: see hunt-board.js (Contract, Wanted, HuntBoard) for each field;
//     `pages` are the other pages' numbers.
//   fetchBounties(page) → { ok, problems, inmates, page: { n, of }, total }
//     one page of the bounty board, the escaped inmates by bounty: each inmate is
//     { id, code, member, name, threat, bounty, escapedFor, tags, status, url }: `id` their file's number, `code` the
//     prison number ("VOP-000408"), `member` their Bondage Club member number (null if missing), `threat` e.g. "HIGH",
//     `bounty` in L$, `escapedFor` as written ("2 MO, 4 DAYS"), `status` "escaped", `url` their file.
//     The list itself carries the member number (the files' "Bondage Club Identity"), so files aren't fetched.
// Each never throws: a page that can't be fetched or read gives ok: false with the problems.
import { HUNT_BOARD_URL, decodeEntities, huntBoardPages, parseHuntBoard } from './hunt-board.js';

/** The prison's registry: the escaped inmates, highest bounty first. */
export const BOUNTY_BOARD_URL = 'https://vo-p.com/index.php?status=escaped&sort=bounty';

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

/** The text of a piece of HTML: tags dropped, entities decoded, spaces folded. */
const text = (/** @type {string} */ html) =>
	decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();

/**
 * One page of the registry's escaped inmates, read from its HTML. Never throws.
 * @param {string} html
 * @param {string} [base] the page's address, for the files' links
 */
export function parseBountyBoard(html, base = BOUNTY_BOARD_URL) {
	const problems = [];
	const inmates = [];
	if (typeof html !== 'string' || !html.includes('inmate-card')) {
		return { ok: false, problems: ['no inmate cards on the page'], inmates, page: null, total: null };
	}
	const cards = html.split(/<div class="inmate-card">/).slice(1);
	for (const raw of cards) {
		const card = raw.split(/<!-- ══ PAGINATION|<div class="pagination">/)[0];
		const id = Number((/inmate\.php\?id=(\d+)/.exec(card) || [])[1]) || null;
		const bar = /card-barcode">([^<]*)</.exec(card);
		const barText = bar ? text(bar[1]) : '';
		const code = (/VOP-\d+/.exec(barText) || [''])[0];
		const member = Number((/·\s*(\d{1,9})\s*$/.exec(barText) || [])[1]) || null;
		const name = text((/<div class="card-name">([\s\S]*?)<\/div>/.exec(card) || [])[1]);
		const threat = ((/class="card-threat threat-([a-z]+)"/.exec(card) || [])[1] || '').toUpperCase();
		const bountyText = (/([\d,]+)\s*L\$\s*BOUNTY/i.exec(card) || [])[1];
		const status = (/stamp stamp-([a-z]+)/.exec(card) || [])[1] || '';
		const metas = [...card.matchAll(/<div class="card-meta"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
		const escapedFor = (metas.find((m) => /\b(DAY|DAYS|MO|HOUR|HOURS|MIN)\b/.test(m) && !/BOUNTY|Admitted/i.test(m)) || '')
			.replace(/^[^0-9A-Z]+/, '')
			.trim();
		const tags = [...card.matchAll(/<span class="tag-badge[^"]*">([\s\S]*?)<\/span>/g)].map((m) => text(m[1])).filter(Boolean);
		if (!code || !name) {
			problems.push(`a card without ${!code ? 'a prison number' : 'a name'}`);
			continue;
		}
		inmates.push({
			id,
			code,
			member,
			name,
			threat,
			bounty: bountyText ? Number(bountyText.replace(/,/g, '')) : null,
			escapedFor,
			tags,
			status,
			url: id ? new URL(`inmate.php?id=${id}`, base).href : null,
		});
	}
	const info = /PAGE\s+(\d+)\s*\/\s*(\d+)\s*(?:&mdash;|—|-)\s*(\d+)\s*RESULTS/i.exec(html);
	return {
		ok: !problems.length && inmates.length > 0,
		problems,
		inmates,
		page: info ? { n: Number(info[1]), of: Number(info[2]) } : null,
		total: info ? Number(info[3]) : null,
	};
}

/**
 * One page of the bounty board (the escaped inmates, highest bounty first).
 * @param {number} n the page (1 first)
 * @param {string} [base] the list's address (a test server points elsewhere)
 */
export async function fetchBounties(n = 1, base = BOUNTY_BOARD_URL) {
	const url = n > 1 ? `${base}&page=${n}` : base;
	const problems = [];
	const html = await page(url, problems);
	return html ? parseBountyBoard(html, base) : { ok: false, problems, inmates: [], page: null, total: null };
}
