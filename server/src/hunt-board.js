// Reads the Void Order Prison's public hunt board (https://vo-p.com/hunt-board) into plain data.
// Runs in the Worker: no DOM, so the page goes through a small forgiving tokenizer and tree builder instead.

/** The board's address, and the base its relative links resolve against. */
export const HUNT_BOARD_URL = 'https://vo-p.com/hunt-board';

/** The most pages huntBoardPages hands out, whatever the page claims. */
const MAX_PAGES = 20;

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const NAMED_ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\xa0',
	middot: '·',
	mdash: '—',
	ndash: '–',
	hellip: '…',
	bull: '•',
	rarr: '→',
	larr: '←',
	uarr: '↑',
	darr: '↓',
	ldquo: '“',
	rdquo: '”',
	lsquo: '‘',
	rsquo: '’',
	laquo: '«',
	raquo: '»',
	sbquo: '‚',
	bdquo: '„',
	copy: '©',
	reg: '®',
	trade: '™',
	times: '×',
	divide: '÷',
	deg: '°',
	plusmn: '±',
	sect: '§',
	para: '¶',
	euro: '€',
	pound: '£',
	yen: '¥',
	cent: '¢',
	hearts: '♥',
	spades: '♠',
	clubs: '♣',
	diams: '♦',
	star: '☆',
	check: '✓',
	iexcl: '¡',
	iquest: '¿',
	shy: '\xad',
	zwj: '\u200d',
	zwnj: '\u200c',
};

/**
 * Turns HTML character references into the characters they stand for: named ones from a common set,
 * decimal (&#39;) and hex (&#x1F4B0;). Unknown names and out-of-range numbers are left as written.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
	return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, ref) => {
		if (ref[0] === '#') {
			const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
			if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
			return String.fromCodePoint(code);
		}
		const named = NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[ref.toLowerCase()];
		return named === undefined ? whole : named;
	});
}

/**
 * @typedef {object} Node
 * @property {string} tag lower-case tag name, '#root' for the document
 * @property {Record<string, string>} attrs attribute values, entities decoded
 * @property {string[]} classes the class attribute's names
 * @property {Array<Node | string>} children elements, and text still HTML-encoded
 */

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** @returns {Record<string, string>} */
function parseAttrs(source) {
	const attrs = {};
	for (const m of source.matchAll(ATTR_RE)) {
		const name = m[1].toLowerCase();
		if (name in attrs) continue;
		const value = m[2] ?? m[3] ?? m[4] ?? '';
		attrs[name] = value.includes('&') ? decodeEntities(value) : value;
	}
	return attrs;
}

/**
 * Builds a loose element tree. Comments, doctypes and the bodies of script/style are dropped. A closing tag
 * closes the nearest open element of that name and everything opened inside it; a closing tag with no open
 * match is ignored, so broken markup still yields a tree.
 * @param {string} html
 * @returns {Node}
 */
function buildTree(html) {
	const root = { tag: '#root', attrs: {}, classes: [], children: [] };
	const stack = [root];
	const tagRe =
		/<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<\/([a-zA-Z][a-zA-Z0-9-]*)[^>]*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	let at = 0;
	let m;
	while ((m = tagRe.exec(html))) {
		const top = stack[stack.length - 1];
		if (m.index > at) top.children.push(html.slice(at, m.index));
		at = tagRe.lastIndex;
		if (m[1]) {
			const name = m[1].toLowerCase();
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].tag === name) {
					stack.length = i;
					break;
				}
			}
		} else if (m[2]) {
			const name = m[2].toLowerCase();
			let attrSource = m[3];
			const selfClosing = /\/\s*$/.test(attrSource);
			if (selfClosing) attrSource = attrSource.replace(/\/\s*$/, '');
			const attrs = parseAttrs(attrSource);
			const node = { tag: name, attrs, classes: attrs.class ? attrs.class.trim().split(/\s+/) : [], children: [] };
			top.children.push(node);
			if (RAW_TEXT_TAGS.has(name)) {
				const endRe = new RegExp(`</${name}\\b[^>]*>`, 'gi');
				endRe.lastIndex = at;
				const end = endRe.exec(html);
				if (name === 'title' || name === 'textarea') node.children.push(html.slice(at, end ? end.index : html.length));
				at = end ? endRe.lastIndex : html.length;
				tagRe.lastIndex = at;
			} else if (!selfClosing && !VOID_TAGS.has(name)) {
				stack.push(node);
			}
		}
	}
	if (at < html.length) stack[stack.length - 1].children.push(html.slice(at));
	return root;
}

/** @returns {boolean} whether `node` carries the class `cls` */
function hasClass(node, cls) {
	return node.classes.includes(cls);
}

/**
 * Every element under `node` (not `node` itself) that passes `test`, in document order.
 * @param {Node} node
 * @param {(n: Node) => boolean} test
 * @returns {Node[]}
 */
function findAll(node, test) {
	const out = [];
	const walk = (n) => {
		for (const c of n.children) {
			if (typeof c === 'string') continue;
			if (test(c)) out.push(c);
			walk(c);
		}
	};
	walk(node);
	return out;
}

const byClass = (node, cls) => findAll(node, (n) => hasClass(n, cls));
/**
 * The first element under `node` with the class `cls`, in document order, or null.
 * @param {Node | null} node
 * @param {string} cls
 * @returns {Node | null}
 */
function firstByClass(node, cls) {
	if (!node) return null;
	for (const c of node.children) {
		if (typeof c === 'string') continue;
		if (c.classes.includes(cls)) return c;
		const deeper = firstByClass(c, cls);
		if (deeper) return deeper;
	}
	return null;
}

/**
 * The text a reader sees: tags dropped, entities decoded, runs of whitespace folded to one space, and <br>
 * kept as a line break.
 * @param {Node | null} node
 * @returns {string}
 */
function textOf(node) {
	if (!node) return '';
	const parts = [];
	const walk = (n) => {
		for (const c of n.children) {
			if (typeof c === 'string') parts.push(decodeEntities(c).replace(/\s+/g, ' '));
			else if (c.tag === 'br') parts.push('\n');
			else walk(c);
		}
	};
	walk(node);
	return parts
		.join('')
		.replace(/\xa0/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/ {2,}/g, ' ')
		.trim();
}

/** The whole number in `text` with its thousands separators dropped ("L$ 6,000,000" → 6000000), or null. */
function numberIn(text) {
	const m = /\d[\d,.\xa0 ]*/.exec(text);
	if (!m) return null;
	const n = Number(m[0].replace(/[,.\xa0 ]/g, ''));
	return Number.isSafeInteger(n) ? n : null;
}

/** `href` made absolute against `base`, or null when it is missing or unusable. */
function absolute(href, base) {
	if (!href) return null;
	try {
		const url = new URL(href, base);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch (e) {
		return null;
	}
}

/**
 * @typedef {object} Contract
 * @property {string} name the target's name on the board
 * @property {string} code the bounty's code, e.g. "BH-003170"
 * @property {number | null} member the target's Bondage Club member number
 * @property {number | null} reward the bounty in credits
 * @property {number} bonus extra credits the target added themselves, 0 when none
 * @property {string} terms the condition on that bonus, e.g. "taunted — alive only"; '' when none
 * @property {string} quote the target's one-liner, without its quote marks; '' when none
 * @property {string} notes the target's own wants and limits, line breaks kept; '' when none
 * @property {string} postedBy who posted the bounty
 * @property {string} hunter the hunter who claimed it; '' when unclaimed
 * @property {string} status 'open', 'hunted' (claimed and running), or the page's own word for anything else
 * @property {'live' | 'known' | null} tracking 'live' when the prison's bot sees the target online now,
 *   'known' when the target friended the bot, null otherwise
 * @property {string | null} url the target's prison file, when the card links one
 * @property {string | null} photo the card's photo
 */

/**
 * @typedef {object} Wanted
 * @property {string} name
 * @property {string} code the prison number, e.g. "VOP-000408"
 * @property {string} threat e.g. "CRITICAL", "HIGH"; '' when not shown
 * @property {string | null} lastSeen the room they were last seen in, null when nobody has reported a sighting
 * @property {number | null} escaped days since the escape
 * @property {number} sightings sightings reported so far
 * @property {number | null} bounty the prison's bounty in L$
 * @property {string | null} url the inmate's dossier
 */

/**
 * @typedef {object} HuntBoard
 * @property {boolean} ok true when the page looked as expected and every card and row read cleanly
 * @property {string[]} problems what did not look as expected; empty when ok
 * @property {Contract[]} contracts this page's bounty cards
 * @property {Wanted[]} wanted escaped inmates; the page lists only the first few of `totals.wanted`
 * @property {Wanted[]} debtors inmates who owe the prison's casino; the first few of `totals.debtors`
 * @property {{ n: number, of: number } | null} page which page of the board this is
 * @property {string[]} pages the addresses of the board's other pages (see huntBoardPages)
 * @property {{ board: number | null, open: number | null, hunted: number | null, wanted: number | null, debtors: number | null }} totals
 *   the page's own counts: bounties on the board across all its pages, open ones, ones being hunted,
 *   and the full length of each wanted list
 */

/** Reads one bounty card; anything missing that should be there goes into `problems`. */
function readCard(card, index, base, problems) {
	const label = card.attrs.id || `card ${index + 1}`;
	const codeBox = firstByClass(card, 'hb-code');
	const code = (/\bBH-\d+\b/.exec(card.attrs.id || '') || /\bBH-\d+\b/.exec(textOf(codeBox)) || [''])[0];
	const name = textOf(firstByClass(card, 'hb-name'));
	const memberMatch = /#\s*(\d+)/.exec(textOf(firstByClass(card, 'hb-member')));
	const member = memberMatch ? Number(memberMatch[1]) : null;
	const amount = firstByClass(card, 'hb-amount');
	const reward = amount ? numberIn(textOf(amount)) : null;
	const taunt = firstByClass(card, 'hb-taunt');
	const bonus = taunt ? (numberIn(textOf(firstByClass(taunt, 'hb-taunt-amt'))) ?? 0) : 0;
	const terms = taunt ? textOf(firstByClass(taunt, 'hb-taunt-label')) : '';
	const quote = textOf(firstByClass(card, 'hb-tagline'))
		.replace(/^["“”«»„]\s*/, '')
		.replace(/\s*["“”«»„]$/, '');
	const notes = textOf(firstByClass(card, 'hb-reason'));
	const metaText = textOf(firstByClass(card, 'hb-meta'));
	const postedBy = (/Posted by\s+([^\n]+)/.exec(metaText) || ['', ''])[1].trim();
	const hunter = (/Hunter:\s*([^\n]+)/.exec(metaText) || ['', ''])[1].trim();
	const badge = firstByClass(card, 'hb-badge');
	const badgeKind = badge ? (badge.classes.find((c) => c.startsWith('hb-badge-')) || '').slice('hb-badge-'.length) : '';
	const status = badgeKind || (badge ? textOf(badge).toLowerCase() : '');
	const track = firstByClass(card, 'hb-track');
	let tracking = null;
	if (track) {
		if (hasClass(track, 'hb-track-live')) tracking = 'live';
		else if (hasClass(track, 'hb-track-known')) tracking = 'known';
		else problems.push(`${label}: unknown tracking state "${track.attrs.class}"`);
	}
	const fileLink = codeBox ? findAll(codeBox, (n) => n.tag === 'a' && n.attrs.href)[0] : null;
	const photo = firstByClass(card, 'hb-photo-main');

	const missing = [];
	if (!code) missing.push('code');
	if (!name) missing.push('name');
	if (member === null) missing.push('member number');
	if (reward === null) missing.push('reward');
	if (!postedBy) missing.push('poster');
	if (!status) missing.push('status');
	if (missing.length) problems.push(`${label}: no ${missing.join(', ')}`);
	if (!code || !name) return null;
	return {
		name,
		code,
		member,
		reward,
		bonus,
		terms,
		quote,
		notes,
		postedBy,
		hunter,
		status,
		tracking,
		url: absolute(fileLink?.attrs.href, base),
		photo: absolute(photo?.attrs.src, base),
	};
}

/** Reads one row of a wanted list; anything missing that should be there goes into `problems`. */
function readWanted(row, list, base, problems) {
	const nameLink = firstByClass(row, 'hb-mw-name');
	const name = textOf(nameLink);
	const code = textOf(firstByClass(row, 'hb-mw-code'));
	const threat = textOf(firstByClass(row, 'hb-mw-threat')).toUpperCase();
	const sub = firstByClass(row, 'hb-mw-sub');
	const subText = textOf(sub);
	const seen = sub ? findAll(sub, (n) => n.tag === 'em')[0] : null;
	let escaped = null;
	const days = /escaped\s+(\d+)\s+days?\s+ago/i.exec(subText);
	if (days) escaped = Number(days[1]);
	else if (/escaped\s+(today|just now|\d+\s+(hours?|minutes?|seconds?)\s+ago)/i.test(subText)) escaped = 0;
	else if (/escaped\s+yesterday/i.test(subText)) escaped = 1;
	const sighted = /(\d[\d,]*)\s+sightings?/i.exec(subText);
	const bounty = numberIn(textOf(firstByClass(row, 'hb-mw-money')));

	const missing = [];
	if (!name) missing.push('name');
	if (!/^VOP-\d+$/.test(code)) missing.push('prison number');
	if (escaped === null) missing.push('escape date');
	if (!sighted && !/no sightings/i.test(subText)) missing.push('sightings');
	if (bounty === null) missing.push('bounty');
	if (missing.length) problems.push(`${list} ${code || name || '?'}: no ${missing.join(', ')}`);
	if (!name || !code) return null;
	return {
		name,
		code,
		threat,
		lastSeen: seen ? textOf(seen) : null,
		escaped,
		sightings: sighted ? Number(sighted[1].replace(/,/g, '')) : 0,
		bounty,
		url: absolute(nameLink?.attrs.href, base),
	};
}

/**
 * The part of the page that holds the board, from its .hb-page wrapper to the site footer; the whole
 * page when either end can't be found. Keeps the site's stylesheet and scripts out of the tree.
 */
function boardRegion(html) {
	const start = html.search(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bhb-page\b/i);
	if (start < 0) return html;
	const end = html.slice(start).search(/<footer\b/i);
	return end < 0 ? html.slice(start) : html.slice(start, start + end);
}

/** The other pages' addresses from the pager; see huntBoardPages. */
function readPager(root, page, base) {
	const pager = firstByClass(root, 'hb-pager');
	if (!pager) return [];
	/** @type {Map<number, string>} page number → address */
	const found = new Map();
	let pattern = null;
	let here = page ? page.n : null;
	for (const a of findAll(pager, (n) => n.tag === 'a' && n.attrs.href)) {
		const href = absolute(a.attrs.href, base);
		if (!href) continue;
		const p = new URL(href).searchParams.get('p');
		const n = p === null ? 1 : Number(p);
		if (!Number.isInteger(n) || n < 1) continue;
		if (p !== null) pattern = href;
		if (a.attrs['aria-current'] === 'page' && here === null) here = n;
		if (!found.has(n)) found.set(n, href);
	}
	if (pattern && page) {
		for (let n = 1; n <= Math.min(page.of, MAX_PAGES + 1); n++) {
			if (found.has(n)) continue;
			const url = new URL(pattern);
			url.searchParams.set('p', String(n));
			found.set(n, url.href);
		}
	}
	return [...found]
		.filter(([n]) => n !== here && (!page || n <= page.of))
		.sort((x, y) => x[0] - y[0])
		.slice(0, MAX_PAGES)
		.map(([, url]) => url);
}

/**
 * Reads one page of the hunt board. Never throws: a page that no longer looks like the board gives
 * ok:false with what was wrong in `problems`, along with whatever could still be read.
 * @param {string} html the page as served
 * @param {string} [base] the page's address, for resolving its links
 * @returns {HuntBoard}
 */
export function parseHuntBoard(html, base = HUNT_BOARD_URL) {
	const result = {
		ok: false,
		problems: [],
		contracts: [],
		wanted: [],
		debtors: [],
		page: null,
		pages: [],
		totals: { board: null, open: null, hunted: null, wanted: null, debtors: null },
	};
	const { problems, totals } = result;
	try {
		if (typeof html !== 'string' || !html.trim()) {
			problems.push('the page is empty');
			return result;
		}
		const region = boardRegion(html);
		const root = buildTree(region);

		const stats = firstByClass(root, 'hb-top-nums');
		for (const num of stats ? byClass(stats, 'hb-num') : []) {
			const t = textOf(num);
			if (/\bopen\b/i.test(t)) totals.open = numberIn(t);
			else if (/being hunted/i.test(t)) totals.hunted = numberIn(t);
		}
		if (totals.open === null) problems.push('no count of open bounties at the top of the page');

		const showing = /Showing\s+([\d,]+)\s+of\s+([\d,]+)/i.exec(region);
		const pageOf = /\bpage\s+(\d+)\s+of\s+(\d+)/i.exec(region);
		if (showing) totals.board = Number(showing[2].replace(/,/g, ''));
		if (pageOf) result.page = { n: Number(pageOf[1]), of: Number(pageOf[2]) };
		else if (showing) result.page = { n: 1, of: 1 };

		const grid = firstByClass(root, 'hb-grid');
		if (!grid) {
			problems.push('no bounty grid (.hb-grid) on the page');
		} else {
			const cards = byClass(grid, 'hb-card');
			cards.forEach((card, i) => {
				const c = readCard(card, i, base, problems);
				if (c) result.contracts.push(c);
			});
			if (showing) {
				const shown = Number(showing[1].replace(/,/g, ''));
				if (cards.length !== shown) problems.push(`the board says it shows ${shown} bounties but has ${cards.length} cards`);
			} else if (!cards.length) {
				problems.push('no bounty cards (.hb-card) and no "Showing N of M" line');
			}
		}

		const sections = byClass(root, 'hb-mw');
		if (!sections.length) problems.push('no most wanted section (.hb-mw)');
		for (const sec of sections) {
			const debtor = hasClass(sec, 'is-debtor') || /debtor/i.test(`${sec.attrs['data-sec'] || ''} ${sec.attrs.id || ''}`);
			const list = debtor ? 'debtors' : 'wanted';
			const total = numberIn(textOf(firstByClass(firstByClass(sec, 'hb-mw-head'), 'hb-mw-n')));
			if (total !== null) totals[list] = total;
			const rows = byClass(sec, 'hb-mw-row');
			if (!rows.length && total) problems.push(`the ${list} list says ${total} but shows nobody`);
			for (const row of rows) {
				const w = readWanted(row, list, base, problems);
				if (w) result[list].push(w);
			}
		}
		if (sections.length && !result.wanted.length && totals.wanted === null) problems.push('no most wanted list among the .hb-mw sections');

		result.pages = readPager(root, result.page, base);
	} catch (e) {
		problems.push(`the page could not be read: ${e && e.message ? e.message : e}`);
	}
	result.ok = problems.length === 0;
	return result;
}

/**
 * The addresses of the board's other pages, from its pager, for the caller to fetch and parse in turn.
 * When the page says "page N of M" and the pager skips numbers, the missing ones follow the pager's own
 * link pattern (its `p` parameter). The page itself is left out, and there are never more than 20.
 * parseHuntBoard returns the same list as `pages`.
 * @param {string} html one page of the board
 * @param {string} [base] that page's address
 * @returns {string[]}
 */
export function huntBoardPages(html, base = HUNT_BOARD_URL) {
	try {
		if (typeof html !== 'string') return [];
		const region = boardRegion(html);
		const pageOf = /\bpage\s+(\d+)\s+of\s+(\d+)/i.exec(region);
		return readPager(buildTree(region), pageOf ? { n: Number(pageOf[1]), of: Number(pageOf[2]) } : null, base);
	} catch (e) {
		return [];
	}
}
