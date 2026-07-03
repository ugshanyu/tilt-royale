// Wire codec shared by server (encode) and client (decode) + round-trip
// tested. The direct-mode socket is JSON-only (the Usion SDK drops binary
// frames), so compactness comes from: quantized ints, slot indices instead
// of user-id strings, structure-of-arrays for dots, and delta frames vs the
// last keyframe. See PROTOCOL.md for the envelope and message catalog.

import { POS_QUANT, VEL_QUANT, ANGLE_QUANT } from './constants.js';

// ----------------------------------------------------------- quantizers ----
export const qPos = (v) => Math.round(v / POS_QUANT);
export const dqPos = (i) => i * POS_QUANT;
export const qVel = (v) => Math.round(v / VEL_QUANT);
export const dqVel = (i) => i * VEL_QUANT;
export const qAng = (v) => Math.round(v / ANGLE_QUANT);
export const dqAng = (i) => i * ANGLE_QUANT;

// ------------------------------------------------------- player bitflags ---
export const PF_ALIVE = 1;
export const PF_SHIELD = 2;   // spawn shield active
export const PF_STAGGER = 4;  // seeker-blast input freeze
export const PF_CONNECTED = 8;

// --------------------------------------------------------- event tuples ----
// events[] entries are compact arrays; first element is the code.
export const EV = {
  DOT_KILLS: 'dk',   // ['dk', slot, n, xq, yq]           n dots died near (x,y)
  DEATH: 'de',       // ['de', slot, cause, killerSlot]   cause: see DEATH_CAUSE
  WAVE: 'wv',        // ['wv', slot, xq, yq, angleq]      shockwave fired
  FIRE: 'fi',        // ['fi', slot, weapon, fireSeq]     muzzle flash (scatter/seeker)
  PICKUP: 'pk',      // ['pk', slot, orbType]
  COMBO: 'cb',       // ['cb', slot, chain]               chain milestone (>= 5)
  TELEGRAPH: 'tg',   // ['tg', xq, yq]                    dot spawn ghost (client renders 1s)
  STAGGER: 'st',     // ['st', slot]
  KNOCKBACK: 'kb',   // ['kb', slot]
};
export const DEATH_CAUSE = { DOT: 0, WAVE: 1, PELLET: 2, MISSILE: 3 };
export const DEATH_CAUSE_NAMES = ['dot', 'wave', 'pellet', 'missile'];

// -------------------------------------------------------------- players ----
// Row: [slot, xq, yq, vxq, vyq, angleq, flags, weapon, ammo, score, chain]
export function encodePlayerRow(p) {
  let flags = 0;
  if (p.alive) flags |= PF_ALIVE;
  if (p.shield) flags |= PF_SHIELD;
  if (p.stagger) flags |= PF_STAGGER;
  if (p.connected) flags |= PF_CONNECTED;
  return [
    p.slot, qPos(p.x), qPos(p.y), qVel(p.vx), qVel(p.vy), qAng(p.angle),
    flags, p.weapon, p.ammo, p.score, p.chain,
  ];
}

export function decodePlayerRow(r) {
  return {
    slot: r[0],
    x: dqPos(r[1]), y: dqPos(r[2]),
    vx: dqVel(r[3]), vy: dqVel(r[4]),
    angle: dqAng(r[5]),
    alive: !!(r[6] & PF_ALIVE),
    shield: !!(r[6] & PF_SHIELD),
    stagger: !!(r[6] & PF_STAGGER),
    connected: !!(r[6] & PF_CONNECTED),
    weapon: r[7], ammo: r[8], score: r[9], chain: r[10],
  };
}

// ----------------------------------------------------------------- dots ----
// Keyframe: {ids:[...], xs:[...], ys:[...]}  — parallel arrays SORTED BY ID.
// Delta:    {rm:[ids], add:[[id,xq,yq],...], xs:[...], ys:[...]}
//   Receiver applies rm/add to its id-sorted list first; xs/ys then cover ALL
//   alive dots in id order — per-dot ids are paid only on spawn and keyframes.
export function encodeDotsKeyframe(dots /* id-sorted [{id,x,y}] */) {
  const ids = new Array(dots.length);
  const xs = new Array(dots.length);
  const ys = new Array(dots.length);
  for (let i = 0; i < dots.length; i++) {
    ids[i] = dots[i].id; xs[i] = qPos(dots[i].x); ys[i] = qPos(dots[i].y);
  }
  return { ids, xs, ys };
}

export function decodeDotsKeyframe(k) {
  const out = new Array(k.ids.length);
  for (let i = 0; i < k.ids.length; i++) {
    out[i] = { id: k.ids[i], x: dqPos(k.xs[i]), y: dqPos(k.ys[i]) };
  }
  return out; // id-sorted
}

export function encodeDotsDelta(dots /* id-sorted */, removedIds, added /* [{id,x,y}] */, includePositions = true) {
  const d = {
    rm: removedIds,
    add: added.map((a) => [a.id, qPos(a.x), qPos(a.y)]),
  };
  if (includePositions) {
    const xs = new Array(dots.length);
    const ys = new Array(dots.length);
    for (let i = 0; i < dots.length; i++) { xs[i] = qPos(dots[i].x); ys[i] = qPos(dots[i].y); }
    d.xs = xs; d.ys = ys;
  }
  return d;
}

/** Mutates `list` (id-sorted [{id,x,y}]) in place per the delta. */
export function applyDotsDelta(list, d) {
  if (d.rm && d.rm.length) {
    const rm = new Set(d.rm);
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!rm.has(list[i].id)) list[w++] = list[i];
    list.length = w;
  }
  if (d.add && d.add.length) {
    for (const [id, xq2, yq2] of d.add) list.push({ id, x: dqPos(xq2), y: dqPos(yq2) });
    list.sort((a, b) => a.id - b.id); // ids are monotonic; adds are usually tail appends
  }
  if (d.xs) {
    for (let i = 0; i < list.length; i++) { list[i].x = dqPos(d.xs[i]); list[i].y = dqPos(d.ys[i]); }
  }
  return list;
}

// ---------------------------------------------------------- projectiles ----
// Row: [id, kind, ownerSlot, xq, yq, vxq, vyq, fireSeq]  kind: 2=pellet, 3=missile
export function encodeProjRow(pr) {
  return [pr.id, pr.kind, pr.owner, qPos(pr.x), qPos(pr.y), qVel(pr.vx), qVel(pr.vy), pr.fireSeq || 0];
}
export function decodeProjRow(r) {
  return {
    id: r[0], kind: r[1], owner: r[2],
    x: dqPos(r[3]), y: dqPos(r[4]), vx: dqVel(r[5]), vy: dqVel(r[6]),
    fireSeq: r[7],
  };
}

// ----------------------------------------------------------------- orbs ----
// Full list every snapshot (<= 3 rows — cheaper than diffing).
// Row: [id, xq, yq, type]
export const encodeOrbRow = (o) => [o.id, qPos(o.x), qPos(o.y), o.type];
export const decodeOrbRow = (r) => ({ id: r[0], x: dqPos(r[1]), y: dqPos(r[2]), type: r[3] });
