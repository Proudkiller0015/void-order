// src/guard.js on its own, with a stand-in for the game's mod SDK: which errors switch a feature off and which pass
// through to the game unchanged. Run: node test-guard.js (no game or browser needed).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
let passed = 0;
const check = (ok, what, got) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`);
	if (ok) passed++;
	else failed++;
};

/** A fresh game window with the guard module loaded; `game` holds the game's functions by name. */
function load(game) {
	const w = { ...game };
	// The mod SDK's hookFunction, reduced to what the guard uses: the hook gets the arguments and the game's function.
	w.bcModSdk = {
		registerMod: () => ({
			hookFunction: (name, priority, hook) => {
				const original = w[name];
				w[name] = (...args) => hook(args, (a) => original(...a));
			},
		}),
	};
	const sandbox = { window: { VoidOrderModules: {} }, console: { warn: () => {} } };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'src', 'guard.js'), 'utf8'), sandbox);
	const guard = sandbox.window.VoidOrderModules.guard({ w, VERSION: 'test' });
	return { w, guard };
}
const threw = (f) => {
	try {
		f();
		return null;
	} catch (e) {
		return e;
	}
};

// 1. Our own code throws: the feature goes, the game runs as if never hooked.
{
	const { w, guard } = load({ Draw: (x) => `drawn ${x}` });
	guard.hookGame('Draw', 0, 'Feature A', () => {
		throw new Error('ours');
	});
	check(w.Draw(1) === 'drawn 1' && !guard.working('Feature A'), 'our error switches the feature off and the game draws');
}

// 2. The game throws on its own arguments (a function of its own is missing): that error is the game's and passes
// through unchanged; the feature stays on.
{
	const { w, guard } = load({
		Draw: () => {
			throw new TypeError('BuildCanvas is not a function');
		},
	});
	guard.hookGame('Draw', 0, 'Feature B', (args, next) => next(args));
	const e = threw(() => w.Draw(1));
	check(
		e && e.message === 'BuildCanvas is not a function' && guard.working('Feature B'),
		"the game's own error passes through",
		e && e.message,
	);
}

// 3. The game throws only on what our hook handed it: the feature goes, and the game runs on its own arguments.
{
	const { w, guard } = load({
		Fetch: (url) => {
			if (/void-assets/.test(url)) throw new TypeError('address refused');
			return `fetched ${url}`;
		},
	});
	guard.hookGame('Fetch', 0, 'Feature C', (args, next) => next([`https://void-assets/${args[0]}`]));
	let out;
	const e = threw(() => (out = w.Fetch('Assets/x.png')));
	check(!e && out === 'fetched Assets/x.png', 'the game runs on its own arguments when it refuses ours', e ? e.message : out);
	check(!guard.working('Feature C'), 'and the feature that handed them is switched off');
	check(w.Fetch('Assets/y.png') === 'fetched Assets/y.png', 'from then on the game is left alone');
}

// 4. The game throws on ours and on its own: the error on its own arguments is the game's, and passes through.
{
	const { w, guard } = load({
		Fetch: () => {
			throw new TypeError('broken game');
		},
	});
	guard.hookGame('Fetch', 0, 'Feature D', (args, next) => next(['changed']));
	const e = threw(() => w.Fetch('x'));
	check(e && e.message === 'broken game', "an error the game also throws on its own arguments is still the game's", e && e.message);
}

// 5. A missing game function: nothing is hooked and the feature is off from the start.
{
	const { guard } = load({});
	check(
		guard.hookGame('Gone', 0, 'Feature E', (a, n) => n(a)) === false && !guard.working('Feature E'),
		'a missing function switches the feature off',
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
