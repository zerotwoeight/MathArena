'use strict';

// ─── Solo mode: the boss ladder ──────────────────────────────────────────────
// Three kaiju, each a little tougher. Numbers are a starting point for playtesting.
//   hp          health bar size
//   actions     moves per boss turn
//   attackChance  chance the boss smashes a shield this turn (max one smash per turn)
//   weak        weapon that does 2 damage
//   heal        HP from a Heal move
//   raidHeal    HP from a raided build card
const BOSSES = {
  1: { level: 1, id: 'boss1', color: 'grey', name: 'Grey Kaiju', hp: 8,  actions: 1, attackChance: 0.5,  weak: 'Hammer', heal: 1, raidHeal: 2 },
  2: { level: 2, id: 'boss2', color: 'blue', name: 'Blue Kaiju', hp: 10, actions: 2, attackChance: 0.45, weak: 'Gun',    heal: 1, raidHeal: 2 },
  3: { level: 3, id: 'boss3', color: 'red',  name: 'Red Kaiju',  hp: 12, actions: 2, attackChance: 0.5,  weak: 'Sword',  heal: 1, raidHeal: 3 },
};

const bossFor = level => BOSSES[Math.min(3, Math.max(1, Number(level) || 1))];

// Picks the boss's next move: 'raid', 'heal' or 'attack'.
// One main move per turn (attack, heal or raid); Blue and Red's extra move is
// always a shop raid. Two smashes or heals a turn made the fight almost
// unwinnable in the playtest sim, even for a kid who never misses.
function chooseMove(gs, healedThisTurn, attackedThisTurn) {
  const b = gs.boss;
  const kidShields = gs.players.p1.shields.filter(s => s.active).length;

  // Kid has no shields left: go for the knockout
  if (kidShields === 0 && !attackedThisTurn) return 'attack';

  // After the main move (attack or heal), any extra move is a shop raid
  if (attackedThisTurn || healedThisTurn) return 'raid';
  const hurt = b.hp <= b.maxHp / 2;
  if (b.hp < b.maxHp && Math.random() < (hurt ? 0.3 : 0.08)) return 'heal';
  if (Math.random() < b.attackChance) return 'attack';
  return 'raid';
}

// ─── Solo mode: each kaiju sets the math ─────────────────────────────────────
// The kid's ⭐ stars only set the timer in solo. The boss decides the problems.
// Kinds: attack / build (the card's own problem), buy (buying an attack or
// build card from the shop), wild (drawing + using a wild card), raid (stopping a raid).
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const MATH_TYPES = {
  add1:  () => { const a = rand(1, 9),   b = rand(1, 9);   return { eq: `${a}+${b}`, answer: a + b }; },
  mul1:  () => { const a = rand(1, 5),   b = rand(1, 5);   return { eq: `${a}×${b}`, answer: a * b }; },
  add2:  () => { const a = rand(10, 50), b = rand(10, 50); return { eq: `${a}+${b}`, answer: a + b }; },
  sub2:  () => { const a = rand(10, 20), b = rand(1, 9);   return { eq: `${a}−${b}`, answer: a - b }; },
  mul2:  () => { const a = rand(2, 9),   b = rand(2, 9);   return { eq: `${a}×${b}`, answer: a * b }; },
  add3:  () => { const a = rand(10, 99), b = rand(10, 99); return { eq: `${a}+${b}`, answer: a + b }; },
  sub3:  () => { const a = rand(20, 99), b = rand(10, a - 1); return { eq: `${a}−${b}`, answer: a - b }; },
  mul3:  () => { const a = rand(2, 12),  b = rand(2, 12);  return { eq: `${a}×${b}`, answer: a * b }; },
  div3:  () => { const b = rand(2, 9),   q = rand(2, 9);   return { eq: `${b * q}÷${b}`, answer: q }; },
};

// Each kind lists the problem types it picks from (equal chance each)
const BOSS_MATH = {
  1: { attack: ['add1'],         build: ['add1'],         buy: ['add1'], wild: ['mul1'] },
  2: { attack: ['add2', 'sub2'], build: ['add2', 'sub2'], buy: ['sub2'], wild: ['mul2'] },
  3: { attack: ['sub3'],         build: ['add3'],         buy: ['mul3'], wild: ['div3'] },
};

// Raids lean on the hard (wild) math; the rest of the time it's one of the easier kinds
const RAID_WILD_CHANCE = 0.7;

function makeBossEq(level, kind) {
  const table = BOSS_MATH[bossFor(level).level];
  if (kind === 'raid') kind = Math.random() < RAID_WILD_CHANCE ? 'wild' : pick(['attack', 'build', 'buy']);
  return MATH_TYPES[pick(table[kind] || table.attack)]();
}

module.exports = { BOSSES, bossFor, chooseMove, makeBossEq, BOSS_MATH, MATH_TYPES };
