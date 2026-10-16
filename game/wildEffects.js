'use strict';

// Each handler receives (gs, playerId, card, resolveCorrect).
// Handlers are only called with resolveCorrect === false for Purple Potion and
// Poison Drink — every other wild is simply lost on a wrong answer.
//
// Return shape: { message, fx } where fx carries animation hints for the client:
//   gained:    [cardId]   cards that landed in the player's hand
//   stolen:    number     cards taken from the opponent (Looking Glass)
//   lostWalls: [index]    the player's own walls destroyed
//   safe:      true       Purple Potion survived
//   handFull:  true       a free card couldn't fit

const EFFECTS = {

  // Buff: the next attack answered correctly destroys the target wall (no
  // matchup check) plus one adjacent wall. Lasts until used — across turns.
  // Getting another one just refreshes it (no stacking).
  red_potion(gs, playerId) {
    const had = gs.activeEffects[playerId].doublePower;
    gs.activeEffects[playerId].doublePower = true;
    return {
      message: had
        ? '🧪 Red Potion! Still powered up (potions don\'t stack).'
        : '🧪 Red Potion! Your next attack smashes TWO walls!',
      fx: {},
    };
  },

  wooden_chest(gs, playerId) {
    const card = gs.giveFreeCard(playerId, 'attack');
    return card
      ? { message: `📦 Wooden Chest! Free ${card.sub} ${card.icon} added to your hand.`, fx: { gained: [card.id] } }
      : { message: '📦 Wooden Chest! …but your hand is full.', fx: { handFull: true } };
  },

  // +1 action this turn (which pays back the action spent buying it) + a free card.
  iron_chest(gs, playerId) {
    gs.actionsLeft += 1;
    const pile = Math.random() < 0.5 ? 'attack' : 'build';
    const card = gs.giveFreeCard(playerId, pile);
    return card
      ? { message: `🗃️ Iron Chest! +1 action + free ${card.sub} ${card.icon}!`, fx: { gained: [card.id], extraAction: true } }
      : { message: '🗃️ Iron Chest! +1 action! (Hand full — no free card.)', fx: { handFull: true, extraAction: true } };
  },

  purple_potion(gs, playerId, _card, resolveCorrect) {
    if (!resolveCorrect) {
      const lost = gs.removeRandomWall(playerId);
      return {
        message: lost >= 0 ? '🟣 Purple Potion! Wrong answer — you lost a wall!' : '🟣 Purple Potion! Wrong answer — but you had no walls left.',
        fx: { lostWalls: lost >= 0 ? [lost] : [] },
      };
    }
    return { message: '🟣 Purple Potion! Correct — your walls are safe.', fx: { safe: true } };
  },

  gold_chest(gs, playerId) {
    const gained = [];
    const atk = gs.giveFreeCard(playerId, 'attack');
    if (atk) gained.push(atk);
    const bld = gs.giveFreeCard(playerId, 'build');
    if (bld) gained.push(bld);
    if (gained.length === 2) return { message: `🏆 Gold Chest! Free ${atk.sub} ${atk.icon} + ${bld.sub} ${bld.icon}!`, fx: { gained: gained.map(c => c.id) } };
    if (gained.length === 1) return { message: `🏆 Gold Chest! Free ${gained[0].sub} ${gained[0].icon} (hand full for the second).`, fx: { gained: [gained[0].id], handFull: true } };
    return { message: '🏆 Gold Chest! …but your hand is full.', fx: { handFull: true } };
  },

  // Buff: the next action (attack, build or shop) needs no math. Lasts until
  // used — across turns. Doesn't stack.
  red_spellbook(gs, playerId) {
    const had = gs.activeEffects[playerId].noMath;
    gs.activeEffects[playerId].noMath = true;
    return {
      message: had
        ? '📕 Red Spell Book! Still active (books don\'t stack).'
        : '📕 Red Spell Book! Your next action needs no math!',
      fx: {},
    };
  },

  poison_drink(gs, playerId, _card, resolveCorrect) {
    const lost = [];
    const a = gs.removeRandomWall(playerId);
    if (a >= 0) lost.push(a);
    if (!resolveCorrect) {
      const b = gs.removeRandomWall(playerId);
      if (b >= 0) lost.push(b);
      return { message: `☠️ Poison Drink! Wrong answer — lost ${lost.length} wall${lost.length === 1 ? '' : 's'}!`, fx: { lostWalls: lost } };
    }
    return { message: lost.length ? '☠️ Poison Drink! Lost 1 wall (unavoidable).' : '☠️ Poison Drink! …no walls left to lose.', fx: { lostWalls: lost } };
  },

  armory(gs, playerId) {
    const card = gs.giveFreeCard(playerId, 'build');
    return card
      ? { message: `🛡️ Armory! Free ${card.sub} ${card.icon} added to your hand.`, fx: { gained: [card.id] } }
      : { message: '🛡️ Armory! …but your hand is full.', fx: { handFull: true } };
  },

  // Steal up to 2 random cards — only as many as fit in your hand, so nothing is lost.
  looking_glass(gs, playerId) {
    const oppId = playerId === 'p1' ? 'p2' : 'p1';
    const opp = gs.players[oppId];
    const room = gs.handSpace(playerId);
    const n = Math.min(2, room, opp.hand.length);
    const gained = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * opp.hand.length);
      const card = opp.hand.splice(idx, 1)[0];
      gs.addToHand(playerId, card);
      gained.push(card.id);
    }
    let message;
    if (n > 0) message = `🔮 Looking Glass! Stole ${n} card${n === 1 ? '' : 's'} from ${opp.name}!`;
    else if (!opp.hand.length) message = `🔮 Looking Glass! ${opp.name} has no cards to steal.`;
    else message = '🔮 Looking Glass! …but your hand is full.';
    return { message, fx: { gained, stolen: n, handFull: n === 0 && room === 0 } };
  },
};

module.exports = EFFECTS;
