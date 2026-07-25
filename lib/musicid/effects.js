/**
 * Music ID — FFmpeg-side renderer for the editor's per-layer effects.
 * CJS port of SAMPLES effects.js (schema mirrors player-lib/editor.js):
 *
 *   { type: 'uniform', opacity }
 *   { type: 'linear-gradient', angle, stop0, stop1, alpha0, alpha1 }
 *   { type: 'soft-fade', angle, alpha0, alpha1 }
 *   { type: 'radial', cx, cy, inner, outer, alpha_in, alpha_out }
 *   { type: 'wipe-split', angle, position, alpha0, alpha1 }
 *   { type: 'blend', mode, opacity }
 *
 * angle uses the CSS convention (0 = bottom→top, 90 = left→right), converted
 * here to ffmpeg image coords (Y down). Mask effects use yuva420p + geq to
 * write the alpha plane per-pixel; blend modes skip alpha and compose with
 * ffmpeg's `blend` filter instead.
 */

function clamp01(n) { n = Number(n); if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }

/**
 * Build the per-input video filter chain.
 * inLabel: e.g. "0:v"; outLabel: "v0".
 * isBack: true for the bottom layer (no alpha — would expose black underneath).
 */
function effectToFFmpeg({ inLabel, outLabel, width, height, effect, isBack = false }) {
  const lines = [];
  const W = width, H = height;
  const eff = effect || { type: 'uniform', opacity: 1 };

  const base =
    `[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS`;

  if (isBack) {
    lines.push(`${base}[${outLabel}]`);
    return lines;
  }

  if (eff.type === 'blend') {
    lines.push(`${base}[${outLabel}]`);
    return lines;
  }

  if (eff.type === 'uniform' || !eff.type) {
    const op = clamp01(eff.opacity ?? 1);
    lines.push(`${base},format=yuva420p,colorchannelmixer=aa=${op.toFixed(4)}[${outLabel}]`);
    return lines;
  }

  // Gradient effects: a `proj` expression in [0..1] gives each pixel's
  // position along the gradient axis.
  function projExpr(angleDeg) {
    const th = (angleDeg ?? 90) * Math.PI / 180;
    const dx = Math.sin(th);
    const dy = Math.cos(th);
    const dxStr = dx.toFixed(6);
    const dyStr = dy.toFixed(6);
    const lenExpr = `(abs(${dxStr})*${W}+abs(${dyStr})*${H})`;
    const minExpr = `((${dxStr}<0)*${dxStr}*${W}+(${dyStr}<0)*${dyStr}*${H})`;
    return `((${dxStr}*X+${dyStr}*Y-(${minExpr}))/(${lenExpr}))`;
  }

  let alphaExpr;

  switch (eff.type) {
    case 'linear-gradient': {
      const angle = eff.angle ?? 90;
      const a0 = clamp01(eff.alpha0 ?? 0);
      const a1 = clamp01(eff.alpha1 ?? 1);
      const s0 = clamp01(eff.stop0 ?? 0);
      const s1 = clamp01(eff.stop1 ?? 1);
      const proj = projExpr(angle);
      const span = Math.max(0.0001, s1 - s0);
      alphaExpr = `255*(${a0}+(${a1 - a0})*clip((${proj}-${s0})/${span}\\,0\\,1))`;
      break;
    }
    case 'soft-fade': {
      const angle = eff.angle ?? 90;
      const a0 = clamp01(eff.alpha0 ?? 0);
      const a1 = clamp01(eff.alpha1 ?? 1);
      const proj = projExpr(angle);
      alphaExpr = `255*(${a0}+(${a1 - a0})*${proj})`;
      break;
    }
    case 'radial': {
      const cx = clamp01(eff.cx ?? 0.5) * W;
      const cy = clamp01(eff.cy ?? 0.5) * H;
      const maxR = Math.sqrt(W * W + H * H) / 2;
      const inner = clamp01(eff.inner ?? 0.3) * maxR;
      const outer = clamp01(eff.outer ?? 0.7) * maxR;
      const aIn = clamp01(eff.alpha_in ?? 1);
      const aOut = clamp01(eff.alpha_out ?? 0);
      const span = Math.max(0.0001, outer - inner);
      const distExpr = `hypot(X-${cx.toFixed(2)}\\,Y-${cy.toFixed(2)})`;
      alphaExpr = `255*(${aIn}+(${aOut - aIn})*clip((${distExpr}-${inner.toFixed(2)})/${span.toFixed(4)}\\,0\\,1))`;
      break;
    }
    case 'wipe-split': {
      const angle = eff.angle ?? 90;
      const pos = clamp01(eff.position ?? 0.5);
      const a0 = clamp01(eff.alpha0 ?? 1);
      const a1 = clamp01(eff.alpha1 ?? 0);
      const proj = projExpr(angle);
      alphaExpr = `255*(${a0}+(${a1 - a0})*gte(${proj}\\,${pos}))`;
      break;
    }
    default:
      lines.push(`${base},format=yuva420p,colorchannelmixer=aa=1.0[${outLabel}]`);
      return lines;
  }

  lines.push(
    `${base},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alphaExpr}'[${outLabel}]`
  );
  return lines;
}

/**
 * Build the overlay (or blend) chain composing v0..v(N-1) into [vout].
 * tracks: [{ effect: { type, mode?, opacity? } }, ...]
 */
function buildOverlayChain(tracks) {
  const lines = [];
  const N = tracks.length;
  if (N === 1) {
    lines.push('[v0]copy[vout]');
    return lines;
  }
  let prev = 'v0';
  for (let i = 1; i < N; i++) {
    const out = (i === N - 1) ? 'vout' : `vmix${i}`;
    const eff = tracks[i].effect || { type: 'uniform' };
    if (eff.type === 'blend' && eff.mode) {
      const allowed = ['screen', 'multiply', 'difference', 'overlay', 'darken', 'lighten'];
      const mode = allowed.includes(eff.mode) ? eff.mode : 'screen';
      const op = clamp01(eff.opacity ?? 1);
      lines.push(`[${prev}][v${i}]blend=all_mode=${mode}:all_opacity=${op.toFixed(4)}[${out}]`);
    } else {
      lines.push(`[${prev}][v${i}]overlay=shortest=0:format=auto[${out}]`);
    }
    prev = out;
  }
  return lines;
}

module.exports = { effectToFFmpeg, buildOverlayChain, clamp01 };
