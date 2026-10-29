const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Phones (Android especially) go quiet when the screen locks or the app is
// switched. Be patient before calling a socket dead; the 10-minute rejoin
// window below covers longer gaps.
const io = new Server(server, {
  pingInterval: 25000,  // heartbeat every 25s
  pingTimeout:  60000,  // wait 60s for a reply before dropping
});

const PORT = process.env.PORT || 3000;

// Version: bump "version" in package.json AND CLIENT_VERSION in public/index.html together.
const SERVER_VERSION = require('./package.json').version;
const STARTED_AT = new Date().toISOString();

// Version check: open /version in a browser to see what the server is running
app.get('/version', (req, res) => res.json({ version: SERVER_VERSION, started: STARTED_AT }));

// Serve static files. HTML is never cached, so iPads always get the newest page.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ─── Avatars & moods ─────────────────────────────────────────────────────────
const MOODS = ['normal', 'attack', 'correct', 'wrong', 'worried', 'shopping'];
const cleanAvatar = a => (typeof a === 'string' && /^avatar\d{1,2}$/.test(a)) ? a : 'avatar1';

// ─── Room state ───────────────────────────────────────────────────────────────
// rooms Map: roomCode → { p1: socketId, p2: socketId|null, p1Name, p2Name, p1Diff, p2Diff, state }
const rooms = new Map();

// ─── Reconnect / rejoin ───────────────────────────────────────────────────────
// Each seat gets a secret session key, saved on the device. If the connection
// drops, the room is kept and the player's seat waits for them. The phone
// rejoins automatically with its key. If they're not back in time, the room ends.
const REJOIN_WINDOW_MS   = 10 * 60 * 1000; // mid-game / lobby: 10 minutes
const GAMEOVER_WINDOW_MS =  5 * 60 * 1000; // game over screen: 5 minutes
const newKey = () => crypto.randomBytes(12).toString('hex');
const otherSeat = pid => (pid === 'p1' ? 'p2' : 'p1');

// A room is paused while any seated player is away
const isPaused = room => !!(room.away && (room.away.p1 || room.away.p2));

function endRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  for (const pid of ['p1', 'p2']) clearTimeout(room.awayTimers?.[pid]);
  io.to(code).emit('session_expired', { reason });
  io.in(code).socketsLeave(code);
  rooms.delete(code);
  console.log(`[room] ${code} closed (${reason})`);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1 confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ─── Socket.io events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  socket.emit('server_version', { version: SERVER_VERSION });

  // ── create_game ─────────────────────────────────────────────────────────────
  socket.on('create_game', ({ name, difficulty, avatar }) => {
    const roomCode = generateRoomCode();
    rooms.set(roomCode, {
      roomCode,
      p1: socket.id,
      p2: null,
      p1Name: name || 'Player 1',
      p2Name: null,
      p1Diff: difficulty || 1,
      p2Diff: 1,
      p1Avatar: cleanAvatar(avatar),
      p2Avatar: 'avatar1',
      state: null,
      keys: { p1: newKey(), p2: null },
      away: { p1: null, p2: null },      // timestamp when a seat dropped
      awayTimers: { p1: null, p2: null },
      lastChallenge: { p1: null, p2: null },
    });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerId = 'p1';

    console.log(`[room] ${roomCode} created by ${name} (${socket.id})`);

    socket.emit('session', { roomCode, playerId: 'p1', sessionKey: rooms.get(roomCode).keys.p1 });
    socket.emit('room_created', {
      roomCode,
      playerId: 'p1',
      serverUrl: `${socket.handshake.headers.origin || ''}`,
    });
  });

  // ── join_game ────────────────────────────────────────────────────────────────
  socket.on('join_game', ({ name, roomCode, difficulty, avatar }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.p2) {
      socket.emit('join_error', { message: 'Room is full.' });
      return;
    }

    room.p2 = socket.id;
    room.p2Name = name || 'Player 2';
    room.p2Diff = difficulty || 1;
    room.p2Avatar = cleanAvatar(avatar);

    socket.join(code);
    socket.roomCode = code;
    socket.playerId = 'p2';

    console.log(`[room] ${code} joined by ${name} (${socket.id})`);

    room.keys.p2 = newKey();
    socket.emit('session', { roomCode: code, playerId: 'p2', sessionKey: room.keys.p2 });
    socket.emit('room_joined', { playerId: 'p2' });

    // Notify host that P2 joined
    io.to(room.p1).emit('player_joined', {
      p2Name: room.p2Name,
      p2Avatar: room.p2Avatar,
    });

    // Broadcast lobby state to both
    io.to(code).emit('lobby_state', {
      roomCode: code,
      p1Name: room.p1Name,
      p2Name: room.p2Name,
      p1Diff: room.p1Diff,
      p2Diff: room.p2Diff,
      p1Avatar: room.p1Avatar,
      p2Avatar: room.p2Avatar,
    });
  });

  // ── rejoin: a device that dropped comes back with its session key ─────────
  socket.on('rejoin', ({ roomCode, sessionKey } = {}) => {
    const code = String(roomCode || '').toUpperCase();
    const room = rooms.get(code);
    const pid = room && ['p1', 'p2'].find(id => room.keys[id] && room.keys[id] === sessionKey);
    if (!room || !pid) {
      socket.emit('session_expired', { reason: 'expired' });
      return;
    }

    // Take the seat back (the old socket, if still lingering, is replaced)
    const oldId = room[pid];
    if (oldId && oldId !== socket.id) io.sockets.sockets.get(oldId)?.disconnect(true);
    room[pid] = socket.id;
    socket.join(code);
    socket.roomCode = code;
    socket.playerId = pid;

    const wasAway = !!room.away[pid];
    clearTimeout(room.awayTimers[pid]);
    room.awayTimers[pid] = null;
    room.away[pid] = null;
    console.log(`[rejoin] ${code} ${pid} (${socket.id})${wasAway ? '' : ' (quick)'}`);

    socket.emit('rejoined', { playerId: pid, roomCode: code, inGame: !!room.state });

    if (!room.state) {
      // Still in the lobby: replay what the lobby screens need
      if (pid === 'p1') {
        socket.emit('room_created', { roomCode: code, playerId: 'p1', serverUrl: '' });
        if (room.p2) socket.emit('player_joined', { p2Name: room.p2Name, p2Avatar: room.p2Avatar });
      } else {
        socket.emit('room_joined', { playerId: 'p2' });
        socket.emit('lobby_state', {
          roomCode: code, p1Name: room.p1Name, p2Name: room.p2Name,
          p1Diff: room.p1Diff, p2Diff: room.p2Diff, p1Avatar: room.p1Avatar, p2Avatar: room.p2Avatar,
        });
      }
    } else {
      socket.emit('game_state', { state: room.state.getPublicState() });
      // If they were in the middle of a math problem, put it back on screen
      const ch = room.lastChallenge[pid];
      if (ch && room.state._pending && room.state._pending.playerId === pid) socket.emit('math_challenge', ch);
      if (room.state.phase === 'gameover') socket.emit('game_over', { winner: room.state.winner });
    }

    const other = otherSeat(pid);
    if (room.away[other]) {
      const name = other === 'p1' ? room.p1Name : room.p2Name;
      socket.emit('opponent_away', { name, until: room.away[other] + REJOIN_WINDOW_MS });
    }
    if (wasAway) {
      socket.to(code).emit('opponent_back', { name: pid === 'p1' ? room.p1Name : room.p2Name });
      // An answer sent during the pause was ignored: hand the other player their problem again
      const otherSock = room[other] && io.sockets.sockets.get(room[other]);
      const och = room.lastChallenge[other];
      if (otherSock && och && room.state?._pending?.playerId === other) otherSock.emit('math_challenge', och);
    }
  });

  // ── set_mood: relay a player's avatar mood to their opponent ────────────────
  socket.on('set_mood', ({ mood } = {}) => {
    if (!socket.roomCode || !MOODS.includes(mood)) return;
    socket.to(socket.roomCode).emit('opponent_mood', { mood });
  });

  // ── start_game ───────────────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const code = socket.roomCode;
    const room = rooms.get(code);
    if (!room || socket.id !== room.p1) return; // only host can start
    if (!room.p2) {
      socket.emit('action_result', { type: 'error', message: 'Waiting for Player 2 to join.' });
      return;
    }

    const GameState = require('./game/GameState');
    const gs = new GameState(room);
    room.state = gs;

    console.log(`[game] ${code} started`);

    io.to(code).emit('game_state', { state: gs.getPublicState() });
  });

  // ── update_difficulty ────────────────────────────────────────────────────────
  socket.on('update_difficulty', ({ difficulty }) => {
    const code = socket.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.playerId === 'p1') room.p1Diff = difficulty;
    if (socket.playerId === 'p2') room.p2Diff = difficulty;
    // Reflect back to both if in lobby
    if (!room.state) {
      io.to(code).emit('lobby_state', {
        roomCode: code,
        p1Name: room.p1Name,
        p2Name: room.p2Name,
        p1Diff: room.p1Diff,
        p2Diff: room.p2Diff,
      });
    }
  });

  // ── shop_pick ────────────────────────────────────────────────────────────────
  socket.on('shop_pick', ({ pileType }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.shopPick(socket.playerId, pileType);
    handleActionResult(socket, room, result);
  });

  // ── solve_draw ───────────────────────────────────────────────────────────────
  socket.on('solve_draw', ({ cardId, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.solveDraw(socket.playerId, cardId, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── solve_wild_resolve ───────────────────────────────────────────────────────
  socket.on('solve_wild_resolve', ({ cardId, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.solveWildResolve(socket.playerId, cardId, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── play_attack ──────────────────────────────────────────────────────────────
  socket.on('play_attack', ({ cardId, targetShieldIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.playAttack(socket.playerId, cardId, targetShieldIndex);
    handleActionResult(socket, room, result);
  });

  // ── solve_attack ─────────────────────────────────────────────────────────────
  socket.on('solve_attack', ({ cardId, targetShieldIndex, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.solveAttack(socket.playerId, cardId, targetShieldIndex, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── play_build ───────────────────────────────────────────────────────────────
  socket.on('play_build', ({ cardId, shieldSlotIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.playBuild(socket.playerId, cardId, shieldSlotIndex);
    handleActionResult(socket, room, result);
  });

  // ── solve_build ──────────────────────────────────────────────────────────────
  socket.on('solve_build', ({ cardId, shieldSlotIndex, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.solveBuild(socket.playerId, cardId, shieldSlotIndex, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── end_turn ─────────────────────────────────────────────────────────────────
  socket.on('end_turn', () => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state || isPaused(room)) return;
    const result = room.state.endTurn(socket.playerId);
    handleActionResult(socket, room, result);
  });

  // ── rematch: both players tap Rematch → fresh game, same room/names/avatars ─
  socket.on('rematch_request', () => {
    const code = socket.roomCode;
    const room = rooms.get(code);
    if (!room || !room.state || room.state.phase !== 'gameover' || !room.p2) return;
    room.rematch = room.rematch || new Set();
    room.rematch.add(socket.playerId);
    io.to(code).emit('rematch_status', { ready: [...room.rematch] });

    if (room.rematch.has('p1') && room.rematch.has('p2')) {
      const loser = room.state.winner === 'p1' ? 'p2' : 'p1';
      room.rematch = null;
      const GameState = require('./game/GameState');
      const gs = new GameState(room);
      gs.currentTurn = loser;           // the player who lost goes first
      room.state = gs;
      console.log(`[game] ${code} rematch (${loser} starts)`);
      io.to(code).emit('rematch_start', {});
      io.to(code).emit('game_state', { state: gs.getPublicState() });
    }
  });

  // ── leave_room: player taps Leave on the game over screen ──────────────────
  socket.on('leave_room', () => {
    const code = socket.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const name = socket.playerId === 'p1' ? room.p1Name : room.p2Name;
    socket.to(code).emit('opponent_left', { name });
    for (const pid of ['p1', 'p2']) clearTimeout(room.awayTimers?.[pid]);
    socket.leave(code);
    socket.roomCode = null;
    rooms.delete(code);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const pid = socket.playerId;
    // Ignore an old socket that was already replaced by a rejoin
    if (room[pid] !== socket.id) return;

    // Don't end the game: hold the seat and pause until they rejoin
    const name = pid === 'p1' ? room.p1Name : room.p2Name;
    const holdMs = room.state?.phase === 'gameover' ? GAMEOVER_WINDOW_MS : REJOIN_WINDOW_MS;
    room.away[pid] = Date.now();
    clearTimeout(room.awayTimers[pid]);
    room.awayTimers[pid] = setTimeout(() => {
      if (rooms.get(code) === room && room.away[pid]) endRoom(code, `${name} didn't come back`);
    }, holdMs);
    console.log(`[away] ${code} ${pid} ${name} — holding seat ${holdMs / 60000} min`);

    socket.to(code).emit('opponent_away', { name, until: room.away[pid] + holdMs });

  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function handleActionResult(socket, room, result) {
  if (!result) return;
  const code = socket.roomCode;

  // Toast message + animation info → broadcast to room.
  // Sent BEFORE any follow-up math challenge so clients can finish the
  // correct/wrong animation before the next card appears.
  if (result.message) {
    io.to(code).emit('action_result', {
      type: result.type || 'info',
      message: result.message,
      actor: socket.playerId,
      fx: result.fx || null,
    });
  }

  // Private math challenge → only to the requesting player
  if (result.mathChallenge) {
    room.lastChallenge[socket.playerId] = result.mathChallenge; // re-sent if they rejoin mid-problem
    socket.emit('math_challenge', result.mathChallenge);
  }

  // Full state update → broadcast
  if (result.stateUpdated && room.state) {
    io.to(code).emit('game_state', { state: room.state.getPublicState() });
  }

  // Game over
  if (result.gameOver) {
    io.to(code).emit('game_over', { winner: result.gameOver });
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`⚔  Math Card Game v${SERVER_VERSION} running on http://localhost:${PORT}`);
});
