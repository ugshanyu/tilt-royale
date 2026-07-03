/**
 * Tilt Royale — keyboard (+ pointer-drag) fallback so desktop dev and
 * no-sensor devices still play well.
 *
 * WASD/arrows produce a SYNTHETIC TILT, not a binary D-pad: the vector ramps
 * toward the pressed direction (exponential lerp) so movement has the same
 * analog ease-in feel as a real tilt — and the same wire shape (mx/my in
 * [-1,1]), which keeps server-side physics identical for every input source.
 *
 * Pointer drag (touch devices without motion permission): dragging from the
 * press origin maps to a virtual tilt. Tap-without-drag is a FIRE and is
 * handled by the scene, not here.
 */
const RAMP_TAU_MS = 90;   // ~63% of target in 90 ms — snappy but not binary
const DRAG_FULL_PX = 120; // drag distance for full tilt

export function createKeyboard({ onFire } = {}) {
  const keys = new Set();
  let cur = { x: 0, y: 0 };
  let drag = null;          // {x0,y0,dx,dy} virtual-tilt drag state
  let anyKeyAt = 0;

  const KEYMAP = {
    KeyW: [0, -1], ArrowUp: [0, -1],
    KeyS: [0, 1], ArrowDown: [0, 1],
    KeyA: [-1, 0], ArrowLeft: [-1, 0],
    KeyD: [1, 0], ArrowRight: [1, 0],
  };

  function target() {
    let tx = 0;
    let ty = 0;
    for (const code of keys) {
      const v = KEYMAP[code];
      if (v) { tx += v[0]; ty += v[1]; }
    }
    const m = Math.hypot(tx, ty);
    return m > 1 ? { x: tx / m, y: ty / m } : { x: tx, y: ty };
  }

  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code]) { keys.add(e.code); anyKeyAt = Date.now(); e.preventDefault(); }
    if (e.code === 'Space' && !e.repeat) { if (onFire) onFire(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.code); });
  window.addEventListener('blur', () => keys.clear());

  return {
    /**
     * Advance the ramp and return the synthetic tilt. Call once per frame.
     * @param {number} dtMs
     * @returns {{mx:number,my:number,active:boolean}}
     */
    tick(dtMs) {
      let t;
      if (drag) {
        t = {
          x: Math.max(-1, Math.min(1, drag.dx / DRAG_FULL_PX)),
          y: Math.max(-1, Math.min(1, drag.dy / DRAG_FULL_PX)),
        };
      } else {
        t = target();
      }
      const k = 1 - Math.exp(-dtMs / RAMP_TAU_MS);
      cur = { x: cur.x + (t.x - cur.x) * k, y: cur.y + (t.y - cur.y) * k };
      const active = keys.size > 0 || !!drag ||
        Math.hypot(cur.x, cur.y) > 0.02 ||       // still coasting down
        Date.now() - anyKeyAt < 250;
      return { mx: cur.x, my: cur.y, active };
    },

    /** Scene feeds pointer-drag when tilt is unavailable. */
    dragStart(x, y) { drag = { x0: x, y0: y, dx: 0, dy: 0 }; },
    dragMove(x, y) { if (drag) { drag.dx = x - drag.x0; drag.dy = y - drag.y0; } },
    dragEnd() { drag = null; },
    isDragging: () => !!drag,
  };
}
