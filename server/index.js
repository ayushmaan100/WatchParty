// index.js — Phase 6: Hardened
const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const helmet     = require('helmet');
const morgan     = require('morgan');

const {
  createRoom, getRoom, joinRoom, leaveRoom,
  broadcast, getMemberList, applySync, getRoomStats,
} = require('./rooms');
const { getVirtualTime }            = require('./syncEngine');
const { handleUpload, getUploadStats } = require('./upload');
const { generalLimiter, createRoomLimiter, uploadLimiter } = require('./rateLimit');
const { createConnectionLimiter }   = require('./wsRateLimit');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

// ─── Security & Logging ────────────────────────────────────────────────────────

// helmet sets 17 security-related HTTP headers automatically.
// We need to configure it to allow YouTube iframes.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      frameSrc:    ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc:  ["'self'", 'wss:', 'ws:'],
      mediaSrc:    ["'self'", 'blob:'],
      imgSrc:      ["'self'", 'data:', 'https://i.ytimg.com'],
      styleSrc:    ["'self'", "'unsafe-inline'"],
    },
  },
  // Allow the app to be embedded during local development
  crossOriginEmbedderPolicy: false,
}));

// HTTP request logging
app.use(morgan('[:date[clf]] :method :url :status :res[content-length] - :response-time ms'));

app.use(express.json({ limit: '10kb' })); // Prevent huge JSON body attacks
app.use(express.static(path.join(__dirname, '../client')));

// Apply general rate limiter to all API routes
app.use('/api', generalLimiter);

// ─── Health Check ──────────────────────────────────────────────────────────────
// Useful for monitoring services (UptimeRobot, etc.) to ping
app.get('/health', (req, res) => {
  const stats = getRoomStats();
  res.json({
    status:  'ok',
    uptime:  process.uptime(),
    memory:  process.memoryUsage(),
    rooms:   stats.totalRooms,
    members: stats.totalMembers,
  });
});

// ─── Video List ────────────────────────────────────────────────────────────────
app.get('/api/videos', (req, res) => {
  const { files } = getUploadStats();
  res.json({ videos: files.map(f => f.name) });
});

// ─── File Upload ───────────────────────────────────────────────────────────────
app.post('/api/upload', uploadLimiter, handleUpload, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file received.' });
  }

  console.log(`[upload] File saved: ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

  res.json({
    filename: req.file.filename,
    size:     req.file.size,
    message:  'Upload successful',
  });
});

// Upload progress tracking endpoint (polled by client)
app.get('/api/upload/stats', (req, res) => {
  res.json(getUploadStats());
});

// ─── Room Management ───────────────────────────────────────────────────────────
app.post('/api/rooms', createRoomLimiter, (req, res) => {
  const { videoFilename, youtubeUrl } = req.body;

  if (!videoFilename && !youtubeUrl) {
    return res.status(400).json({ error: 'Provide videoFilename or youtubeUrl' });
  }
  if (videoFilename && youtubeUrl) {
    return res.status(400).json({ error: 'Provide only one source' });
  }

  if (videoFilename) {
    // Sanitize: no path traversal
    const safe = path.basename(videoFilename);
    const videoPath = path.join(__dirname, '../uploads', safe);
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: `Video not found: ${safe}` });
    }
  }

  const room = createRoom(videoFilename || null, youtubeUrl || null);
  if (!room) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }

  res.json({
    roomId:        room.id,
    mode:          room.mode,
    videoFilename: room.videoFilename,
    youtubeUrl:    room.youtubeUrl,
    videoId:       room.videoId,
  });
});

app.get('/api/rooms/:roomId', (req, res) => {
  // Validate roomId format (8 alphanumeric chars)
  if (!/^[a-f0-9\-]{8}$/.test(req.params.roomId)) {
    return res.status(400).json({ error: 'Invalid room ID format' });
  }

  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  res.json({
    id:            room.id,
    mode:          room.mode,
    videoFilename: room.videoFilename,
    youtubeUrl:    room.youtubeUrl,
    videoId:       room.videoId,
    memberCount:   room.members.size,
  });
});

// ─── Video Streaming ───────────────────────────────────────────────────────────
app.get('/video/:filename', (req, res) => {
  // Sanitize — prevent path traversal attacks
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

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const CHUNK = 1 * 1024 * 1024;
  const end   = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK - 1, fileSize - 1);

  if (start >= fileSize || start < 0) {
    return res.status(416).send('Range Not Satisfiable');
  }

  const chunkSize = end - start + 1;
  const stream    = fs.createReadStream(videoPath, { start, end });

  res.writeHead(206, {
    'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Content-Length': chunkSize,
    'Content-Type':   'video/mp4',
  });

  stream.pipe(res);
  stream.on('error', (err) => {
    console.error('[video] Stream error:', err.message);
    res.end();
  });
});

// ─── WebSocket Server ──────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws._userId   = uuidv4().slice(0, 8);
  ws._roomId   = null;
  ws._username = null;
  ws._limiter  = createConnectionLimiter(); // Per-connection rate limiter
  ws._ip       = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  console.log(`[ws] Connection from ${ws._ip} (${ws._userId})`);

  ws.on('message', (raw) => {
    // ── Rate limit check ──────────────────────────────────────────────────
    if (!ws._limiter.consume()) {
      send(ws, { type: 'ERROR', message: 'Rate limit exceeded. Slow down.' });
      console.warn(`[ws] Rate limited: ${ws._userId}`);
      return;
    }

    // ── Size check: reject absurdly large messages ─────────────────────────
    if (raw.length > 8192) { // 8KB max per message
      send(ws, { type: 'ERROR', message: 'Message too large.' });
      return;
    }

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
      // Notify call peers of disconnect
      for (const [uid, member] of room.members) {
        send(member.ws, { type: 'CALL_HANGUP', fromId: ws._userId });
      }

      broadcast(ws._roomId, {
        type:    'MEMBER_UPDATE',
        members: getMemberList(room),
        count:   room.members.size,
      });

      broadcast(ws._roomId, {
        type:   'CHAT',
        system: true,
        text:   `${ws._username} left the room.`,
        ts:     Date.now(),
      });
    }

    console.log(`[ws] ${ws._username} (${ws._userId}) disconnected`);
  });

  ws.on('error', (err) => {
    // Swallow ECONNRESET — client closed browser tab
    if (err.code !== 'ECONNRESET') {
      console.error(`[ws] Error (${ws._userId}):`, err.message);
    }
  });
});

function handle(ws, msg) {
  switch (msg.type) {

    case 'JOIN': {
      const { roomId, username } = msg;

      if (!roomId || !username) {
        return send(ws, { type: 'ERROR', message: 'JOIN requires roomId and username' });
      }

      // Validate roomId format
      if (!/^[a-f0-9\-]{8}$/.test(roomId)) {
        return send(ws, { type: 'ERROR', message: 'Invalid room ID' });
      }

      // Sanitize username
      const cleanUsername = String(username)
        .replace(/[<>&"']/g, '') // Strip HTML chars
        .trim()
        .slice(0, 24);

      if (!cleanUsername) {
        return send(ws, { type: 'ERROR', message: 'Invalid username' });
      }

      const room = joinRoom(roomId, ws._userId, ws, cleanUsername);
      if (!room) {
        return send(ws, { type: 'ERROR', message: 'Room not found' });
      }

      ws._roomId   = roomId;
      ws._username = cleanUsername;

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

      broadcast(roomId, {
        type:    'MEMBER_UPDATE',
        members: getMemberList(room),
        count:   room.members.size,
      }, ws._userId);

      broadcast(roomId, {
        type: 'CHAT', system: true,
        text: `${cleanUsername} joined.`, ts: Date.now(),
      });

      console.log(`[ws] ${cleanUsername} joined room ${roomId}`);
      break;
    }

    case 'PLAY': {
      if (!ws._roomId) return;
      if (typeof msg.time !== 'number' || msg.time < 0) return;

      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'PLAY', msg.time);
      broadcast(ws._roomId, {
        type: 'PLAY', time: updated.currentTime,
        serverTs: updated.serverTs, fromUserId: ws._userId, username: ws._username,
      });
      break;
    }

    case 'PAUSE': {
      if (!ws._roomId) return;
      if (typeof msg.time !== 'number' || msg.time < 0) return;

      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'PAUSE', msg.time);
      broadcast(ws._roomId, {
        type: 'PAUSE', time: updated.currentTime,
        serverTs: updated.serverTs, fromUserId: ws._userId, username: ws._username,
      });
      break;
    }

    case 'SEEK': {
      if (!ws._roomId) return;
      if (typeof msg.time !== 'number' || msg.time < 0) return;

      const room = getRoom(ws._roomId);
      if (!room) return;

      const updated = applySync(room, 'SEEK', msg.time);
      broadcast(ws._roomId, {
        type: 'SEEK', time: updated.currentTime,
        serverTs: updated.serverTs, fromUserId: ws._userId, username: ws._username,
      });
      break;
    }

    case 'CHAT': {
      if (!ws._roomId || !msg.text) return;
      const text = String(msg.text).trim().slice(0, 500);
      if (!text) return;
      broadcast(ws._roomId, {
        type: 'CHAT', text,
        userId: ws._userId, username: ws._username,
        ts: Date.now(), system: false,
      });
      break;
    }

    // ── WebRTC signaling ───────────────────────────────────────────────────
    case 'CALL_OFFER':
    case 'CALL_ANSWER':
    case 'CALL_HANGUP':
    case 'ICE_CANDIDATE': {
      if (!ws._roomId || !msg.targetId) return;
      const room = getRoom(ws._roomId);
      if (!room) return;

      const target = room.members.get(msg.targetId);
      if (!target) return;

      // Forward with sender info — don't trust client-provided fromId
      const forwardMsg = { ...msg, fromId: ws._userId };
      if (msg.type === 'CALL_OFFER') forwardMsg.username = ws._username;
      delete forwardMsg.targetId; // Don't leak target routing info

      send(target.ws, forwardMsg);
      break;
    }

    default:
      send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Process-level error handling ─────────────────────────────────────────────
// Without these, a single uncaught error kills the entire server.

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Don't exit — log and continue. In production, pair with PM2
  // which will restart the process on actual fatal errors.
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

// Graceful shutdown — save state before exit
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('[server] HTTP server closed.');
    process.exit(0);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const stats = getRoomStats();
  console.log(`
╔══════════════════════════════════════════╗
║   WatchParty Server — Phase 6 Hardened  ║
║   http://localhost:${PORT}                  ║
║   Rooms loaded from disk: ${stats.totalRooms}             ║
╚══════════════════════════════════════════╝
  `);
});