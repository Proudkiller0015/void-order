// Reads the Void Order Prison's public hunt board (https://vo-p.com/hunt-board) into plain data.
// Runs in the Worker on every refresh, so it finds what it needs with plain string searches rather than
// building a tree of the whole page.

/** The board's address, and the base its relative links resolve against. */
export const HUNT_BOARD_URL = 'https://vo-p.com/hunt-board';

/** The most pages huntBoardPages hands out, whatever the page claims. */
const MAX_PAGES = 20;

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

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** @returns {Record<string, string>} the attributes in an opening tag's source, values decoded */
function parseAttrs(source) {
	const attrs = {};
	ATTR_RE.lastIndex = 0;
	let m;
	while ((m = ATTR_RE.exec(source))) {
		const name = m[1].toLowerCase();
		if (name in attrs) continue;
		const value = m[2] ?? m[3] ?? m[4] ?? '';
		attrs[name] = value.includes('&') ? decodeEntities(value) : value;
	}
	return attrs;
}

/** The class names in an opening tag's attribute source. */
function classesOf(attrSource) {
	const m = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrSource);
	return m ? (m[1] ?? m[2] ?? m[3]).trim().split(/\s+/) : [];
}

/** An opening tag, matched where it starts: group 1 is its name, group 2 its attributes. */
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/y;

/** Whether a character code can be part of a class name, so a search for "hb-mw" skips "hb-mw-row". */
const isNameChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;

/**
 * @typedef {object} Opening the opening tag of an element
 * @property {string} tag lower-case tag name
 * @property {string} attrSource its attributes, as written
 * @property {number} start where the tag starts
 * @property {number} inner where the element's content starts
 */

/**
 * The first opening tag in html[from, to) whose class attribute holds `cls`: the class name is looked for
 * as text, then checked against the tag around it. Attribute values must not contain '>'; a tag that
 * breaks that is not found, and the caller reports the piece as missing.
 * @param {string} html
 * @param {string} cls
 * @param {number} from
 * @param {number} to
 * @returns {Opening | null}
 */
function opening(html, cls, from, to) {
	const view = to < html.length ? html.slice(0, to) : html;
	let at = from;
	for (;;) {
		const hit = view.indexOf(cls, at);
		if (hit < 0) return null;
		at = hit + cls.length;
		if (isNameChar(html.charCodeAt(hit - 1)) || isNameChar(html.charCodeAt(at))) continue;
		const start = html.lastIndexOf('<', hit);
		if (start < from) continue;
		OPEN_TAG_RE.lastIndex = start;
		const m = OPEN_TAG_RE.exec(view);
		if (!m || OPEN_TAG_RE.lastIndex <= hit || !classesOf(m[2] || '').includes(cls)) continue;
		return { tag: m[1].toLowerCase(), attrSource: m[2] || '', start, inner: OPEN_TAG_RE.lastIndex };
	}
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g;

/**
 * @typedef {object} Leaf
 * @property {string} tag lower-case tag name
 * @property {string} attrSource the opening tag's attributes, as written
 * @property {string[]} classes
 * @property {string} inner the element's content, up to the first closing tag of its name
 */

/**
 * The first element with each class in `source`, found in one pass over its tags. An element's content
 * runs to the first closing tag of its name, which is right for the small pieces of a card or row (they
 * never hold an element of their own kind) and is all the parser reads.
 * @param {string} source
 * @returns {Map<string, Leaf>}
 */
function leaves(source) {
	const found = new Map();
	TAG_RE.lastIndex = 0;
	let m;
	while ((m = TAG_RE.exec(source))) {
		const attrSource = m[2];
		if (!attrSource || !attrSource.includes('class')) continue;
		const classes = classesOf(attrSource);
		let leaf = null;
		for (const c of classes) {
			if (found.has(c)) continue;
			if (!leaf) {
				const tag = m[1].toLowerCase();
				let inner = '';
				if (!VOID_TAGS.has(tag)) {
					const close = source.indexOf(`</${tag}`, TAG_RE.lastIndex);
					inner = source.slice(TAG_RE.lastIndex, close < 0 ? source.length : close);
				}
				leaf = { tag, attrSource, classes, inner };
			}
			found.set(c, leaf);
		}
	}
	return found;
}

/** The content of every element in `source` with the class `cls`, as in leaves. */
function allLeaves(source, cls) {
	const out = [];
	TAG_RE.lastIndex = 0;
	let m;
	while ((m = TAG_RE.exec(source))) {
		if (!m[2] || !m[2].includes(cls) || !classesOf(m[2]).includes(cls)) continue;
		const close = source.indexOf(`</${m[1].toLowerCase()}`, TAG_RE.lastIndex);
		out.push(source.slice(TAG_RE.lastIndex, close < 0 ? source.length : close));
	}
	return out;
}

const closeRes = new Map();

/**
 * Where the element whose content starts at `from` ends: the closing tag that balances it, counting only
 * tags of the same name. An element that is never closed runs to `to`.
 * @returns {number} the position just past its closing tag
 */
function closeOf(html, tag, from, to) {
	let re = closeRes.get(tag);
	if (!re) {
		re = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, 'gi');
		closeRes.set(tag, re);
	}
	re.lastIndex = from;
	let depth = 1;
	let m;
	while ((m = re.exec(html)) && m.index < to) {
		if (!m[1]) depth++;
		else if (--depth === 0) return re.lastIndex;
	}
	return to;
}

/**
 * @typedef {object} Block an element that holds others, as a stretch of the page's source
 * @property {string} tag
 * @property {string} attrSource
 * @property {number} start where its opening tag starts
 * @property {number} inner where its content starts
 * @property {number} end where it ends
 */

/**
 * A run of sibling elements with the class `cls` in html[from, to), such as the board's cards: each is
 * taken to end where the next one starts, and only the last is balanced to find its end.
 * @returns {Block[]}
 */
function siblings(html, cls, from, to) {
	const out = [];
	for (let o = opening(html, cls, from, to); o; o = opening(html, cls, o.inner, to)) out.push({ ...o, end: to });
	for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
	const last = out[out.length - 1];
	if (last) last.end = closeOf(html, last.tag, last.inner, to);
	return out;
}

/** The first element in html[from, to) with the class `cls`, balanced to find its end; null when there is none. */
function block(html, cls, from, to) {
	const o = opening(html, cls, from, to);
	return o ? { ...o, end: closeOf(html, o.tag, o.inner, to) } : null;
}

/**
 * The text a reader sees in a piece of HTML: tags dropped, entities decoded, runs of whitespace folded to
 * one space, and <br> kept as a line break.
 * @param {string | undefined} source
 * @returns {string}
 */
function plainText(source) {
	if (!source) return '';
	let text = source.replace(/\s+/g, ' ');
	if (text.includes('<')) {
		if (text.includes('<!--')) text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
		text = text
			.replace(/<br\b[^>]*>/gi, '\n')
			.replace(/<[^>]*>/g, '')
			.replace(/ {2,}/g, ' ');
	}
	if (text.includes('&')) text = decodeEntities(text).replace(/[ \t\r\f\v\xa0]+/g, ' ');
	if (text.includes('\n')) text = text.replace(/ *\n */g, '\n');
	return text.trim();
}

/** The text of the element with the class `cls` among `fields` (from leaves); '' when there is none. */
const textIn = (fields, cls) => plainText(fields.get(cls)?.inner);

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

/** Reads one bounty card from its source; anything missing that should be there goes into `problems`. */
function readCard(card, cardAttrs, index, base, problems) {
	const id = cardAttrs.id || '';
	const label = id || `card ${index + 1}`;
	const fields = leaves(card);
	const codeBox = fields.get('hb-code');
	const code = (/\bBH-\d+\b/.exec(id) || /\bBH-\d+\b/.exec(plainText(codeBox?.inner)) || [''])[0];
	const name = textIn(fields, 'hb-name');
	const memberMatch = /#\s*(\d+)/.exec(textIn(fields, 'hb-member'));
	const member = memberMatch ? Number(memberMatch[1]) : null;
	const amount = fields.get('hb-amount');
	const reward = amount ? numberIn(plainText(amount.inner)) : null;
	const taunted = fields.has('hb-taunt');
	const bonus = taunted ? (numberIn(textIn(fields, 'hb-taunt-amt')) ?? 0) : 0;
	const terms = taunted ? textIn(fields, 'hb-taunt-label') : '';
	const quote = textIn(fields, 'hb-tagline')
		.replace(/^["“”«»„]\s*/, '')
		.replace(/\s*["“”«»„]$/, '');
	const notes = textIn(fields, 'hb-reason');
	const metaText = textIn(fields, 'hb-meta');
	const postedBy = (/Posted by\s+([^\n]+)/.exec(metaText) || ['', ''])[1].trim();
	const hunter = (/Hunter:\s*([^\n]+)/.exec(metaText) || ['', ''])[1].trim();
	const badge = fields.get('hb-badge');
	const badgeKind = badge ? (badge.classes.find((c) => c.startsWith('hb-badge-')) || '').slice('hb-badge-'.length) : '';
	const status = badgeKind || (badge ? plainText(badge.inner).toLowerCase() : '');
	let tracking = null;
	const track = fields.get('hb-track');
	if (track) {
		const classes = track.classes;
		if (classes.includes('hb-track-live')) tracking = 'live';
		else if (classes.includes('hb-track-known')) tracking = 'known';
		else problems.push(`${label}: unknown tracking state "${classes.join(' ')}"`);
	}
	const fileLink = codeBox ? /<a\b([^>]*)>/i.exec(codeBox.inner) : null;
	const photo = fields.get('hb-photo-main');

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
		url: absolute(fileLink ? parseAttrs(fileLink[1]).href : undefined, base),
		photo: absolute(photo ? parseAttrs(photo.attrSource).src : undefined, base),
	};
}

/** Reads one row of a wanted list from its source; anything missing that should be there goes into `problems`. */
function readWanted(row, list, base, problems) {
	const fields = leaves(row);
	const nameLink = fields.get('hb-mw-name');
	const name = plainText(nameLink?.inner);
	const code = textIn(fields, 'hb-mw-code');
	const threat = textIn(fields, 'hb-mw-threat').toUpperCase();
	const sub = fields.get('hb-mw-sub');
	const subText = plainText(sub?.inner);
	const seen = sub ? /<em\b[^>]*>([\s\S]*?)<\/em>/i.exec(sub.inner) : null;
	let escaped = null;
	const days = /escaped\s+(\d+)\s+days?\s+ago/i.exec(subText);
	if (days) escaped = Number(days[1]);
	else if (/escaped\s+(today|just now|\d+\s+(hours?|minutes?|seconds?)\s+ago)/i.test(subText)) escaped = 0;
	else if (/escaped\s+yesterday/i.test(subText)) escaped = 1;
	const sighted = /(\d[\d,]*)\s+sightings?/i.exec(subText);
	const bounty = numberIn(textIn(fields, 'hb-mw-money'));

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
		lastSeen: seen ? plainText(seen[1]) : null,
		escaped,
		sightings: sighted ? Number(sighted[1].replace(/,/g, '')) : 0,
		bounty,
		url: absolute(nameLink ? parseAttrs(nameLink.attrSource).href : undefined, base),
	};
}

/**
 * The stretch of the page that holds the board, from its .hb-page wrapper to the site footer; the whole
 * page when either end can't be found. Keeps the site's stylesheet and scripts out of every search.
 * @returns {[number, number]}
 */
function boardRegion(html) {
	const page = opening(html, 'hb-page', 0, html.length);
	const start = page ? page.start : 0;
	const footer = html.indexOf('<footer', start);
	return [start, footer < 0 ? html.length : footer];
}

/** "page N of M" from the board's heading, read between `from` and `to`. */
function pageOf(html, from, to) {
	const board = html.indexOf('data-sec="board"', from);
	const at = board >= 0 && board < to ? board : from;
	const m = /\bpage\s+(\d+)\s+of\s+(\d+)/i.exec(html.slice(at, Math.min(to, at + 4000)));
	return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
}

/** The other pages' addresses from the pager; see huntBoardPages. */
function readPager(html, from, to, page, base) {
	const pager = block(html, 'hb-pager', from, to);
	if (!pager) return [];
	/** @type {Map<number, string>} page number → address */
	const found = new Map();
	let pattern = null;
	let here = page ? page.n : null;
	for (const m of html.slice(pager.inner, pager.end).matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
		const attrs = parseAttrs(m[1]);
		const href = absolute(attrs.href, base);
		if (!href) continue;
		const p = new URL(href).searchParams.get('p');
		const n = p === null ? 1 : Number(p);
		if (!Number.isInteger(n) || n < 1) continue;
		if (p !== null) pattern = href;
		if (attrs['aria-current'] === 'page' && here === null) here = n;
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
		const [from, to] = boardRegion(html);

		const stats = block(html, 'hb-top-nums', from, to);
		if (stats) {
			for (const num of allLeaves(html.slice(stats.inner, stats.end), 'hb-num')) {
				const t = plainText(num);
				if (/\bopen\b/i.test(t)) totals.open = numberIn(t);
				else if (/being hunted/i.test(t)) totals.hunted = numberIn(t);
			}
		}
		if (totals.open === null) problems.push('no count of open bounties at the top of the page');

		const grid = opening(html, 'hb-grid', from, to);
		const gridAt = grid ? grid.start : -1;
		const board = html.indexOf('data-sec="board"', from);
		const heading = html.slice(board >= 0 && board < to ? board : from, gridAt >= 0 ? gridAt : to);
		const showing = /Showing\s+([\d,]+)\s+of\s+([\d,]+)/i.exec(heading);
		if (showing) totals.board = Number(showing[2].replace(/,/g, ''));
		result.page = pageOf(html, from, to) ?? (showing ? { n: 1, of: 1 } : null);

		let boardEnd = from;
		if (gridAt < 0) {
			problems.push('no bounty grid (.hb-grid) on the page');
		} else {
			const cards = siblings(html, 'hb-card', grid.inner, to);
			cards.forEach((card, i) => {
				const c = readCard(html.slice(card.inner, card.end), parseAttrs(card.attrSource), i, base, problems);
				if (c) result.contracts.push(c);
			});
			boardEnd = cards.length ? cards[cards.length - 1].end : grid.inner;
			if (showing) {
				const shown = Number(showing[1].replace(/,/g, ''));
				if (cards.length !== shown) problems.push(`the board says it shows ${shown} bounties but has ${cards.length} cards`);
			} else if (!cards.length) {
				problems.push('no bounty cards (.hb-card) and no "Showing N of M" line');
			}
		}

		const sections = siblings(html, 'hb-mw', from, gridAt >= 0 ? gridAt : to);
		if (!sections.length) problems.push('no most wanted section (.hb-mw)');
		for (const sec of sections) {
			const secAttrs = parseAttrs(sec.attrSource);
			const debtor =
				classesOf(sec.attrSource).includes('is-debtor') || /debtor/i.test(`${secAttrs['data-sec'] || ''} ${secAttrs.id || ''}`);
			const list = debtor ? 'debtors' : 'wanted';
			const source = html.slice(sec.inner, sec.end);
			const total = numberIn(textIn(leaves(source.slice(0, Math.max(0, source.indexOf('hb-mw-row')))), 'hb-mw-n'));
			if (total !== null) totals[list] = total;
			const rows = siblings(source, 'hb-mw-row', 0, source.length);
			if (!rows.length && total) problems.push(`the ${list} list says ${total} but shows nobody`);
			for (const row of rows) {
				const w = readWanted(source.slice(row.inner, row.end), list, base, problems);
				if (w) result[list].push(w);
			}
		}
		if (sections.length && !result.wanted.length && totals.wanted === null) problems.push('no most wanted list among the .hb-mw sections');

		result.pages = readPager(html, boardEnd, to, result.page, base);
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
		const [from, to] = boardRegion(html);
		return readPager(html, from, to, pageOf(html, from, to), base);
	} catch (e) {
		return [];
	}
}
