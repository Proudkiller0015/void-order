/**
 * Bug reports from the add-on: when one of its guarded features fails in a player's game, the player may send a
 * report. Anyone signed in may send one (members and visitors alike), at most REPORTS.perHour an hour per member
 * number and per address. The same failure (feature + error) is kept once, with how many players hit it, for
 * REPORTS.days days. The app admin reads them in the panel and is told when a new kind arrives.
 *
 * Storage: 'reports' { [key]: Report } and 'reportHits' { [who]: times } (kept in storage: the object sleeps between
 * visitors, so counts in memory would reset).
 *
 * @typedef {{ key: string, feature: string, error: string, stack: string, version: string, game: string, ua: string,
 *   first: number, last: number, count: number, players: number[] }} Report `players`: the member numbers who sent it
 *   (the newest REPORTS.players), `count`: how many reports of it came in.
 */

export const REPORTS = {
	/** Reports per member number and per address an hour. */
	perHour: 5,
	/** Days a report is kept after the last one of its kind. */
	days: 30,
	/** Most kinds kept (the oldest go first). */
	kinds: 200,
	/** Member numbers kept per kind. */
	players: 100,
	/** The longest report accepted, as JSON. */
	bytes: 4000,
	/** The longest of each field. */
	len: { feature: 60, error: 300, stack: 1200, version: 40, game: 40, ua: 300 },
};

/** A text field cut to its longest, without control characters but keeping line breaks in the stack. */
const field = (v, max, lines = false) =>
	String(typeof v === 'string' ? v : '')
		.replace(lines ? /[^\S\n]+/g : /\s+/g, ' ')
		.split('')
		.filter((c) => c === '\n' || (c >= ' ' && c !== '\u007f'))
		.join('')
		.trim()
		.slice(0, max);

/** The same failure seen by different players gives the same key: numbers (ids, positions) don't count. */
export const reportKey = (feature, error) => `${feature}|${error.replace(/\d+/g, '#')}`.slice(0, 200);

/** The reports still kept, after dropping those older than REPORTS.days. */
async function kept(order) {
	/** @type {Record<string, Report>} */
	const all = (await order.ctx.storage.get('reports')) || {};
	const cutoff = Date.now() - REPORTS.days * 864e5;
	for (const [k, r] of Object.entries(all)) {
		if (r.last < cutoff) {
			delete all[k];
		}
	}
	return all;
}

/**
 * A player sends a report: { feature, error, stack, version, game, ua, at }. Answers 'ok' with `kind` true when this
 * failure wasn't known yet. The app admin, if online, gets { t: 'report', report }.
 */
export async function addReport(order, ws, a, p) {
	if (JSON.stringify(p).length > REPORTS.bytes) {
		return order.no(ws, 'report too big', p);
	}
	const feature = field(p.feature, REPORTS.len.feature);
	const error = field(p.error, REPORTS.len.error);
	if (!feature || !error) {
		return order.no(ws, 'a report needs the feature and the error', p);
	}
	const now = Date.now();
	/** @type {Record<string, number[]>} */
	const hits = (await order.ctx.storage.get('reportHits')) || {};
	for (const [who, times] of Object.entries(hits)) {
		hits[who] = times.filter((t) => now - t < 36e5);
		if (!hits[who].length) {
			delete hits[who];
		}
	}
	// A number is counted and credited only when it can't be someone else's: a member signed in with their own key, or
	// a player who isn't in the Order. A claimed member number with another key (or one brought in who hasn't joined
	// yet) counts against its address alone and names nobody.
	const status = order.statusOf(a);
	const verified = status === 'member' || status === 'guest';
	const byMember = verified ? `m${a.member}` : '';
	const byIp = `i${a.ip}`;
	if ((byMember && (hits[byMember] || []).length >= REPORTS.perHour) || (a.ip && (hits[byIp] || []).length >= REPORTS.perHour)) {
		return order.no(ws, 'too many reports, try again in an hour', p);
	}
	if (byMember) {
		hits[byMember] = [...(hits[byMember] || []), now];
	}
	if (a.ip) {
		hits[byIp] = [...(hits[byIp] || []), now];
	}
	await order.ctx.storage.put('reportHits', hits);

	const all = await kept(order);
	const key = reportKey(feature, error);
	const known = all[key];
	/** @type {Report} */
	const r = known || {
		key,
		feature,
		error,
		stack: field(p.stack, REPORTS.len.stack, true),
		version: field(p.version, REPORTS.len.version),
		game: field(p.game, REPORTS.len.game),
		ua: field(p.ua, REPORTS.len.ua),
		first: now,
		last: now,
		count: 0,
		players: [],
	};
	r.count++;
	r.last = now;
	r.version = field(p.version, REPORTS.len.version) || r.version;
	r.game = field(p.game, REPORTS.len.game) || r.game;
	if (verified && !r.players.includes(a.member)) {
		r.players = [...r.players, a.member].slice(-REPORTS.players);
	}
	all[key] = r;
	const keys = Object.keys(all).sort((x, y) => all[x].last - all[y].last);
	for (const k of keys.slice(0, Math.max(0, keys.length - REPORTS.kinds))) {
		delete all[k];
	}
	await order.ctx.storage.put('reports', all);
	order.ok(ws, p, { kind: !known });
	if (!known) {
		for (const { ws: w, a: x } of order.sockets()) {
			if (x.member === order.appAdmin && order.statusOf(x) === 'member') {
				order.send(w, { t: 'report', report: r });
			}
		}
	}
}

/** The app admin reads the reports, newest first: { t: 'reports', reports }. */
export async function listReports(order, ws, a, p) {
	if (a.member !== order.appAdmin || order.statusOf(a) !== 'member') {
		return order.no(ws, 'only the app admin reads reports', p);
	}
	const all = await kept(order);
	order.send(ws, { t: 'reports', ...(p.rid ? { rid: p.rid } : {}), reports: Object.values(all).sort((x, y) => y.last - x.last) });
}

/** The app admin clears every report. */
export async function clearReports(order, ws, a, p) {
	if (a.member !== order.appAdmin || order.statusOf(a) !== 'member') {
		return order.no(ws, 'only the app admin clears reports', p);
	}
	await order.ctx.storage.delete('reports');
	order.ok(ws, p);
}
