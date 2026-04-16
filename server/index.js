const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const {
  createRoom, getRoom, joinRoom, leaveRoom,
  broadcast, getMemberList, applySync,
} = require('./rooms');
const { getVirtualTime } = require('./syncEngine');

const app    = express();
const server = http.createServer(app); // HTTP server wraps Express
const wss    = new WebSocketServer({ server }); // WebSocket on SAME port

const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ─── REST API (unchanged from Phase 1) ────────────────────────────────────────
app.get('/api/videos', (req, res) => {
  const uploadsDir = path.join(__dirname, '../uploads');
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));
    res.json({ videos: files });
  } catch { res.json({ videos: [] }); }
});

app.post('/api/rooms', (req, res) => {
  const { videoFilename } = req.body;
  if (!videoFilename) return res.status(400).json({ error: 'videoFilename is required' });
  const videoPath = path.join(__dirname, '../uploads', videoFilename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: `Video not found: ${videoFilename}` });
  const room = createRoom(videoFilename);
  res.json({ roomId: room.id, videoFilename: room.videoFilename });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ id: room.id, videoFilename: room.videoFilename, memberCount: room.members.size });
});

// ─── Video Streaming (unchanged from Phase 1) ─────────────────────────────────
app.get('/video/:filename', (req, res) => {
  const filename  = path.basename(req.params.filename);
  const videoPath = path.join(__dirname, '../uploads', filename);
  if (!fs.existsSync(videoPath)) return res.status(404).send('Video not found');

  const stat     = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range    = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
    fs.createReadStream(videoPath).pipe(res);
    return;
  }

  const parts     = range.replace(/bytes=/, '').split('-');
  const start     = parseInt(parts[0], 10);
  const CHUNK     = 1 * 1024 * 1024;
  const end       = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK - 1, fileSize - 1);

  if (start >= fileSize) return res.status(416).send('Range Not Satisfiable');

  const chunkSize = end - start + 1;
  const stream    = fs.createReadStream(videoPath, { start, end });

  res.writeHead(206, {
    'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Content-Length': chunkSize,
    'Content-Type':   'video/mp4',
  });

  stream.pipe(res);
  stream.on('error', () => res.end());
});

// ─── WebSocket Server ──────────────────────────────────────────────────────────
//
// Connection lifecycle:
//  1. Client connects → we get a raw ws object, no room info yet
//  2. Client sends JOIN → we register them in the room
//  3. Client sends PLAY/PAUSE/SEEK → we update state, broadcast to room
//  4. Client disconnects → we remove from room, notify others

wss.on('connection', (ws) => {
  // State attached to this specific connection
  ws._userId   = uuidv4().slice(0, 8);
  ws._roomId   = null;
  ws._username = null;

  console.log(`[ws] New connection: ${ws._userId}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'ERROR', message: 'Invalid JSON' });
    }

    handle(ws, msg);
  });

  ws.on('close', () => {
    if (!ws._roomId) return;

    leaveRoom(ws._roomId, ws._userId);

    const room = getRoom(ws._roomId);
    if (room) {
      broadcast(ws._roomId, {
        type:      'MEMBER_UPDATE',
        members:   getMemberList(room),
        count:     room.members.size,
      });

      // Announce departure in chat
      broadcast(ws._roomId, {
        type:     'CHAT',
        system:   true,
        text:     `${ws._username} left the room.`,
        ts:       Date.now(),
      });

      for (const [uid, member] of room.members) {
        send(member.ws, {
          type:   'CALL_HANGUP',
          fromId: ws._userId,
        });
      }

    }

    console.log(`[ws] ${ws._username} (${ws._userId}) disconnected`);
  });

  ws.on('error', (err) => {
    console.error(`[ws] Error from ${ws._userId}:`, err.message);
  });
});

function handle(ws, msg) {
  switch (msg.type) {

    // ── JOIN ────────────────────────────────────────────────────────────────
    case 'JOIN': {
      const { roomId, username } = msg;
      if (!roomId || !username) {
        return send(ws, { type: 'ERROR', message: 'JOIN requires roomId and username' });
      }

      const room = joinRoom(roomId, ws._userId, ws, username.slice(0, 24));
      if (!room) {
        return send(ws, { type: 'ERROR', message: 'Room not found' });
      }

      ws._roomId   = roomId;
      ws._username = username.slice(0, 24);

      // Send this client the current room state immediately
      // This is how a late-joiner syncs: they get the "virtual time" —
      // the position the video should be at RIGHT NOW if it's been playing.
      const virtualTime = getVirtualTime(room.syncState);

      send(ws, {
        type:          'ROOM_STATE',
        roomId,
        videoFilename: room.videoFilename,
        userId:        ws._userId,
        isHost:        room.syncState.hostId === ws._userId,
        syncState: {
          isPlaying:   room.syncState.isPlaying,
          currentTime: virtualTime,
          hostId:      room.syncState.hostId,
        },
        members: getMemberList(room),
      });

      // Notify everyone else
      broadcast(roomId, {
        type:    'MEMBER_UPDATE',
        members: getMemberList(room),
        count:   room.members.size,
      }, ws._userId); // exclude the joiner — they already got ROOM_STATE

      // Announce in chat
      broadcast(roomId, {
        type:   'CHAT',
        system: true,
        text:   `${ws._username} joined the room.`,
        ts:     Date.now(),
      });

      console.log(`[ws] ${ws._username} joined room ${roomId}`);
      break;
    }

    // ── PLAY ────────────────────────────────────────────────────────────────
    case 'PLAY': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'PLAY', msg.time);

      broadcast(ws._roomId, {
        type:       'PLAY',
        time:       updated.currentTime,
        serverTs:   updated.serverTs,
        fromUserId: ws._userId,
        username:   ws._username,
      });

      console.log(`[sync] PLAY @ ${msg.time.toFixed(2)}s in room ${ws._roomId}`);
      break;
    }

    // ── PAUSE ───────────────────────────────────────────────────────────────
    case 'PAUSE': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'PAUSE', msg.time);

      broadcast(ws._roomId, {
        type:       'PAUSE',
        time:       updated.currentTime,
        serverTs:   updated.serverTs,
        fromUserId: ws._userId,
        username:   ws._username,
      });

      console.log(`[sync] PAUSE @ ${msg.time.toFixed(2)}s in room ${ws._roomId}`);
      break;
    }

    // ── SEEK ────────────────────────────────────────────────────────────────
    case 'SEEK': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'SEEK', msg.time);

      broadcast(ws._roomId, {
        type:       'SEEK',
        time:       updated.currentTime,
        serverTs:   updated.serverTs,
        fromUserId: ws._userId,
        username:   ws._username,
      });

      console.log(`[sync] SEEK → ${msg.time.toFixed(2)}s in room ${ws._roomId}`);
      break;
    }

    // ── CHAT ────────────────────────────────────────────────────────────────
    case 'CHAT': {
      if (!ws._roomId || !msg.text) return;
      const text = msg.text.trim().slice(0, 500); // Limit message length
      if (!text) return;

      broadcast(ws._roomId, {
        type:     'CHAT',
        text,
        userId:   ws._userId,
        username: ws._username,
        ts:       Date.now(),
        system:   false,
      });
      break;
    }

    // ── CALL_OFFER ──────────────────────────────────────────────────────────
    // User A wants to call User B. Forward the SDP offer to B.
    case 'CALL_OFFER': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const target = room.members.get(msg.targetId);
      if (!target) {
        return send(ws, { type: 'ERROR', message: `User ${msg.targetId} not found` });
      }

      send(target.ws, {
        type:     'CALL_OFFER',
        fromId:   ws._userId,
        username: ws._username,
        sdp:      msg.sdp,
      });

      console.log(`[rtc] OFFER: ${ws._userId} → ${msg.targetId}`);
      break;
    }

    // ── CALL_ANSWER ─────────────────────────────────────────────────────────
    case 'CALL_ANSWER': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const target = room.members.get(msg.targetId);
      if (!target) return;

      send(target.ws, {
        type:   'CALL_ANSWER',
        fromId: ws._userId,
        sdp:    msg.sdp,
      });

      console.log(`[rtc] ANSWER: ${ws._userId} → ${msg.targetId}`);
      break;
    }

    // ── ICE_CANDIDATE ────────────────────────────────────────────────────────
    case 'ICE_CANDIDATE': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const target = room.members.get(msg.targetId);
      if (!target) return;

      send(target.ws, {
        type:      'ICE_CANDIDATE',
        fromId:    ws._userId,
        candidate: msg.candidate,
      });
      break;
    }

    // ── CALL_HANGUP ──────────────────────────────────────────────────────────
    case 'CALL_HANGUP': {
      if (!ws._roomId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const target = room.members.get(msg.targetId);
      if (!target) return;

      send(target.ws, {
        type:   'CALL_HANGUP',
        fromId: ws._userId,
      });

      console.log(`[rtc] HANGUP: ${ws._userId} → ${msg.targetId}`);
      break;
    }

    default:
      send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
  }
}

// Helper: send to a single client safely
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   WatchParty Server — Phase 2        ║
║   http://localhost:${PORT}              ║
║   WebSocket on same port ✓           ║
╚══════════════════════════════════════╝
  `);
});