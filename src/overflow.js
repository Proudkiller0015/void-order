// Oculus Nihili: long weapons drawn past the edge of the character. The game draws every character into a 500 px wide
// picture, which cuts off a long rifle or a scythe. Whenever the game redraws a character holding an Armory item, the
// item's layers are drawn again, by the game's own drawing code, into a picture of their own SIDE px wider on each
// side; when the game puts the character on screen, the parts of that picture outside the game's are put beside it
// with the same transform (place, size, mirroring and height). Nothing of the game's drawing is replaced: if the game
// draws differently, the hooks find nothing they expect and long weapons are simply cut off at the edge again.
// A module of void.js's; it needs ctx.modules.guard and ctx.modules.items, and without them it stays off.
(() => {
	'use strict';
	/** @type {any} */ (window).VoidOrderModules ??= {};
	/** @type {any} */ (window).VoidOrderModules.overflow = (/** @type {any} */ ctx) => {
		const w = ctx.w;
		const FEATURE = 'Long weapons';
		const guard = ctx.modules && ctx.modules.guard;
		const items = ctx.modules && ctx.modules.items;
		if (!guard || !items) {
			console.warn('[Oculus Nihili] long weapons are off: the guard or items module did not load');
			return null;
		}
		/** How far past each side of the character's picture the Armory's layers are drawn. */
		const SIDE = 250;
		/** @type {WeakMap<any, HTMLCanvasElement>} Each character's wide picture of their Armory layers. */
		const pictures = new WeakMap();
		/** @type {any} The character the game is putting on screen right now. */
		let onScreen = null;

		function start() {
			if (!guard.gameFunction('CommonDrawAppearanceBuild') || !guard.gameFunction('DrawImageCanvas')) {
				guard.problem(FEATURE, 'the game draws characters differently now');
				return;
			}
			// WebGL draws a character's picture and its blinking one side by side (0-500, 500-1000) on one canvas, so what
			// crosses the edge of one lands in the other (a scythe's tip in the blink picture's left). Our pictures are
			// clipped to their own half; the parts past the edge are drawn by this module beside the character instead.
			if (guard.gameFunction('GLDrawImage')) {
				guard.hookGame('GLDrawImage', 0, 'Long weapons in WebGL', (args, next) => {
					const gl = args[1];
					if (!gl || typeof gl.scissor !== 'function' || !ours(args[0])) {
						return next(args);
					}
					// The two pictures each take half the canvas, whatever its width: 1000 in the game, wider when another add-on
					// (Echo) widens it and moves the character in. Clip to the half this draw is in, never to a guessed box.
					const width = (gl.canvas && gl.canvas.width) || gl.drawingBufferWidth || 1000;
					const k = (gl.drawingBufferWidth || width) / width;
					const half = width / 2;
					const start = (Number(args[5]) || 0) >= half ? half : 0;
					const was = gl.isEnabled(gl.SCISSOR_TEST);
					const box = gl.getParameter(gl.SCISSOR_BOX);
					gl.enable(gl.SCISSOR_TEST);
					gl.scissor(Math.round(start * k), 0, Math.round(half * k), gl.drawingBufferHeight);
					try {
						return next(args);
					} finally {
						if (!was) {
							gl.disable(gl.SCISSOR_TEST);
						}
						if (box && box.length === 4) {
							gl.scissor(box[0], box[1], box[2], box[3]);
						}
					}
				});
			}
			guard.hookGame('CharacterAppearanceBuildCanvas', 0, FEATURE, (args, next) => {
				const r = next(args);
				build(args[0]);
				return r;
			});
			guard.hookGame('DrawCharacter', 0, FEATURE, (args, next) => {
				const was = onScreen;
				onScreen = args[0];
				try {
					return next(args);
				} finally {
					onScreen = was;
				}
			});
			guard.hookGame('DrawImageEx', 0, FEATURE, (args, next) => {
				const c = onScreen;
				const wide = c && pictures.get(c);
				if (!wide || (args[0] !== c.Canvas && args[0] !== c.CanvasBlink)) {
					return next(args);
				}
				const r = next(args);
				paint(wide, args[1], args[2], args[3], args[4]);
				return r;
			});
		}

		/** Whether a picture the game draws is one of the Armory's (Assets/Female3DCG/ItemHandheld/[pose/]<item>_<layer>.png). */
		function ours(/** @type {any} */ src) {
			const m = typeof src === 'string' && /ItemHandheld\/(?:[A-Za-z]+\/)?([A-Za-z0-9]+?)_[^/]*\.png$/.exec(src);
			return !!m && typeof w.AssetGet === 'function' && items.isArmory(w.AssetGet('Female3DCG', 'ItemHandheld', m[1]));
		}
		/** Drawing options moved SIDE px right, with the masks the game gives (the Hand layer's among them). */
		function shifted(/** @type {any} */ opts) {
			if (!opts || typeof opts !== 'object') {
				return opts;
			}
			const out = { ...opts };
			if (Array.isArray(opts.TextureAlphaMask)) {
				out.TextureAlphaMask = opts.TextureAlphaMask.map((/** @type {any} */ m) => ({ ...m, X: m.X + SIDE }));
			}
			if (Array.isArray(opts.AlphaMasks)) {
				out.AlphaMasks = opts.AlphaMasks.map((/** @type {any} */ r) => (Array.isArray(r) ? [r[0] + SIDE, ...r.slice(1)] : r));
			}
			return out;
		}
		/** Draws a character's Armory layers into their wide picture, or forgets it when they hold no Armory item. */
		function build(/** @type {any} */ c) {
			const layers =
				c && Array.isArray(c.AppearanceLayers) ? c.AppearanceLayers.filter((/** @type {any} */ l) => items.isArmory(l.Asset)) : [];
			if (!layers.length || !c.Canvas) {
				if (c) {
					pictures.delete(c);
				}
				return;
			}
			let wide = pictures.get(c);
			if (!wide) {
				wide = document.createElement('canvas');
				pictures.set(c, wide);
			}
			wide.width = c.Canvas.width + 2 * SIDE;
			wide.height = c.Canvas.height;
			const ctx = wide.getContext('2d');
			if (!ctx) {
				return;
			}
			// The character as the game sees it, holding only the Armory's layers.
			const view = Object.create(c, { AppearanceLayers: { value: layers } });
			const draw = (/** @type {any} */ src, /** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ opts) => {
				// Marked as drawn for this character, so the game redraws them when the picture finishes loading.
				if (typeof src === 'string' && typeof w.CommonDrawMarkDrawnAsset === 'function') {
					w.CommonDrawMarkDrawnAsset(c, src);
				}
				w.DrawImageCanvas(src, ctx, x + SIDE, y, shifted(opts));
			};
			const none = () => {};
			w.CommonDrawAppearanceBuild(view, {
				clearRect: none,
				clearRectBlink: none,
				drawImage: draw,
				drawImageBlink: none,
				drawImageColorize: draw,
				drawImageColorizeBlink: none,
				drawCanvas: (
					/** @type {any} */ img,
					/** @type {number} */ x,
					/** @type {number} */ y,
					/** @type {any} */ masks,
					/** @type {any} */ maskLayers,
					/** @type {any} */ transforms,
				) => {
					if (typeof w.DrawCanvas === 'function') {
						w.DrawCanvas(
							img,
							ctx,
							x + SIDE,
							y,
							shifted({ AlphaMasks: masks ?? [] }).AlphaMasks,
							shifted({ TextureAlphaMask: maskLayers ?? [] }).TextureAlphaMask,
							transforms,
						);
					}
				},
				drawCanvasBlink: none,
			});
		}

		/**
		 * Puts the parts of a wide picture left and right of the character's picture on screen, with the transform the game
		 * used for the character: it drew `options.SourcePos` of the character's picture at (x, y), `options.Width` by
		 * `options.Height`, mirrored and/or upside down.
		 * @param {HTMLCanvasElement} wide
		 * @param {any} ctx
		 * @param {number} x
		 * @param {number} y
		 * @param {any} options
		 */
		function paint(wide, ctx, x, y, options) {
			const src = options && options.SourcePos;
			if (!ctx || typeof ctx.drawImage !== 'function' || !Array.isArray(src) || src.length !== 4 || options.Rotation) {
				return;
			}
			const [sx, sy, sw, sh] = src;
			const kx = (options.Width ?? sw) / sw;
			const ky = (options.Height ?? sh) / sh;
			if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= 0 || ky <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
				return;
			}
			const mirror = !!options.Mirror;
			const invert = !!options.Invert;
			ctx.save();
			try {
				ctx.transform(
					mirror ? -kx : kx,
					0,
					0,
					invert ? -ky : ky,
					mirror ? x + (sw + sx) * kx : x - sx * kx,
					invert ? y + (sh + sy) * ky : y - sy * ky,
				);
				ctx.beginPath();
				ctx.rect(sx - SIDE, sy, SIDE, sh);
				ctx.rect(sx + sw, sy, SIDE, sh);
				ctx.clip();
				ctx.drawImage(wide, -SIDE, 0);
			} finally {
				ctx.restore();
			}
		}

		items.whenItemsReady(start);
		return {};
	};
})();
