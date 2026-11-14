/**
 * Personal badges: a picture of a member's own, shown instead of the plain Void mark over them in rooms and on their
 * ID card. The pictures are bundled with the add-on (assets/badges/<id>-160.png and -48.png, listed in index.json);
 * the Founder and admins give one to a member, or take it back. A badge's `member` in the index is who has it until
 * someone sets theirs (the first one is the app admin's own).
 */
import BADGES from '../../assets/badges/index.json';

const IDS = BADGES.map((b) => b.id);

/** The badge member m shows: the one set for them, or the index's default for them, or ''. */
export function badgeOf(m) {
	if (typeof m.badge === 'string') {
		return IDS.includes(m.badge) ? m.badge : '';
	}
	const own = BADGES.find((b) => b.member === m.n);
	return own ? own.id : '';
}

/** Gives a member a badge or takes it back: { member, badge } ('' for none). The Founder and admins, over the member. */
export async function setBadge(order, ws, me, p) {
	const m = order.target(ws, p);
	if (!m) {
		return;
	}
	if (!order.topOver(me, m.n)) {
		return order.no(ws, 'only the Founder and admins give badges', p);
	}
	const badge = typeof p.badge === 'string' ? p.badge : '';
	if (badge && !IDS.includes(badge)) {
		return order.no(ws, 'no such badge', p);
	}
	m.badge = badge;
	await order.putMember(m.n);
	const name = badge ? BADGES.find((b) => b.id === badge).name : '';
	await order.note(
		me,
		badge
			? `${order.nameOf(me)} gave ${order.nameOf(m.n)} the ${name} badge`
			: `${order.nameOf(me)} took ${order.nameOf(m.n)}'s badge back`,
	);
	order.ok(ws, p);
	order.broadcast();
}
