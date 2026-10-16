# ⚔ Math Card Game

Multiplayer online card game that teaches kids math. Every card play requires solving a math equation. Built with Node.js + Socket.io, designed for two iPads.

## Run Locally

```bash
npm install
npm run dev      # uses node --watch for auto-restart
# or
npm start        # plain node
```

Open two browser tabs (or two devices on the same network) at:
```
http://localhost:3000
```

One player taps **Create Game**, shares the 4-character room code, the other taps **Join Game** and enters it.

---

## Deploy to Railway

### First deploy

1. Push the repo to GitHub (or any Git host):
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/YOUR_USER/math-card-game.git
   git push -u origin main
   ```

2. Go to [railway.app](https://railway.app) and sign in.

3. Click **New Project → Deploy from GitHub repo** and select your repo.

4. Railway auto-detects Node.js via NIXPACKS. It will run `npm start` (`node server.js`).

5. After the deploy finishes, click the generated URL (e.g. `https://math-card-game-production.up.railway.app`).  
   Share that URL with both players — no setup required.

### Environment variables

No required env vars. Railway injects `PORT` automatically; the server reads it via:
```js
const PORT = process.env.PORT || 3000;
```

### Redeploy

Push a new commit to `main` — Railway redeploys automatically.

---

## Project structure

```
math-card-game/
├── server.js              ← Express + Socket.io entry point
├── game/
│   ├── GameState.js       ← Turn flow, win condition, state machine
│   ├── cardData.js        ← Procedural card generation
│   └── wildEffects.js     ← Wild card effect handlers
└── public/
    ├── index.html         ← Single-page client (Host + Client modes)
    └── style.css          ← Design token system
```

## Stack

- **Server**: Node.js + Express + Socket.io
- **Client**: Vanilla HTML/CSS/JS — no build step, no framework
- **Deploy**: Railway
