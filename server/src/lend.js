/**
 * Queen's Wrath, the app admin's own scythe: only she wields it, unless she lends it. The lend is recorded here, from
 * her own signed-in session, so nobody can claim one: { to, at } in storage 'lend', and every client's state carries
 * `lent` (the member it is lent to, or 0). She recalls it to end the lend.
 */

/** Loads the lend into the Order (from the constructor). */
export async function loadLend(order) {
	order.lend = (await order.ctx.storage.get('lend')) || null;
}

/** Who Queen's Wrath is lent to, or 0. */
export const lentTo = (order) => (order.lend && order.lend.to) || 0;

/** Lends Queen's Wrath: { member }. The app admin only, to someone else. */
export async function lend(order, ws, me, p) {
	if (me !== order.appAdmin) {
		return order.no(ws, "only Queen's Wrath's owner lends it", p);
	}
	if (!Number.isInteger(p.member) || p.member <= 0 || p.member === me) {
		return order.no(ws, 'lend it to someone else', p);
	}
	order.lend = { to: p.member, at: Date.now() };
	await order.ctx.storage.put('lend', order.lend);
	order.ok(ws, p);
	order.broadcast();
}

/** Ends the lend. The app admin only. */
export async function recall(order, ws, me, p) {
	if (me !== order.appAdmin) {
		return order.no(ws, "only Queen's Wrath's owner recalls it", p);
	}
	order.lend = null;
	await order.ctx.storage.delete('lend');
	order.ok(ws, p);
	order.broadcast();
}
