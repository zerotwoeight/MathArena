const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    });
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerId = 'p1';

    console.log(`[room] ${roomCode} created by ${name} (${socket.id})`);

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
    if (!room?.state) return;
    const result = room.state.shopPick(socket.playerId, pileType);
    handleActionResult(socket, room, result);
  });

  // ── solve_draw ───────────────────────────────────────────────────────────────
  socket.on('solve_draw', ({ cardId, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.solveDraw(socket.playerId, cardId, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── solve_wild_resolve ───────────────────────────────────────────────────────
  socket.on('solve_wild_resolve', ({ cardId, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.solveWildResolve(socket.playerId, cardId, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── play_attack ──────────────────────────────────────────────────────────────
  socket.on('play_attack', ({ cardId, targetWallIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.playAttack(socket.playerId, cardId, targetWallIndex);
    handleActionResult(socket, room, result);
  });

  // ── solve_attack ─────────────────────────────────────────────────────────────
  socket.on('solve_attack', ({ cardId, targetWallIndex, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.solveAttack(socket.playerId, cardId, targetWallIndex, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── play_build ───────────────────────────────────────────────────────────────
  socket.on('play_build', ({ cardId, wallSlotIndex }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.playBuild(socket.playerId, cardId, wallSlotIndex);
    handleActionResult(socket, room, result);
  });

  // ── solve_build ──────────────────────────────────────────────────────────────
  socket.on('solve_build', ({ cardId, wallSlotIndex, answer }) => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.solveBuild(socket.playerId, cardId, wallSlotIndex, Number(answer));
    handleActionResult(socket, room, result);
  });

  // ── end_turn ─────────────────────────────────────────────────────────────────
  socket.on('end_turn', () => {
    const room = rooms.get(socket.roomCode);
    if (!room?.state) return;
    const result = room.state.endTurn(socket.playerId);
    handleActionResult(socket, room, result);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const name = socket.playerId === 'p1' ? room.p1Name : room.p2Name;
    // Notify the OTHER player specifically so the client can show the disconnect overlay
    socket.to(code).emit('opponent_disconnected', { name });

    rooms.delete(code);
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
