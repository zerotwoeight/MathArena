'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let cardSeq = 0;
function nextId(prefix) { return `${prefix}_${++cardSeq}`; }

// ─── Equation generators by difficulty ───────────────────────────────────────
// difficulty: 1 = easy, 2 = medium, 3 = hard
function makeEq(difficulty) {
  if (difficulty === 1) {
    const a = rand(1, 9), b = rand(1, 9);
    return { eq: `${a}+${b}`, answer: a + b };
  }
  if (difficulty === 2) {
    const type = rand(0, 1);
    if (type === 0) {
      const a = rand(5, 20), b = rand(5, 20);
      return { eq: `${a}+${b}`, answer: a + b };
    } else {
      const a = rand(2, 5), b = rand(2, 9);
      return { eq: `${a}×${b}`, answer: a * b };
    }
  }
  // hard
  const type = rand(0, 2);
  if (type === 0) {
    const a = rand(10, 50), b = rand(10, 50);
    return { eq: `${a}+${b}`, answer: a + b };
  }
  if (type === 1) {
    const a = rand(5, 12), b = rand(5, 12);
    return { eq: `${a}×${b}`, answer: a * b };
  }
  const a = rand(10, 30), b = rand(2, 9);
  return { eq: `${a}−${b}`, answer: a - b };
}

// Wild equations always use 2× (physical card style)
function makeWildEq() {
  const b = rand(1, 9);
  return { eq: `2×${b}`, answer: 2 * b };
}

// ─── Card definitions ─────────────────────────────────────────────────────────
const ATK_SUBS = [
  { sub: 'Sword',  icon: '⚔️' },
  { sub: 'Gun',    icon: '🔫' },
  { sub: 'Hammer', icon: '🔨' },
];
const BLD_SUBS = [
  { sub: 'Stone', icon: '🪨' },
  { sub: 'Wood',  icon: '🌲' },
  { sub: 'Gem',   icon: '💎' },
];

const WILD_DEFS = [
  { effect: 'red_potion',  name: 'Red Potion',    icon: '🧪', desc: 'Next attack destroys target wall + one adjacent wall.' },
  { effect: 'wooden_chest',name: 'Wooden Chest',  icon: '📦', desc: 'Free attack card added to hand.' },
  { effect: 'iron_chest',  name: 'Iron Chest',    icon: '🗃️', desc: 'Extra action + 1 free card added to hand.' },
  { effect: 'purple_potion',name: 'Purple Potion',icon: '🟣', desc: 'Lose 1 random wall if wrong; safe if correct.' },
  { effect: 'gold_chest',  name: 'Gold Chest',    icon: '🏆', desc: 'Free attack card + free build card added to hand.' },
  { effect: 'red_spellbook',name: 'Red Spell Book',icon: '📕',desc: 'Your next action needs no math!' },
  { effect: 'poison_drink',name: 'Poison Drink',  icon: '☠️', desc: 'Lose 1 random wall; wrong solve = lose 2 walls.' },
  { effect: 'armory',      name: 'Armory',        icon: '🛡️', desc: 'Free build card added to hand.' },
  { effect: 'looking_glass',name: 'Looking Glass',icon: '🔮', desc: 'Steal 2 random cards from opponent\'s hand.' },
];

// ─── Pile builders ───────────────────────────────────────────────────────────
function buildAttackPile(count, difficulty) {
  return Array.from({ length: count }, () => {
    const sub = ATK_SUBS[rand(0, 2)];
    const { eq, answer } = makeEq(difficulty);
    return { id: nextId('atk'), type: 'attack', ...sub, eq, answer };
  });
}

function buildBuildPile(count, difficulty) {
  return Array.from({ length: count }, () => {
    const sub = BLD_SUBS[rand(0, 2)];
    const { eq, answer } = makeEq(difficulty);
    return { id: nextId('bld'), type: 'build', ...sub, eq, answer };
  });
}

function buildWildPile(count) {
  return Array.from({ length: count }, () => {
    const def = WILD_DEFS[rand(0, WILD_DEFS.length - 1)];
    const draw = makeWildEq();
    const resolve = makeWildEq();
    return {
      id: nextId('wld'),
      type: 'wild',
      ...def,
      drawEq: draw.eq, drawAnswer: draw.answer,
      resolveEq: resolve.eq, resolveAnswer: resolve.answer,
    };
  });
}

// ─── Starting hand draw (no solve required) ───────────────────────────────────
function drawStartingHand(attackPile, difficulty) {
  const cards = [];
  for (let i = 0; i < 2; i++) {
    const card = attackPile.pop();
    if (card) cards.push(card);
  }
  return cards;
}

// ─── Starting walls ───────────────────────────────────────────────────────────
function buildStartingWalls() {
  return [
    { type: 'Stone', icon: '🪨', active: true },
    { type: 'Wood',  icon: '🌲', active: true },
    { type: 'Gem',   icon: '💎', active: true },
  ];
}

// ─── Matchup table ────────────────────────────────────────────────────────────
const MATCHUP = {
  Sword:  { breaks: ['Wood', 'Gem'],   blocked: ['Stone'] },
  Gun:    { breaks: ['Wood', 'Stone'], blocked: ['Gem']   },
  Hammer: { breaks: ['Stone', 'Gem'],  blocked: ['Wood']  },
};

module.exports = {
  buildAttackPile,
  buildBuildPile,
  buildWildPile,
  drawStartingHand,
  buildStartingWalls,
  MATCHUP,
  WILD_DEFS,
  makeEq,
};
