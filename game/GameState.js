'use strict';

const {
  buildAttackPile, buildBuildPile, buildWildPile,
  drawStartingHand, buildStartingWalls, MATCHUP, WILD_DEFS,
} = require('./cardData');
const WILD_EFFECTS = require('./wildEffects');

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
        isHost: true,
        hand:  drawStartingHand(this.piles.attack),
        walls: buildStartingWalls(),
      },
      p2: {
        socketId: room.p2,
        name: room.p2Name || 'Player 2',
        isHost: false,
        hand:  drawStartingHand(this.piles.attack),
        walls: buildStartingWalls(),
      },
    };

    // Pending action context (for two-step interactions)
    this._pending = null;
  }

  // ─── Public state broadcast ────────────────────────────────────────────────
  getPublicState() {
    return {
      phase:        this.phase,
      currentTurn:  this.currentTurn,
      actionsLeft:  this.actionsLeft,
      round:        this.round,
      winner:       this.winner,
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
      isHost: p.isHost,
      hand:   p.hand,
      walls:  p.walls,
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
    const card = this.drawFromPile(pileType);
    this.addToHand(playerId, card);
    return card;
  }

  // Destroys one random active wall; returns its index (or -1 if none left).
  removeRandomWall(playerId) {
    const walls = this.players[playerId].walls;
    const activeIdx = walls.map((w, i) => (w.active ? i : -1)).filter(i => i >= 0);
    if (!activeIdx.length) return -1;
    const idx = activeIdx[Math.floor(Math.random() * activeIdx.length)];
    walls[idx].active = false;
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

    this.currentTurn = cur === 'p1' ? 'p2' : 'p1';
    this.actionsLeft = ACTIONS_PER_TURN;
    if (this.currentTurn === 'p1') this.round++;
  }

  _oppId(playerId) { return playerId === 'p1' ? 'p2' : 'p1'; }

  _isMyTurn(playerId) { return this.currentTurn === playerId; }

  _checkWin(attackerId) {
    const oppId = this._oppId(attackerId);
    const oppWalls = this.players[oppId].walls;
    if (oppWalls.some(w => w.active)) return null; // still has walls
    return null; // Walls gone — next direct attack wins (handled in solveAttack)
  }

  // ─── Shop ──────────────────────────────────────────────────────────────────
  shopPick(playerId, pileType) {
    if (!this._isMyTurn(playerId)) return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)     return { type: 'error', message: 'No actions left.' };
    if (!this.piles[pileType])     return { type: 'error', message: 'Unknown pile.' };
    if (pileType !== 'wild' && this.handSpace(playerId) <= 0) {
      return { type: 'error', message: 'Your hand is full! Play a card first.' };
    }

    // Red Spell Book: the whole shop action skips the math.
    if (this.activeEffects[playerId].noMath) {
      this.activeEffects[playerId].noMath = false;
      const card = this.drawFromPile(pileType);
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

    const card = this.peekPile(pileType);
    const action = pileType === 'wild' ? 'wild_draw' : 'shop_draw';
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
    const correct = answer === (isWild ? card.drawAnswer : card.answer);

    if (!correct) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! Card discarded. The answer was ${isWild ? card.drawAnswer : card.answer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: isWild ? card.drawAnswer : card.answer },
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
  playAttack(playerId, cardId, targetWallIndex) {
    if (!this._isMyTurn(playerId))           return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)               return { type: 'error', message: 'No actions left.' };

    const card = this.players[playerId].hand.find(c => c.id === cardId);
    if (!card || card.type !== 'attack')     return { type: 'error', message: 'Card not found in hand.' };

    const oppId = this._oppId(playerId);
    const opp   = this.players[oppId];
    const anyWall = opp.walls.some(w => w.active);

    // Attempted direct attack but walls remain
    if (targetWallIndex === -1 && anyWall) {
      return { type: 'error', message: 'Destroy all enemy walls before landing a direct attack!' };
    }

    // Attempted wall attack but no walls left
    if (targetWallIndex !== -1 && !anyWall) {
      return { type: 'info', message: 'All walls are gone — use Direct Attack!' };
    }

    const noMath = this.activeEffects[playerId].noMath;
    const context = { wallIndex: targetWallIndex };

    if (noMath) {
      this.activeEffects[playerId].noMath = false; // Spell Book used up
      this.removeFromHand(playerId, cardId);
      const res = this._resolveAttack(playerId, card, targetWallIndex, true);
      res.message = '📕 No math! ' + res.message;
      if (res.fx) res.fx.spellUsed = true;
      return res;
    }

    this._pending = { playerId, action: 'attack', card, cardId, wallIndex: targetWallIndex };
    return {
      mathChallenge: { card, action: 'attack', context },
    };
  }

  // ─── Solve attack ──────────────────────────────────────────────────────────
  solveAttack(playerId, cardId, targetWallIndex, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'attack') return null;
    this._pending = null;

    const card = this.removeFromHand(playerId, cardId);
    const correct = card && answer === card.answer;

    if (!correct) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! Attack failed. The answer was ${card?.answer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: card?.answer },
      };
    }

    return this._resolveAttack(playerId, card, targetWallIndex, true);
  }

  _resolveAttack(playerId, card, targetWallIndex, mathCorrect) {
    const oppId = this._oppId(playerId);
    const opp   = this.players[oppId];
    const me    = this.players[playerId];

    // Direct attack (all walls gone)
    const anyWall = opp.walls.some(w => w.active);
    if (!anyWall) {
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

    const wall = opp.walls[targetWallIndex];
    if (!wall || !wall.active) {
      this._useAction();
      return { type: 'info', message: 'That wall is already destroyed.', stateUpdated: true, fx: { kind: 'correct' } };
    }

    // Red Potion: free destroy — target wall (no matchup check) + one adjacent wall.
    if (this.activeEffects[playerId].doublePower) {
      this.activeEffects[playerId].doublePower = false;
      wall.active = false;
      const adjacent = [targetWallIndex - 1, targetWallIndex + 1]
        .filter(i => i >= 0 && i < opp.walls.length && opp.walls[i].active);
      const also = adjacent.length ? adjacent[Math.floor(Math.random() * adjacent.length)] : -1;
      if (also >= 0) opp.walls[also].active = false;
      this._useAction();
      return {
        type: 'success',
        message: also >= 0
          ? `🧪 Power attack! ${wall.type} AND ${opp.walls[also].type} walls destroyed!`
          : `🧪 Power attack! ${wall.type} wall destroyed!`,
        stateUpdated: true,
        fx: { kind: 'smash', cardSub: card.sub, cardIcon: card.icon, target: targetWallIndex, also, potion: true },
      };
    }

    const match = MATCHUP[card.sub];
    const breaks = match?.breaks?.includes(wall.type);

    this._useAction();
    if (breaks) {
      wall.active = false;
      return {
        type: 'success',
        message: `⚔️ ${card.sub} smashes ${wall.type} wall!`,
        stateUpdated: true,
        fx: { kind: 'smash', cardSub: card.sub, cardIcon: card.icon, target: targetWallIndex, also: -1 },
      };
    }
    return {
      type: 'info',
      message: `🛡 ${wall.type} wall blocked ${card.sub}!`,
      stateUpdated: true,
      fx: { kind: 'blocked', cardSub: card.sub, cardIcon: card.icon, target: targetWallIndex },
    };
  }

  // ─── Play build ────────────────────────────────────────────────────────────
  playBuild(playerId, cardId, wallSlotIndex) {
    if (!this._isMyTurn(playerId))     return { type: 'error', message: "It's not your turn." };
    if (this.actionsLeft <= 0)         return { type: 'error', message: 'No actions left.' };

    const card = this.players[playerId].hand.find(c => c.id === cardId);
    if (!card || card.type !== 'build') return { type: 'error', message: 'Card not found.' };

    const slot = this.players[playerId].walls[wallSlotIndex];
    if (!slot)          return { type: 'error', message: 'Invalid wall slot.' };
    if (slot.active)    return { type: 'error', message: 'That wall slot is already occupied.' };

    const noMath = this.activeEffects[playerId].noMath;
    if (noMath) {
      this.activeEffects[playerId].noMath = false; // Spell Book used up
      this.removeFromHand(playerId, cardId);
      const res = this._resolveBuild(playerId, card, wallSlotIndex, true);
      res.message = '📕 No math! ' + res.message;
      if (res.fx) res.fx.spellUsed = true;
      return res;
    }

    this._pending = { playerId, action: 'build', card, cardId, slotIndex: wallSlotIndex };
    return {
      mathChallenge: { card, action: 'build', context: { slotIndex: wallSlotIndex } },
    };
  }

  // ─── Solve build ───────────────────────────────────────────────────────────
  solveBuild(playerId, cardId, wallSlotIndex, answer) {
    const p = this._pending;
    if (!p || p.playerId !== playerId || p.action !== 'build') return null;
    this._pending = null;

    const card = this.removeFromHand(playerId, cardId);
    const correct = card && answer === card.answer;

    if (!correct) {
      this._useAction();
      return {
        type: 'error',
        message: `✗ Wrong! Wall not placed. The answer was ${card?.answer}.`,
        stateUpdated: true,
        fx: { kind: 'wrong', answer: card?.answer },
      };
    }

    return this._resolveBuild(playerId, card, wallSlotIndex, true);
  }

  _resolveBuild(playerId, card, wallSlotIndex, correct) {
    if (!correct) {
      this._useAction();
      return { type: 'error', message: 'Wall not placed.', stateUpdated: true };
    }
    const slot = this.players[playerId].walls[wallSlotIndex];
    slot.type   = card.sub;
    slot.icon   = card.icon;
    slot.active = true;
    this._useAction();
    return {
      type: 'success',
      message: `🏰 ${card.sub} wall built!`,
      stateUpdated: true,
      fx: { kind: 'built', target: wallSlotIndex },
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
