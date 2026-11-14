// The Holy Order of Void's own bounties: the responses of the Order's bounty form, read from the sheet's CSV export.
// The sheet is the live list: a solved or expired bounty is deleted from it. Only bounties with a member number are
// kept, and those past their own expiry date are dropped.
//
// A bounty, as the rest of the server and the add-on see it:
//   { key, at, name, member, look, reason, instructions, reward, where, expires, personality }
//   key: "<timestamp>|<member>", which stays the same while the row does (an admin hides a bounty by it);
//   at: when it was posted (ms); expires: the expiry date as written ('' when none); the rest as written.

/** The sheet's CSV, from Google's export (no sign-in; the sheet is shared by link). */
export const ORDER_SHEET_CSV =
	'https://docs.google.com/spreadsheets/d/19eq7dr41zMscup37ZYfNN4lOj-Cv-I_Fij3Q915i3-g/gviz/tq?tqx=out:csv&gid=1936693479';

/** The most bounties kept, and the longest any text in one may be. */
const MOST = 1000;
const TEXT = 400;

/**
 * Which column holds what, found by words in the form's questions (the export can drop empty columns, so never by
 * position).
 */
const COLUMNS = {
	at: /^timestamp$/i,
	name: /their name/i,
	look: /looked like|description of what/i,
	reason: /reason/i,
	instructions: /instructions/i,
	reward: /reward/i,
	where: /where to put/i,
	expires: /expiration/i,
	member: /member id/i,
	personality: /personality/i,
};

/**
 * The rows of a CSV text: quoted fields may hold commas, quotes ("") and line breaks.
 * @param {string} text
 * @returns {string[][]}
 */
export function csvRows(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
			} else {
				field += c;
			}
		} else if (c === '"') {
			quoted = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') {
				i++;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += c;
		}
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** A date as the sheet writes one ("8/8/2025 14:06:29", "12/31/2026", "2026-12-31"), in ms; NaN when it isn't one. */
export function sheetDate(/** @type {string} */ s) {
	const us = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s || '');
	if (us) {
		return Date.UTC(+us[3], +us[1] - 1, +us[2], +(us[4] || 0), +(us[5] || 0), +(us[6] || 0));
	}
	const iso = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
	return iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : NaN;
}

const clip = (/** @type {string} */ s) =>
	String(s || '')
		.trim()
		.slice(0, TEXT);

/**
 * The live bounties in the sheet's CSV: those with a member number, not past their expiry date (a date that can't be
 * read keeps the bounty), newest first. Problems are listed instead of thrown.
 * @param {string} text
 * @param {number} [now]
 * @returns {{ bounties: any[], problems: string[] }}
 */
export function parseOrderSheet(text, now = Date.now()) {
	const problems = [];
	const rows = typeof text === 'string' ? csvRows(text) : [];
	if (!rows.length) {
		return { bounties: [], problems: ['the sheet is empty'] };
	}
	const head = rows[0].map((h) => h.trim());
	/** @type {Record<string, number>} */
	const col = {};
	for (const [k, re] of Object.entries(COLUMNS)) {
		col[k] = head.findIndex((h) => re.test(h));
	}
	for (const k of ['at', 'name', 'member']) {
		if (col[k] < 0) {
			problems.push(`no "${k}" column`);
		}
	}
	if (problems.length) {
		return { bounties: [], problems };
	}
	const get = (/** @type {string[]} */ r, /** @type {string} */ k) => (col[k] >= 0 ? r[col[k]] || '' : '');
	const bounties = [];
	for (const r of rows.slice(1)) {
		const digits = /^\s*#?(\d{1,9})\s*$/.exec(get(r, 'member'));
		const member = digits ? Number(digits[1]) : 0;
		if (!member) {
			continue;
		}
		const expires = clip(get(r, 'expires'));
		const end = sheetDate(expires);
		// An expiry date is the end of that day.
		if (Number.isFinite(end) && end + 86400000 <= now) {
			continue;
		}
		const stamp = get(r, 'at').trim();
		bounties.push({
			key: `${stamp}|${member}`,
			at: sheetDate(stamp) || 0,
			name: clip(get(r, 'name')),
			member,
			look: clip(get(r, 'look')),
			reason: clip(get(r, 'reason')),
			instructions: clip(get(r, 'instructions')),
			reward: clip(get(r, 'reward')),
			where: clip(get(r, 'where')),
			expires,
			personality: clip(get(r, 'personality')),
		});
	}
	bounties.sort((a, b) => b.at - a.at);
	return { bounties: bounties.slice(0, MOST), problems };
}
