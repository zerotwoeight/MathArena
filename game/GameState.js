'use strict';

const {
  buildAttackPile, buildBuildPile, buildWildPile,
  drawStartingHand, buildStartingShields, MATCHUP, WILD_DEFS, makeEq,
} = require('./cardData');
const WILD_EFFECTS = require('./wildEffects');
const { bossFor, makeBossEq } = require('./boss');

const PILE_SIZE  = 20;
const MAX_HAND   = 5;
const ACTIONS_PER_TURN = 3;

class GameState {
  constructor(room) {
    this.roomCode     = room.roomCode || '----';
    this.phase        = 'playing';
    this.currentTurn  = 'p1';
    this.actionsLeft  = ACTIONS_PER_TURN;
    this.round        = 1;
    this.winner       = null;

    // Per-player difficulty (affects equations generated during the game)
    this.difficulty = { p1: room.p1Diff || 1, p2: room.p2Diff || 1 };

    this.activeEffects = {
      p1: { doublePower: false, noMath: false, extraTurn: false },
      p2: { doublePower: false, noMath: false, extraTurn: false },
    };

    // Build piles using p1's difficulty as default (piles are shared)
    const avgDiff = Math.round((this.difficulty.p1 + this.difficulty.p2) / 2) || 1;
    this.pileDiff = avgDiff;
    this.piles = {
      attack: buildAttackPile(PILE_SIZE, avgDiff),
      build:  buildBuildPile(PILE_SIZE, avgDiff),
      wild:   buildWildPile(PILE_SIZE),
    };

    this.players = {
      p1: {
        socketId: room.p1,
        name: room.p1Name || 'Player 1',
        avatar: room.p1Avatar || 'avatar1',
        isHost: true,
        hand:  drawStartingHand(this.piles.attack),
        shields: buildStartingShields(),
      },
      p2: {
        socketId: room.p2,
        name: room.p2Name || 'Player 2',
        avatar: room.p2Avatar || 'avatar1',
        isHost: false,
        hand:  drawStartingHand(this.piles.attack),
        shields: buildStartingShields(),
      },
    };

    // Pending action context (for two-step interactions)
    this._pending = null;

    // ── Solo mode: p2 is a kaiju boss with a health bar instead of shields
    this.mode = room.solo ? 'solo' : 'versus';
    this.lockedPiles = {};            // piles the boss raided: closed for the kid's next turn
    this.boss = null;
    if (room.solo) {
      const def = bossFor(room.solo.level);
      this.boss = { ...def, maxHp: def.hp, hp: def.hp, charged: false, raidBlocked: false };
      this.players.p2 = {
        socketId: null, name: def.name, avatar: def.id, isHost: false, hand: [], shields: [],
      };
    }

    // Each player gets problems at their own star level (solo: the boss's math)
    this.players.p1.hand.forEach(c => this.fitCard(c, 'p1'));
    this.players.p2.hand.forEach(c => this.fitCard(c, 'p2'));
  }

  get isSolo() { return this.mode === 'solo'; }

  // ─── Public state broadcast ────────────────────────────────────────────────
  getPublicState() {
    return {
      phase:        this.phase,
      currentTurn:  this.currentTurn,
      actionsLeft:  this.actionsLeft,
      round:        this.round,
      winner:       this.winner,
      mode:         this.mode,
      boss:         this.boss && {
        level: this.boss.level, id: this.boss.id, color: this.boss.color, name: this.boss.name,
        hp: this.boss.hp, maxHp: this.boss.maxHp, weak: this.boss.weak,
        charged: this.boss.charged, raidBlocked: this.boss.raidBlocked,
      },
      lockedPiles:  this.lockedPiles,
      activeEffects: this.activeEffects,
      players: {
        p1: this._publicPlayer('p1'),
        p2: this._publicPlayer('p2'),
      },
    };
  }

  _publicPlayer(id) {
    const p = this.players[id];
    return {
      name:   p.name,
      avatar: p.avatar,
      isHost: p.isHost,
      hand:   p.hand,
      shields:  p.shields,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  addToHand(playerId, card) {
    const hand = this.players[playerId].hand;
    if (hand.length >= MAX_HAND) return false;
    hand.push(card);
    return true;
  }

  removeFromHand(playerId, cardId) {
    const hand = this.players[playerId].hand;
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return null;
    return hand.splice(idx, 1)[0];
  }

  // Re-rolls an attack/build card's problem to match this player's difficulty.
  // Called whenever a card is about to be shown to, or land in, a player's hand.
  fitCard(card, playerId) {
    if (card && this.isSolo) {
      // Solo: the boss sets the math, the stars only set the timer
      const lvl = this.boss.level;
      if (card.type === 'attack' || card.type === 'build') Object.assign(card, makeBossEq(lvl, card.type));
      if (card.type === 'wild') {
        const draw = makeBossEq(lvl, 'wild'), resolve = makeBossEq(lvl, 'wild');
        Object.assign(card, { drawEq: draw.eq, drawAnswer: draw.answer, resolveEq: resolve.eq, resolveAnswer: resolve.answer });
      }
      return card;
    }
    if (card && (card.type === 'attack' || card.type === 'build')) {
      const { eq, answer } = makeEq(this.difficulty[playerId] || 1);
      card.eq = eq;
      card.answer = answer;
    }
    return card;
  }

  handSpace(playerId) {
    return MAX_HAND - this.players[playerId].hand.length;
  }

  // Piles never run out — when one empties, a fresh batch is generated.
  _refill(pileType) {
    const pile = this.piles[pileType];
    if (pile.length) return pile;
    if (pileType === 'attack') this.piles.attack = buildAttackPile(PILE_SIZE, this.pileDiff);
    if (pileType === 'build')  this.piles.build  = buildBuildPile(PILE_SIZE, this.pileDiff);
    if (pileType === 'wild')   this.piles.wild   = buildWildPile(PILE_SIZE);
    return this.piles[pileType];
  }
  peekPile(pileType) {
    const pile = this._refill(pileType);
    return pile[pile.length - 1];
  }
  drawFromPile(pileType) {
    return this._refill(pileType).pop();
  }

  // Free card from a chest/armory. Only takes a card if it fits — nothing is lost.
  giveFreeCard(playerId, pileType) {
    if (this.handSpace(playerId) <= 0) return null;
    const card = this.fitCard(this.drawFromPile(pileType), playerId);
    this.addToHand(playerId, card);
    return card;
  }

  // Destroys one random active shield; returns its index (or -1 if none left).
  removeRandomShield(playerId) {
    const shields = this.players[playerId].shields;
    const activeIdx = shields.map((w, i) => (w.active ? i : -1)).filter(i => i >= 0);
    if (!activeIdx.length) return -1;
    const idx = activeIdx[Math.floor(Math.random() * activeIdx.length)];
    shields[idx].active = false;
    return idx;
  }

  grantExtraTurn(playerId) {
    this.activeEffects[playerId].extraTurn = true;
  }

  _useAction() {
    this.actionsLeft--;
    if (this.actionsLeft <= 0) {
      this._doEndTurn();
      return true; // auto-ended
    }
    return false;
  }

  _doEndTurn() {
    const cur = this.currentTurn;
    const eff = this.activeEffects[cur];

    if (eff.extraTurn) {
      eff.extraTurn = false;
      this.actionsLeft = ACTIONS_PER_TURN;
      return;
    }

    // Red Potion (doublePower) and Red Spell Book (noMath) are NOT reset here —
    // they stay active until the player uses them, even across turns.

    // Solo: raided piles come back once the kid's turn is over
    if (this.isSolo && cur === 'p1') this.lockedPiles = {};

    this.currentTurn = cur === 'p1' ? 'p2' : 'p1';
    this.actionsLeft = this.isSolo && this.currentTurn === 'p2' ? this.boss.actions : ACTIONS_PER_TURN;
    if (this.currentTurn === 'p1') this.round++;
  }

  _oppId(playerId) { return playerId === 'p1' ? 'p2' : 'p1'; }

  _isMyTurn(playerId) { return this.currentTurn === playerId; }

  _checkWin(attackerId) {
    const oppId = this._oppId(attackerId);
    const oppShields = this.players[oppId].shields;
    if (oppShields.some(w => w.active)) return null; // still has shields
    return null; // Shields gone — next direct attack wins (handled in solveAttack)
  }

  // ─── Shop ──────────────────────────────────────────────────────────────────
  shopPick(playerId, pileType) {
    if (!this._isMyTurn(playerId)) return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)     return { type: 'error', message: 'No actions left.' };
    if (!this.piles[pileType])     return { type: 'error', message: 'Unknown pile.' };
    if (this.lockedPiles[pileType]) {
      return { type: 'error', message: `The ${this.boss?.name || 'boss'} raided that pile! It's back next turn.` };
    }
    if (pileType !== 'wild' && this.handSpace(playerId) <= 0) {
      return { type: 'error', message: 'Your hand is full! Play a card first.' };
    }

    // Red Spell Book: the whole shop action skips the math.
    if (this.activeEffects[playerId].noMath) {
      this.activeEffects[playerId].noMath = false;
      const card = this.fitCard(this.drawFromPile(pileType), playerId);
      if (pileType === 'wild') return this._applyWild(playerId, card, true, '📕 ');
      this.addToHand(playerId, card);
      this._useAction();
      return {
        type: 'success',
        message: `📕 No math! ${card.sub} ${card.icon} added to hand.`,
        stateUpdated: true,
        fx: { kind: 'correct', cardType: card.type, gained: [card.id], spellUsed: true },
      };
    }

    const card = this.fitCard(this.peekPile(pileType), playerId);
    const action = pileType === 'wild' ? 'wild_draw' : 'shop_draw';
    // Solo: buying an attack/build card has its own problem; the card keeps its own for playing
    if (this.isSolo && action === 'shop_draw') {
      const buy = makeBossEq(this.boss.level, 'buy');
      this._pending = { playerId, action, pileType, card, buyAnswer: buy.answer };
      return { mathChallenge: { card: { ...card, ...buy }, action, context: {} } };
    }
    this._pending = { playerId, action, pileType, card };
    return { mathChallenge: { card, action, context: {} } };
  }

  // ─── Solve draw ────────────────────────────────────────────────────────────
  solveDraw(playerId, cardId, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || (p.action !== 'shop_draw' && p.action !== 'wild_draw')) return null;
    this._pending = null;

    const card = this.drawFromPile(p.pileType); // consume (same card that was peeked)
    const isWild = p.pileType === 'wild';
    const expected = isWild ? card.drawAnswer : (p.buyAnswer ?? card.answer);
    const correct = answer === expected;

    if (!correct) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! Card discarded. The answer was ${expected}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: expected },
      };
    }

    if (isWild) {
      // Step 2: resolve equation. The action is charged after step 2, so a
      // wild drawn as the last action still resolves on this turn.
      this._pending = { playerId, action: 'wild_resolve', card };
      return {
        type: 'success',
        message: '✓ Correct! Now activate the wild effect…',
        stateUpdated: true,
        fx: { kind: 'correct', next: true },
        mathChallenge: {
          card,
          action: 'wild_resolve',
          context: { effectDesc: WILD_DEFS.find(d => d.effect === card.effect)?.desc || '' },
        },
      };
    }

    this._useAction();
    if (this.addToHand(playerId, card)) {
      return {
        type: 'success',
        message: `✓ Correct! ${card.sub} ${card.icon} added to hand.`,
        stateUpdated: true,
        fx: { kind: 'correct', cardType: card.type },
      };
    }
    return {
      type: 'info',
      message: 'Correct, but your hand is full! Card discarded.',
      stateUpdated: true,
      fx: { kind: 'correct' },
    };
  }

  // ─── Solve wild resolve ────────────────────────────────────────────────────
  solveWildResolve(playerId, cardId, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'wild_resolve') return null;
    this._pending = null;
    return this._applyWild(playerId, p.card, answer === p.card.resolveAnswer, '');
  }

  // Applies a wild card's effect and charges the shop action.
  _applyWild(playerId, card, correct, prefix) {
    const alwaysRuns = ['purple_potion', 'poison_drink'].includes(card.effect);

    if (!correct && !alwaysRuns) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! ${card.name} lost. The answer was ${card.resolveAnswer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: card.resolveAnswer },
      };
    }

    const effectFn = WILD_EFFECTS[card.effect];
    const result = effectFn ? effectFn(this, playerId, card, correct) : { message: 'Wild effect resolved.', fx: {} };
    this._useAction(); // after the effect, so Iron Chest's extra turn applies on the last action
    return {
      type: correct ? 'success' : 'error',
      message: prefix + result.message,
      stateUpdated: true,
      fx: {
        kind: correct ? 'wild' : 'wrong',
        answer: correct ? undefined : card.resolveAnswer,
        effect: card.effect, name: card.name, icon: card.icon,
        spellUsed: prefix ? true : undefined,
        ...(result.fx || {}),
      },
    };
  }

  // ─── Play attack ───────────────────────────────────────────────────────────
  playAttack(playerId, cardId, targetShieldIndex) {
    if (!this._isMyTurn(playerId))           return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)               return { type: 'error', message: 'No actions left.' };

    const card = this.players[playerId].hand.find(c => c.id === cardId);
    if (!card || card.type !== 'attack')     return { type: 'error', message: 'Card not found in hand.' };

    const oppId = this._oppId(playerId);
    const opp   = this.players[oppId];
    if (this.isSolo) targetShieldIndex = -1;   // solo: every attack hits the boss
    const anyShield = opp.shields.some(w => w.active);

    // Attempted direct attack but shields remain
    if (targetShieldIndex === -1 && anyShield) {
      return { type: 'error', message: 'Destroy all enemy shields before landing a direct attack!' };
    }

    // Attempted shield attack but no shields left
    if (targetShieldIndex !== -1 && !anyShield) {
      return { type: 'info', message: 'All shields are gone. Use Direct Attack!' };
    }

    const noMath = this.activeEffects[playerId].noMath;
    const context = { shieldIndex: targetShieldIndex };

    if (noMath) {
      this.activeEffects[playerId].noMath = false; // Spell Book used up
      this.removeFromHand(playerId, cardId);
      const res = this._resolveAttack(playerId, card, targetShieldIndex, true);
      res.message = '📕 No math! ' + res.message;
      if (res.fx) res.fx.spellUsed = true;
      return res;
    }

    this._pending = { playerId, action: 'attack', card, cardId, shieldIndex: targetShieldIndex };
    return {
      mathChallenge: { card, action: 'attack', context },
    };
  }

  // ─── Solve attack ──────────────────────────────────────────────────────────
  solveAttack(playerId, cardId, targetShieldIndex, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'attack') return null;
    this._pending = null;

    const card = this.removeFromHand(playerId, cardId);
    const correct = card && answer === card.answer;

    if (!correct) {
      // Red Potion is lost along with the card — getting it wrong should sting.
      const potionLost = this.activeEffects[playerId].doublePower;
      this.activeEffects[playerId].doublePower = false;
      this._useAction();
      return {
        type: 'error',
        message: potionLost
          ? `✗ Wrong! Attack failed, and your 🧪 Red Potion is gone! The answer was ${card?.answer}.`
          : `✗ Wrong! Attack failed. The answer was ${card?.answer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: card?.answer, potionLost },
      };
    }

    return this._resolveAttack(playerId, card, targetShieldIndex, true);
  }

  _resolveAttack(playerId, card, targetShieldIndex, mathCorrect) {
    const oppId = this._oppId(playerId);
    const opp   = this.players[oppId];
    const me    = this.players[playerId];

    if (this.isSolo) return this._hitBoss(playerId, card);

    // Direct attack (all shields gone)
    const anyShield = opp.shields.some(w => w.active);
    if (!anyShield) {
      this._useAction();
      this.phase  = 'gameover';
      this.winner = playerId;
      return {
        type: 'success',
        message: `⚔️ Direct hit! ${me.name} wins!`,
        stateUpdated: true,
        gameOver: playerId,
        fx: { kind: 'direct', cardSub: card.sub, cardIcon: card.icon },
      };
    }

    const shield = opp.shields[targetShieldIndex];
    if (!shield || !shield.active) {
      this._useAction();
      return { type: 'info', message: 'That shield is already destroyed.', stateUpdated: true, fx: { kind: 'correct' } };
    }

    // Red Potion: free destroy — target shield (no matchup check) + one adjacent shield.
    if (this.activeEffects[playerId].doublePower) {
      this.activeEffects[playerId].doublePower = false;
      shield.active = false;
      const adjacent = [targetShieldIndex - 1, targetShieldIndex + 1]
        .filter(i => i >= 0 && i < opp.shields.length && opp.shields[i].active);
      const also = adjacent.length ? adjacent[Math.floor(Math.random() * adjacent.length)] : -1;
      if (also >= 0) opp.shields[also].active = false;
      this._useAction();
      return {
        type: 'success',
        message: also >= 0
          ? `🧪 Power attack! ${shield.type} AND ${opp.shields[also].type} shields destroyed!`
          : `🧪 Power attack! ${shield.type} shield destroyed!`,
        stateUpdated: true,
        fx: { kind: 'smash', cardSub: card.sub, cardIcon: card.icon, target: targetShieldIndex, also, potion: true },
      };
    }

    const match = MATCHUP[card.sub];
    const breaks = match?.breaks?.includes(shield.type);

    this._useAction();
    if (breaks) {
      shield.active = false;
      return {
        type: 'success',
        message: `⚔️ ${card.sub} smashes ${shield.type} shield!`,
        stateUpdated: true,
        fx: { kind: 'smash', cardSub: card.sub, cardIcon: card.icon, target: targetShieldIndex, also: -1 },
      };
    }
    return {
      type: 'info',
      message: `🛡 ${shield.type} shield blocked ${card.sub}!`,
      stateUpdated: true,
      fx: { kind: 'blocked', cardSub: card.sub, cardIcon: card.icon, target: targetShieldIndex },
    };
  }

  // ─── Solo: the kid hits the boss ──────────────────────────────────────────
  _hitBoss(playerId, card) {
    const b = this.boss;
    const weak = card.sub === b.weak;
    let damage = weak ? 2 : 1;
    const potion = this.activeEffects[playerId].doublePower;
    if (potion) { damage *= 2; this.activeEffects[playerId].doublePower = false; }
    b.hp = Math.max(0, b.hp - damage);
    this._useAction();
    const fx = { kind: 'boss_hit', cardSub: card.sub, cardIcon: card.icon, damage, weak, potion, ko: b.hp === 0 };
    if (b.hp === 0) {
      this.phase = 'gameover';
      this.winner = playerId;
      return { type: 'success', message: `💥 Knockout! The ${b.name} is defeated!`, stateUpdated: true, gameOver: playerId, fx };
    }
    let message = `⚔️ ${card.sub} hits the ${b.name} for ${damage}!`;
    if (weak) message += ` It's weak to ${b.weak}s!`;
    if (potion) message = '🧪 ' + message;
    return { type: 'success', message, stateUpdated: true, fx };
  }

  // ─── Solo: boss moves (called by the server's boss turn loop) ─────────────
  bossAttack() {
    const b = this.boss;
    const kid = this.players.p1;
    if (!kid.shields.some(s => s.active)) {
      this.phase = 'gameover';
      this.winner = 'p2';
      return { type: 'error', message: `💀 The ${b.name} knocks you out!`, stateUpdated: true, gameOver: 'p2', fx: { kind: 'boss_ko' } };
    }
    const charged = b.charged;
    b.charged = false;
    const lost = [];
    for (let i = 0; i < (charged ? 2 : 1); i++) {
      const idx = this.removeRandomShield('p1');
      if (idx >= 0) lost.push(idx);
    }
    const message = charged
      ? `⚡ Charged smash! The ${b.name} breaks ${lost.length} shield${lost.length === 1 ? '' : 's'}!`
      : `🦖 The ${b.name} smashes a shield!`;
    return { type: 'error', message, stateUpdated: true, fx: { kind: 'boss_attack', lostShields: lost, charged } };
  }

  bossHeal() {
    const b = this.boss;
    const before = b.hp;
    b.hp = Math.min(b.maxHp, b.hp + b.heal);
    return { type: 'info', message: `💚 The ${b.name} heals ${b.hp - before} HP.`, stateUpdated: true, fx: { kind: 'boss_heal', amount: b.hp - before } };
  }

  // Starts a raid: the kid gets a timed problem to defend the shop.
  bossRaidStart() {
    const b = this.boss;
    const pileType = ['attack', 'build', 'wild'][Math.floor(Math.random() * 3)];
    if (b.raidBlocked) {
      b.raidBlocked = false;
      return { type: 'success', message: `🔮 Your Looking Glass stopped the ${b.name}'s raid!`, stateUpdated: true, fx: { kind: 'boss_raid_blocked' } };
    }
    const top = this.peekPile(pileType);
    // Raid math: mostly the boss's wild math, now and then an easier one
    const card = { ...top, ...makeBossEq(b.level, 'raid') };
    this._pending = { playerId: 'p1', action: 'raid', pileType, card };
    return {
      type: 'info',
      message: `🦖 The ${b.name} is raiding the shop! Stop it!`,
      fx: { kind: 'boss_raid', pileType },
      mathChallenge: { card, action: 'raid', context: { pileType, bossName: b.name } },
    };
  }

  solveRaid(playerId, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'raid') return null;
    this._pending = null;
    const b = this.boss;
    if (answer === p.card.answer) {
      return { type: 'success', message: `🛡 Raid stopped! The ${b.name} got nothing.`, stateUpdated: true, fx: { kind: 'correct', raid: 'stopped' } };
    }
    this.drawFromPile(p.pileType);           // the boss takes it
    this.lockedPiles[p.pileType] = true;     // gone from the shop for the kid's next turn
    const gain = p.pileType === 'attack' ? 'charge'
      : p.pileType === 'build' ? 'heal'
      : (Math.random() < 0.5 ? 'charge' : 'heal');
    let what;
    if (gain === 'charge') { b.charged = true; what = 'Its next attack is charged!'; }
    else { const before = b.hp; b.hp = Math.min(b.maxHp, b.hp + b.raidHeal); what = `It heals ${b.hp - before} HP!`; }
    const pileName = { attack: 'Attack', build: 'Build', wild: 'Wild' }[p.pileType];
    return {
      type: 'error',
      message: `✗ The ${b.name} grabbed a ${pileName} card! ${what} (Answer: ${p.card.answer})`,
      stateUpdated: true,
      fx: { kind: 'wrong', answer: p.card.answer, raid: 'lost', pileType: p.pileType, gain },
    };
  }

  endBossTurn() {
    this.currentTurn = 'p1';
    this.actionsLeft = ACTIONS_PER_TURN;
    this.round++;
  }

  // ─── Play build ────────────────────────────────────────────────────────────
  playBuild(playerId, cardId, shieldSlotIndex) {
    if (!this._isMyTurn(playerId))     return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)         return { type: 'error', message: 'No actions left.' };

    const card = this.players[playerId].hand.find(c => c.id === cardId);
    if (!card || card.type !== 'build') return { type: 'error', message: 'Card not found.' };

    const slot = this.players[playerId].shields[shieldSlotIndex];
    if (!slot)          return { type: 'error', message: 'Invalid shield slot.' };
    if (slot.active)    return { type: 'error', message: 'That shield slot is already occupied.' };

    const noMath = this.activeEffects[playerId].noMath;
    if (noMath) {
      this.activeEffects[playerId].noMath = false; // Spell Book used up
      this.removeFromHand(playerId, cardId);
      const res = this._resolveBuild(playerId, card, shieldSlotIndex, true);
      res.message = '📕 No math! ' + res.message;
      if (res.fx) res.fx.spellUsed = true;
      return res;
    }

    this._pending = { playerId, action: 'build', card, cardId, slotIndex: shieldSlotIndex };
    return {
      mathChallenge: { card, action: 'build', context: { slotIndex: shieldSlotIndex } },
    };
  }

  // ─── Solve build ───────────────────────────────────────────────────────────
  solveBuild(playerId, cardId, shieldSlotIndex, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'build') return null;
    this._pending = null;

    const card = this.removeFromHand(playerId, cardId);
    const correct = card && answer === card.answer;

    if (!correct) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! Shield not placed. The answer was ${card?.answer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: card?.answer },
      };
    }

    return this._resolveBuild(playerId, card, shieldSlotIndex, true);
  }

  _resolveBuild(playerId, card, shieldSlotIndex, correct) {
    if (!correct) {
      this._useAction();
      return { type: 'error', message: 'Shield not placed.', stateUpdated: true };
    }
    const slot = this.players[playerId].shields[shieldSlotIndex];
    slot.type   = card.sub;
    slot.icon   = card.icon;
    slot.active = true;
    this._useAction();
    return {
      type: 'success',
      message: `🏰 ${card.sub} shield built!`,
      stateUpdated: true,
      fx: { kind: 'built', target: shieldSlotIndex },
    };
  }

  // ─── End turn ──────────────────────────────────────────────────────────────
  endTurn(playerId) {
    if (!this._isMyTurn(playerId)) return { type: 'error', message: "It's not your turn." };
    this.actionsLeft = 0;
    this._doEndTurn();
    return {
      type: 'info',
      message: `${this.players[playerId].name} passed their turn.`,
      stateUpdated: true,
    };
  }
}

module.exports = GameState;
