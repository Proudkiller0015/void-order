// Oculus Nihili: guarded hooks into the game. A feature whose hook meets a game it doesn't expect (a function missing,
// or code of ours throwing) is switched off on its own for the session, and the game's own code runs untouched.
// The first module void.js loads; the others get its API as ctx.modules.guard.
(() => {
	'use strict';
	/** @type {any} */ (window).VoidOrderModules ??= {};
	/** @type {any} */ (window).VoidOrderModules.guard = (/** @type {any} */ ctx) => {
		const w = ctx.w;
		/** @type {any} The add-on's own registration with the game's mod SDK, for the guarded hooks. */
		let mod = null;
		const gameMod = () => {
			if (!mod && w.bcModSdk && typeof w.bcModSdk.registerMod === 'function') {
				mod = w.bcModSdk.registerMod({
					name: 'VoidOrderItems',
					fullName: 'Oculus Nihili: items',
					version: ctx.VERSION,
					repository: 'https://github.com/Proudkiller0015/void-order',
				});
			}
			return mod;
		};
		/** @type {Map<string, { feature: string, message: string, stack: string, at: number }>} Features switched off this session. */
		const problems = new Map();
		/** @type {((p: { feature: string, message: string, stack: string, at: number }) => void)[]} Told when a feature is switched off. */
		const listeners = [];
		/**
		 * Switches `feature` off for the rest of the session after `error` (a message or a thrown error), warns once,
		 * keeps what a report would carry (the error and the add-on's own lines of the stack) and tells the listeners.
		 * @param {string} feature
		 * @param {any} error
		 */
		function problem(feature, error) {
			if (problems.has(feature)) {
				return;
			}
			const message = String((error && error.message) || error || 'unknown error').slice(0, 300);
			const stack = String((error && error.stack) || '')
				.split('\n')
				.filter((l) => /void[-\w]*\.js/.test(l))
				.slice(0, 6)
				.join('\n')
				.slice(0, 1200);
			const p = { feature, message, stack, at: Date.now() };
			problems.set(feature, p);
			console.warn(`[Oculus Nihili] ${feature} switched off: ${message}`);
			for (const f of listeners) {
				try {
					f(p);
				} catch (e) {
					console.warn('[Oculus Nihili] a problem listener failed:', e);
				}
			}
		}
		/** Whether `feature` is still on. */
		const working = (/** @type {string} */ feature) => !problems.has(feature);
		/** The game function at a global name or dotted path ("ElementButton.CreateForAsset"), or undefined. */
		const gameFunction = (/** @type {string} */ name) => {
			const f = name.split('.').reduce((/** @type {any} */ o, k) => (o == null ? undefined : o[k]), w);
			return typeof f === 'function' ? f : undefined;
		};
		/**
		 * Hooks a game function for one feature. While the feature works, `body` runs with the arguments and `next` (the
		 * game's function); if `body` throws, the feature is switched off and the game's function runs as if it had never
		 * been hooked. Errors thrown by the game's own function pass through unchanged. Returns false when the function
		 * isn't there, and the feature is then off.
		 * @param {string} name
		 * @param {number} priority
		 * @param {string} feature
		 * @param {(args: any[], next: (args: any[]) => any) => any} body
		 */
		function hookGame(name, priority, feature, body) {
			const handle = gameMod();
			if (!handle || !gameFunction(name)) {
				problem(feature, `the game has no ${name}`);
				return false;
			}
			/** @type {WeakSet<object>} */
			const gameErrors = new WeakSet();
			try {
				handle.hookFunction(name, priority, (/** @type {any[]} */ args, /** @type {(a: any[]) => any} */ next) => {
					if (!working(feature)) {
						return next(args);
					}
					let called = false;
					let result;
					/** Whether the game's function threw on arguments the feature changed. */
					let changedArgs = false;
					const once = (/** @type {any[]} */ a) => {
						called = true;
						try {
							result = next(a);
						} catch (e) {
							if (e && typeof e === 'object') {
								gameErrors.add(e);
							}
							changedArgs = a !== args;
							throw e;
						}
						return result;
					};
					try {
						return body(args, once);
					} catch (e) {
						if (e && typeof e === 'object' && gameErrors.has(e)) {
							if (!changedArgs) {
								throw e;
							}
							// The game's function threw on what the feature handed it: the feature goes, and the game
							// runs on its own arguments (if it throws on those too, that error is the game's own).
							problem(feature, e);
							return next(args);
						}
						problem(feature, e);
						return called ? result : next(args);
					}
				});
			} catch (e) {
				problem(feature, e);
				return false;
			}
			return true;
		}
		return {
			problem,
			problems,
			working,
			gameFunction,
			hookGame,
			/** Calls `f` with each problem from now on (the add-on's notice and report). */
			onProblem: (/** @type {(p: any) => void} */ f) => listeners.push(f),
		};
	};
})();
