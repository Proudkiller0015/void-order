/**
 * The API of the Order's Discord bot (Oculus Nihili, which runs on the app admin's PC). It POSTs JSON to /bot, signed with
 * its own P-256 key (the header X-Void-Bot-Sig, base64url r||s over the body); the Order knows its public key from
 * VOID_BOT_KEY ("x.y", base64url). Without that variable nothing answers. Each body carries `ts` (ms) and a random
 * `id`: a body older than BOT_SKEW, or an id seen before, is turned away.
 *
 * Requests ({ t, ... }):
 *   members       the ranks and every member: { ranks, founder, members: [{ n, name, rank, places, bio }] }
 *   rank          { member, rank, by }: gives a member one of the Order's ranks (the bot decides who may)
 *   places        { member, places: [{ b, t, c }], by }: sets every branch the member holds (main first, at most two;
 *                 [] = none), with the same rules as placing them in Oculus Nihili
 *   founder       { member, name, by }: makes them the Founder, bringing them in under `name` if needed (they need
 *                 not use the add-on)
 *   links         { members: [n] }: the members linked to a Discord account; their rank comes from Discord
 *                 (Oculus Nihili shows it, and the Founder and admins don't set it there)
 */

const BOT_SKEW = 2 * 60 * 1000;

/** Loads the linked members into the Order (from the constructor). */
export async function loadBotLinks(order) {
	order.dlinked = new Set((await order.ctx.storage.get('dlinked')) || []);
	order.botSeen = new Map();
}

/** Whether member n's rank comes from Discord. */
export const rankFromDiscord = (order, n) => !!order.dlinked && order.dlinked.has(n);

/** The bot's public key from VOID_BOT_KEY, or null. */
export function botKey(env) {
	const [x, y] = String(env.VOID_BOT_KEY || '').trim().split('.');
	return x && y && /^[A-Za-z0-9_-]{43}$/.test(x) && /^[A-Za-z0-9_-]{43}$/.test(y) ? { x, y } : null;
}

/** Answers one request from the bot. `body` is the signed text, already verified by the Worker. */
export async function botCall(order, body) {
	let p;
	try {
		p = JSON.parse(body);
	} catch (e) {
		return { error: 'not JSON' };
	}
	const now = Date.now();
	if (!p || typeof p.t !== 'string' || typeof p.id !== 'string' || !Number.isFinite(p.ts) || Math.abs(now - p.ts) > BOT_SKEW) {
		return { error: 'stale or bad request' };
	}
	for (const [id, at] of order.botSeen) {
		if (now - at > BOT_SKEW * 2) {
			order.botSeen.delete(id);
		}
	}
	if (order.botSeen.has(p.id)) {
		return { error: 'seen before' };
	}
	order.botSeen.set(p.id, now);

	switch (p.t) {
		case 'members':
			return {
				ranks: order.ranks,
				founder: (order.meta && order.meta.founder) || 0,
				// The branches, each rank's name and the chapters (with their own rank names), for the bot's pickers.
				structure: order.botStructure(),
				members: Object.values(order.members).map((m) => ({
					n: m.n,
					name: m.name,
					rank: m.rank || 0,
					places: m.places.map((x) => order.placeName(x, m)).filter(Boolean),
					// What they wrote on their ID card (every member can read it there).
					bio: typeof m.bio === 'string' ? m.bio : '',
					// The branches they hold as data (main first), for the bot's pickers.
					at: m.places.map((x) => ({ b: x.b, t: x.t, c: x.c || '' })),
				})),
			};
		case 'rank': {
			const m = Number.isInteger(p.member) ? order.members[p.member] : null;
			if (!m) {
				return { error: 'no such member' };
			}
			const r = p.rank;
			if (!Number.isInteger(r) || r < 0 || r >= order.ranks.length) {
				return { error: 'no such rank' };
			}
			if ((m.rank || 0) !== r) {
				if (r) {
					m.rank = r;
				} else {
					delete m.rank;
				}
				await order.putMember(m.n);
				const by = typeof p.by === 'string' ? p.by.slice(0, 60) : 'Discord';
				await order.note(0, `${order.nameOf(m.n)} is now ${order.ranks[r]} (${by}, on Discord)`);
				order.broadcast();
			}
			return { ok: true, rank: r };
		}
		case 'founder':
			return await order.botFounder(p.member, p.name, typeof p.by === 'string' ? p.by : 'Discord');
		case 'places':
			return await order.botPlaces(p.member, p.places, typeof p.by === 'string' ? p.by : 'Discord');
		case 'links': {
			const list = Array.isArray(p.members) ? p.members.filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000) : [];
			const next = new Set(list);
			const same = next.size === order.dlinked.size && [...next].every((n) => order.dlinked.has(n));
			if (!same) {
				order.dlinked = next;
				await order.ctx.storage.put('dlinked', [...next]);
				order.broadcast();
			}
			return { ok: true };
		}
	}
	return { error: 'unknown' };
}
