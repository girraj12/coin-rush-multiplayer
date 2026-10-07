# Coin Rush — Real-Time Multiplayer Backend Test

A small real-time multiplayer collectible game built with **Node.js, Express and Socket.IO**.

## Features
- N players can join a shared room with a username.
- Server creates a fixed set of collectibles.
- Real-time player movement and shared world state.
- Server-authoritative movement, collision and score updates.
- Exactly one player receives a point for a collectible because removal happens on the server.
- Live leaderboard.
- Game ends when all collectibles are collected.
- Multiple concurrent rooms supported.
- All-time high scores persisted in `data/scores.json`.
- Health and leaderboard APIs.

## Run locally
Requirements: Node.js 20+

```bash
npm install
npm start
```
Open `http://localhost:3000` in two or more browser tabs/windows. Use different usernames and the same room ID.

## API
- `GET /api/health` — server health and active room count.
- `GET /api/leaderboard` — all-time high scores.

## Architecture
The server is authoritative. Clients send only movement intent (`up/down/left/right`). Every 50ms the server advances player positions, clamps them to the world, checks collisions against the server-owned collectible array, awards the point, removes the collectible and broadcasts the resulting state.

This avoids trusting client-provided positions/scores and guarantees that a collectible can be awarded once even if two players reach it in the same server tick.
