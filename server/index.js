const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { createRoom, getRoom, listRooms } = require('./rooms');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

// Serve all client-side files (HTML, CSS, JS) from the /client directory
app.use(express.static(path.join(__dirname, '../client')));

// ─── API: List available videos ────────────────────────────────────────────────
// The frontend needs to know which videos have been uploaded so users can
// pick one when creating a room.

app.get('/api/videos', (req, res) => {
  const uploadsDir = path.join(__dirname, '../uploads');
  
  try {
    const files = fs.readdirSync(uploadsDir).filter(f => {
      // Only show common video formats
      return /\.(mp4|mkv|webm|mov|avi)$/i.test(f);
    });
    res.json({ videos: files });
  } catch (err) {
    res.json({ videos: [] });
  }
});

// ─── API: Create a room ────────────────────────────────────────────────────────

app.post('/api/rooms', (req, res) => {
  const { videoFilename } = req.body;

  if (!videoFilename) {
    return res.status(400).json({ error: 'videoFilename is required' });
  }

  // Validate the file actually exists — never trust client input
  const videoPath = path.join(__dirname, '../uploads', videoFilename);
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: `Video file not found: ${videoFilename}` });
  }

  const room = createRoom(videoFilename);
  res.json({ roomId: room.id, videoFilename: room.videoFilename });
});

// ─── API: Get room info ────────────────────────────────────────────────────────

app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    id: room.id,
    videoFilename: room.videoFilename,
    memberCount: room.clients.size,
  });
});

// ─── VIDEO STREAMING — THE CRITICAL PART ──────────────────────────────────────
//
// WHY THIS IS COMPLEX:
// Browsers don't download the full video. They send HTTP Range requests:
//   "Give me bytes 0–65535 of this file"
// Then later: "Give me bytes 65536–131071"
// This is how seeking works. If we just send the whole file, seeking breaks.
//
// We must:
//   1. Read the Range header from the request
//   2. Stream ONLY that byte range from the file
//   3. Return HTTP 206 (Partial Content), NOT 200
//   4. Set the correct Content-Range header so the browser knows total size
//
// If we skip any of these steps, the video will not seek, will stall, or
// will crash the server with a 5GB file loaded into RAM.

app.get('/video/:filename', (req, res) => {
  const filename  = path.basename(req.params.filename); // Sanitize: no ../ tricks
  const videoPath = path.join(__dirname, '../uploads', filename);

  // Check file exists
  if (!fs.existsSync(videoPath)) {
    return res.status(404).send('Video not found');
  }

  const stat     = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range    = req.headers.range;

  if (!range) {
    // No Range header — browser is just probing the file or doesn't support it.
    // Return full file with 200. This shouldn't happen for video playback,
    // but we handle it gracefully.
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   'video/mp4',
    });
    fs.createReadStream(videoPath).pipe(res);
    return;
  }

  // Parse the Range header: "bytes=START-END"
  // END is optional — if absent, we send from START to end of file
  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  
  // If browser didn't specify end, send a 1MB chunk.
  // Sending the rest of the file would buffer too much.
  const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB
  const end   = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK_SIZE - 1, fileSize - 1);

  if (start >= fileSize) {
    // Requested range is beyond the file — invalid range
    res.status(416).send('Requested Range Not Satisfiable');
    return;
  }

  const chunkSize = end - start + 1;

  console.log(`[video] ${filename} → bytes ${start}-${end}/${fileSize} (${(chunkSize/1024).toFixed(1)}KB)`);

  // Stream only this slice of the file — no RAM spike, no blocking
  const fileStream = fs.createReadStream(videoPath, { start, end });

  res.writeHead(206, {
    'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Content-Length': chunkSize,
    'Content-Type':   'video/mp4',
  });

  fileStream.pipe(res);

  // Handle errors mid-stream (e.g., client disconnects)
  fileStream.on('error', (err) => {
    console.error(`[video] Stream error: ${err.message}`);
    res.end();
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   WatchParty Server running          ║
║   http://localhost:${PORT}           ║
║                                      ║
║   Put video files in /uploads/       ║
╚══════════════════════════════════════╝
  `);
});