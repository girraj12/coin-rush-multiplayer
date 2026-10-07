import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SCORES_FILE)) fs.writeFileSync(SCORES_FILE, '{}');

const PORT = process.env.PORT || 3000;
const WORLD = { width: 900, height: 600 };
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 220;
const COLLECTIBLE_RADIUS = 12;
const COLLECTIBLE_COUNT = 25;
const TICK_MS = 50;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();
let allTimeScores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));

const random = (min, max) => Math.random() * (max - min) + min;
const distance = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const sanitizeName = name => String(name || 'Player').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0,20) || 'Player';

function saveScores() {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(allTimeScores, null, 2));
}
function createCollectibles() {
  return Array.from({length: COLLECTIBLE_COUNT}, (_, i) => ({
    id: `coin-${i+1}`,
    x: Math.round(random(40, WORLD.width-40)),
    y: Math.round(random(40, WORLD.height-40))
  }));
}
function createRoom(id) {
  const room = { id, players: new Map(), collectibles: createCollectibles(), startedAt: Date.now(), ended: false };
  rooms.set(id, room);
  return room;
}
function getRoom(id) { return rooms.get(id) || createRoom(id); }
function playerList(room) {
  return [...room.players.values()].map(p => ({ id:p.id, username:p.username, x:p.x, y:p.y, score:p.score }));
}
function leaderboard(room) {
  return playerList(room).sort((a,b) => b.score-a.score || a.username.localeCompare(b.username));
}
function emitState(room) {
  io.to(room.id).emit('game:state', {
    roomId: room.id,
    world: WORLD,
    players: playerList(room),
    collectibles: room.collectibles,
    leaderboard: leaderboard(room),
    ended: room.ended
  });
}
function endRoomIfComplete(room) {
  if (!room.ended && room.collectibles.length === 0) {
    room.ended = true;
    const final = leaderboard(room);
    final.forEach(p => { allTimeScores[p.username] = Math.max(allTimeScores[p.username] || 0, p.score); });
    saveScores();
    io.to(room.id).emit('game:over', { leaderboard: final, allTime: getAllTimeLeaderboard() });
    emitState(room);
  }
}
function getAllTimeLeaderboard() {
  return Object.entries(allTimeScores).map(([username,score])=>({username,score})).sort((a,b)=>b.score-a.score).slice(0,20);
}

app.get('/api/health', (_req,res) => res.json({ ok:true, rooms:rooms.size }));
app.get('/api/leaderboard', (_req,res) => res.json(getAllTimeLeaderboard()));

io.on('connection', socket => {
  socket.on('room:join', ({ username, roomId='main' } = {}, ack = () => {}) => {
    const room = getRoom(String(roomId).trim().slice(0,30) || 'main');
    if (room.ended) return ack({ok:false,error:'This game is already finished. Start a new room.'});
    const safeName = sanitizeName(username);
    const taken = [...room.players.values()].some(p => p.username.toLowerCase() === safeName.toLowerCase());
    if (taken) return ack({ok:false,error:'Username already exists in this room.'});
    const player = { id:socket.id, username:safeName, x:Math.round(random(60,WORLD.width-60)), y:Math.round(random(60,WORLD.height-60)), score:0, input:{up:false,down:false,left:false,right:false} };
    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.data.roomId = room.id;
    ack({ok:true, roomId:room.id, playerId:socket.id});
    emitState(room);
  });

  socket.on('player:input', input => {
    const room = rooms.get(socket.data.roomId); const p = room?.players.get(socket.id);
    if (!p || room.ended) return;
    p.input = { up:!!input?.up, down:!!input?.down, left:!!input?.left, right:!!input?.right };
  });

  socket.on('game:restart', (_data, ack=()=>{}) => {
    const roomId = socket.data.roomId; if (!roomId) return ack({ok:false});
    const room = createRoom(roomId); ack({ok:true}); emitState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.id); else emitState(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.ended) continue;
    for (const p of room.players.values()) {
      let dx = (p.input.right ? 1:0) - (p.input.left ? 1:0);
      let dy = (p.input.down ? 1:0) - (p.input.up ? 1:0);
      if (dx || dy) { const len=Math.hypot(dx,dy); dx/=len; dy/=len; }
      p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD.width-PLAYER_RADIUS, p.x + dx*PLAYER_SPEED*TICK_MS/1000));
      p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD.height-PLAYER_RADIUS, p.y + dy*PLAYER_SPEED*TICK_MS/1000));
      // Server-authoritative collision: remove exactly once from shared room state.
      for (let i=room.collectibles.length-1;i>=0;i--) {
        if (distance(p, room.collectibles[i]) <= PLAYER_RADIUS + COLLECTIBLE_RADIUS) {
          const [coin] = room.collectibles.splice(i,1);
          p.score += 1;
          allTimeScores[p.username] = Math.max(allTimeScores[p.username] || 0, p.score);
          io.to(room.id).emit('collectible:collected', { collectibleId:coin.id, playerId:p.id, username:p.username, score:p.score });
        }
      }
    }
    emitState(room);
    endRoomIfComplete(room);
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`Game server running on http://localhost:${PORT}`));
