// ==UserScript==
// @name         The Void Order
// @namespace    https://github.com/Proudkiller0015/void-order
// @version      1.0.0
// @description  The Void Order's add-on for Bondage Club: orders and photo sessions, the members by branch, ID cards and Void dice. /void opens it. Always runs the newest version.
// @author       SlimeQueenSamantha
// @homepageURL  https://github.com/Proudkiller0015/void-order
// @downloadURL  https://raw.githubusercontent.com/Proudkiller0015/void-order/main/void.user.js
// @updateURL    https://raw.githubusercontent.com/Proudkiller0015/void-order/main/void.user.js
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondageprojects.elementfx.com/*
// @match        https://bondageprojects.com/*
// @match        https://www.bondageprojects.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-asia.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/*
 * The Void Order loader, like SlimeBeep's. It never needs updating: on every game load it fetches the
 * newest add-on from GitHub (void.js) and runs it, so an update reaches everybody the next time they
 * reload or log in.
 */
(function () {
	'use strict';

	const SOURCE = 'https://proudkiller0015.github.io/void-order/void.js';
	// The same file the bookmark loads. GitHub Pages may hand out a copy up to ten minutes old.
	fetch(`${SOURCE}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' })
		.then((res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		})
		.then((code) => {
			const script = document.createElement('script');
			script.textContent = `${code}
//# sourceURL=void.js`;
			document.head.appendChild(script);
			script.remove();
		})
		.catch((err) => console.warn('[Void Order] could not load:', err.message));
})();
