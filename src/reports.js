// Oculus Nihili: problem reports. When one of the add-on's guarded features fails (a game function it hooks is gone,
// an item fails to register, pictures can't be reached, any error it catches), a small notice says which feature was
// switched off and offers to send a report. Nothing is sent unless the player clicks, and they see exactly what goes:
// the feature, the error, a short stack (the add-on's own files only), the add-on and game versions, the browser, the
// time and their member number. Each kind of failure shows once a session; ⚙ Settings lists them under Problems.
// The app admin reads the reports in the panel (Reports) and is told when a new kind arrives.
(window.VoidOrderModules = window.VoidOrderModules || {}).reports = (/** @type {any} */ ctx) => {
	'use strict';
	const { w, make } = ctx;
	/** Most problems kept this session, and the most stack lines sent. */
	const KEPT = 30;
	const STACK_LINES = 8;
	const CSS = `
		.void-toast.void-problem { cursor: default; width: 340px; max-width: calc(100vw - 16px); }
		.void-problem .t { margin-bottom: 8px; }
		.void-problem .row { display: flex; gap: 6px; flex-wrap: wrap; }
		.void-problem button, #void-panel .void-report-actions button { border: 1px solid #5b3d8f; border-radius: 999px; background: #ffffff0a;
			color: #e8defc; padding: 3px 11px; cursor: pointer; font: inherit; font-size: 12px; }
		.void-problem button.main { background: linear-gradient(180deg, #8a4dff, #5b2bc4); border-color: #9b6bff; color: #fff; }
		.void-problem button:hover { border-color: #b48cff; }
		.void-problem pre, #void-panel pre.void-report { white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; margin: 6px 0 8px;
			padding: 6px 8px; border-radius: 8px; background: #00000055; font: 11px/1.35 ui-monospace, Consolas, monospace; color: #d9cdf5; }
		.void-problem .said { font-size: 12px; color: #a597c4; margin-top: 6px; }
	`;
	/**
	 * The problems hit this session, by kind.
	 * @type {Map<string, { feature: string, error: string, stack: string, at: number, times: number, sent: boolean, said: string }>}
	 */
	const seen = new Map();
	/** The app admin's last list of reports from the server, or null until loaded. */
	let list = /** @type {any[] | null} */ (null);
	let loading = false;

	/** The same failure counts as one kind whatever numbers (ids, positions) its message carries. */
	const kindOf = (/** @type {string} */ feature, /** @type {string} */ error) => `${feature}|${error.replace(/\d+/g, '#')}`;
	/** The stack lines from the add-on's own files, without the page address or cache-busting query. */
	function ours(/** @type {string} */ stack) {
		return String(stack || '')
			.split('\n')
			.filter((l) => /void\.js|\/src\/[a-z-]+\.js|voidorder/i.test(l))
			.map((l) =>
				l
					.trim()
					.replace(/https?:\/\/[^\s)]*?\/(src\/[a-z-]+\.js)(\?[^\s):]*)?/gi, '$1')
					.replace(/https?:\/\/[^\s)]*?\/(void\.js)(\?[^\s):]*)?/gi, '$1'),
			)
			.slice(0, STACK_LINES)
			.join('\n');
	}
	/** What a report sends, as shown to the player before they send it. */
	function payload(/** @type {any} */ p) {
		return {
			feature: p.feature,
			error: p.error,
			stack: p.stack,
			version: ctx.VERSION,
			game: String(w.GameVersion || ''),
			ua: String(navigator.userAgent || '').slice(0, 300),
			at: p.at,
		};
	}
	function preview(/** @type {any} */ p) {
		const x = payload(p);
		const me = ctx.me();
		return [
			`Feature: ${x.feature}`,
			`Error: ${x.error}`,
			`Add-on: ${x.version}   Game: ${x.game || '?'}`,
			`Browser: ${x.ua}`,
			`Time: ${new Date(x.at).toISOString()}`,
			`Member: ${me ? `#${me}` : 'not logged in'}`,
			...(x.stack ? ['Stack:', x.stack] : []),
		].join('\n');
	}
	async function copy(/** @type {string} */ text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (e) {
			const t = document.createElement('textarea');
			t.value = text;
			document.body.append(t);
			t.select();
			const ok = document.execCommand('copy');
			t.remove();
			return ok;
		}
	}
	/** Sends one problem; answers what to tell the player, and whether to offer copying instead. */
	async function send(/** @type {any} */ p) {
		const r = await ctx.req({ t: 'report', ...payload(p) });
		if (r && r.t === 'ok') {
			p.sent = true;
			p.said = 'Sent. Thank you!';
			return { ok: true };
		}
		const why = (r && r.why) || 'no answer';
		const offline = /not connected|no answer/.test(why);
		p.said = offline ? 'The Order’s server can’t be reached: copy the report and send it to the app admin instead.' : `Not sent: ${why}.`;
		return { ok: false, offline };
	}

	/** The notice for a new kind of problem: never blocks the game, and goes away by itself. */
	function notice(/** @type {any} */ p) {
		ctx.style();
		if (!document.getElementById('void-report-style')) {
			const s = document.createElement('style');
			s.id = 'void-report-style';
			s.textContent = CSS;
			document.head.append(s);
		}
		const t = make('div', 'void-toast void-problem');
		const others = document.querySelectorAll('.void-toast').length;
		t.style.bottom = `${16 + others * 64}px`;
		t.append(make('div', 't', `Oculus Nihili: ${p.feature} switched off after a game change.`));
		const row = make('div', 'row');
		const said = make('div', 'said');
		let timer = setTimeout(() => t.remove(), 20000);
		const keep = () => clearTimeout(timer);
		const shut = () => t.remove();
		const sendBtn = make('button', 'main', 'Send report');
		sendBtn.addEventListener('click', () =>
			ctx.guard(() => {
				keep();
				// Show exactly what goes, and send only on a second click.
				const pre = make('pre', '', preview(p));
				const go = make('button', 'main', 'Send');
				const cp = make('button', '', 'Copy report');
				const no = make('button', '', 'Cancel');
				go.addEventListener('click', () =>
					ctx.guard(async () => {
						go.disabled = true;
						const r = await send(p);
						said.textContent = p.said;
						if (r.ok) {
							row.replaceChildren();
							timer = setTimeout(shut, 4000);
						} else {
							go.disabled = false;
						}
						ctx.render();
					}),
				);
				cp.addEventListener('click', () =>
					ctx.guard(async () => {
						said.textContent = (await copy(preview(p))) ? 'Copied.' : 'Couldn’t copy: select the text above.';
					}),
				);
				no.addEventListener('click', shut);
				row.replaceChildren(go, cp, no);
				t.insertBefore(pre, row);
			}),
		);
		const dismiss = make('button', '', 'Dismiss');
		dismiss.addEventListener('click', shut);
		row.append(sendBtn, dismiss);
		t.append(row, said);
		document.body.append(t);
	}

	/** Notes a feature that failed. The first of each kind this session shows the notice. */
	function report(/** @type {string} */ feature, /** @type {any} */ error, at = Date.now()) {
		const e = error && typeof error === 'object' ? error : { message: String(error) };
		const p = {
			feature: String(feature || 'Unknown feature').slice(0, 60),
			error: String(e.message || e.name || error || 'unknown error').slice(0, 300),
			stack: ours(e.stack || ''),
			at,
			times: 1,
			sent: false,
			said: '',
		};
		console.warn(`[Oculus Nihili] ${p.feature} switched off:`, error);
		const kind = kindOf(p.feature, p.error);
		const known = seen.get(kind);
		if (known) {
			known.times++;
			return;
		}
		if (seen.size >= KEPT) {
			return;
		}
		seen.set(kind, p);
		ctx.guard(() => notice(p));
		ctx.render();
	}

	// ---- ⚙ Settings › Problems: this session's problems, each sendable or copyable.
	ctx.addSettings((/** @type {HTMLElement} */ body) => {
		body.append(make('h3', '', 'Problems'));
		if (!seen.size) {
			body.append(make('p', 'dim', 'None this session. If a game update breaks part of the add-on, it is listed here.'));
			return;
		}
		for (const p of seen.values()) {
			const box = make('div', 'box');
			box.append(
				make('div', '', `${p.feature} switched off${p.times > 1 ? ` (${p.times} times)` : ''}`),
				make('div', 'dim', `${p.error} · ${new Date(p.at).toLocaleTimeString()}`),
			);
			const pre = make('pre', 'void-report', preview(p));
			const actions = make('div', 'row void-report-actions');
			if (!p.sent) {
				const go = make('button', '', 'Send report');
				go.addEventListener('click', () =>
					ctx.guard(async () => {
						go.disabled = true;
						await send(p);
						ctx.render(true);
					}),
				);
				actions.append(go);
			}
			const cp = make('button', '', 'Copy report');
			cp.addEventListener('click', () =>
				ctx.guard(async () => {
					p.said = (await copy(preview(p))) ? 'Copied.' : 'Couldn’t copy: select the text below.';
					ctx.render(true);
				}),
			);
			actions.append(cp);
			box.append(actions);
			if (p.said) {
				box.append(make('div', 'dim', p.said));
			}
			box.append(make('div', 'dim', 'What a report sends:'), pre);
			body.append(box);
		}
	});

	// ---- The app admin's Reports tab: what players sent, newest first.
	async function load() {
		if (loading) {
			return;
		}
		loading = true;
		const r = await ctx.req({ t: 'reports' });
		loading = false;
		list = r && Array.isArray(r.reports) ? r.reports : [];
		ctx.render();
	}
	ctx.addTab({
		id: 'reports',
		label: '🐞 Reports',
		admin: true,
		show: () => ctx.appAdmin(),
		draw: (/** @type {HTMLElement} */ body) => {
			if (!list) {
				body.append(make('p', 'dim', 'Loading the reports…'));
				ctx.guard(load);
				return;
			}
			const head = make('div', 'row');
			const again = make('button', 'b', 'Refresh');
			again.addEventListener('click', () => ctx.guard(load));
			head.append(again);
			if (list.length) {
				const clear = make('button', 'b bad', 'Clear all');
				clear.addEventListener('click', () =>
					ctx.guard(async () => {
						const r = await ctx.req({ t: 'clearreports' });
						if (r && r.t === 'ok') {
							list = [];
							ctx.render();
						}
					}),
				);
				head.append(clear);
			}
			body.append(head);
			if (!list.length) {
				body.append(make('p', 'dim', 'No reports. Players’ reports of features that broke after a game change show here, kept 30 days.'));
				return;
			}
			for (const r of list) {
				const box = make('div', 'box');
				box.append(
					make('div', '', `${r.feature}: ${r.error}`),
					make(
						'div',
						'dim',
						`${r.count} report${r.count === 1 ? '' : 's'} from ${r.players.length} player${r.players.length === 1 ? '' : 's'} · last ${new Date(r.last).toLocaleString()} · first ${new Date(r.first).toLocaleDateString()}`,
					),
					make('div', 'dim', `Add-on ${r.version || '?'} · game ${r.game || '?'} · ${r.ua || ''}`),
					make('div', 'dim', `Players: ${r.players.map((n) => `#${n}`).join(', ')}`),
				);
				if (r.stack) {
					const d = make('details');
					d.append(make('summary', 'dim', 'Stack'), make('pre', 'void-report', r.stack));
					box.append(d);
				}
				body.append(box);
			}
		},
	});
	ctx.onServer((/** @type {any} */ x) => {
		if (x.t === 'report' && x.report && ctx.appAdmin()) {
			list = null;
			ctx.toast(`🐞 New problem report: ${x.report.feature}`, () => ctx.openPanel('admin:reports'));
			ctx.render();
		}
	});

	// Take over: problems from before this loaded first, then everything from here on.
	ctx.report = report;
	for (const [feature, error, at] of ctx.early.splice(0)) {
		report(feature, error, at);
	}
	const g = ctx.modules.guard;
	if (g && typeof g.onProblem === 'function') {
		// guard.js hands over { feature, message, stack, at }.
		g.onProblem((/** @type {any} */ p) => report(p.feature, { message: p.message, stack: p.stack }, p.at));
		for (const p of g.problems && typeof g.problems.values === 'function' ? g.problems.values() : []) {
			report(p.feature, { message: p.message, stack: p.stack }, p.at);
		}
	}
	return { report, problems: () => [...seen.values()] };
};
