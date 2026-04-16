// rooms.js — Phase 6: with persistence and memory management
const { v4: uuidv4 } = require('uuid');
const { getVirtualTime, applyPlay, applyPause, applySeek } = require('./syncEngine');
const { loadRooms, saveRooms, deleteRoomFromStore } = require('./store');

// ── Room expiry configuration ──────────────────────────────────────────────
const ROOM_EXPIRY_MS       = 24 * 60 * 60 * 1000; // 24 hours
const EMPTY_ROOM_TTL_MS    =  2 * 60 * 60 * 1000; //  2 hours after last member leaves
const CLEANUP_INTERVAL_MS  = 30 * 60 * 1000;       // Run cleanup every 30 minutes

// ── Bootstrap: load persisted rooms on startup ─────────────────────────────
const rooms = new Map();

const persisted = loadRooms();
for (const [roomId, data] of Object.entries(persisted)) {
  // Reconstruct room objects from stored data
  // members Map starts empty — people will reconnect via WebSocket
  rooms.set(roomId, {
    ...data,
    members:    new Map(),
    _emptyAt:   Date.now(), // Mark as empty until someone joins
  });
}

// ── Room lifecycle ─────────────────────────────────────────────────────────

function createRoom(videoFilename, youtubeUrl) {
  const roomId = uuidv4().slice(0, 8);

  let mode    = 'local';
  let videoId = null;

  if (youtubeUrl) {
    mode    = 'youtube';
    videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) return null;
  }

  const room = {
    id:            roomId,
    mode,
    videoFilename: videoFilename || null,
    youtubeUrl:    youtubeUrl    || null,
    videoId:       videoId       || null,
    createdAt:     Date.now(),
    members:       new Map(),
    _emptyAt:      Date.now(),
    syncState: {
      isPlaying:   false,
      currentTime: 0,
      lastUpdated: Date.now(),
      hostId:      null,
    },
  };

  rooms.set(roomId, room);
  saveRooms(rooms); // Persist immediately on creation
  console.log(`[rooms] Created room ${roomId} [${mode}]`);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function joinRoom(roomId, userId, ws, username) {
  const room = getRoom(roomId);
  if (!room) return null;

  if (room.members.size === 0) {
    room.syncState.hostId = userId;
  }

  room.members.set(userId, { ws, username, joinedAt: Date.now() });
  room._emptyAt = null; // Room is no longer empty
  console.log(`[rooms] ${username} joined ${roomId}. Members: ${room.members.size}`);
  return room;
}

function leaveRoom(roomId, userId) {
  const room = getRoom(roomId);
  if (!room) return;

  room.members.delete(userId);

  if (room.syncState.hostId === userId && room.members.size > 0) {
    room.syncState.hostId = room.members.keys().next().value;
    console.log(`[rooms] Host transferred to ${room.syncState.hostId}`);
  }

  if (room.members.size === 0) {
    room._emptyAt = Date.now();
    console.log(`[rooms] Room ${roomId} is now empty.`);
    // Persist current time so it's available when room is resumed
    saveRooms(rooms);
  }
}

function broadcast(roomId, message, excludeUserId = null) {
  const room = getRoom(roomId);
  if (!room) return 0;

  const json = JSON.stringify(message);
  let sent   = 0;

  for (const [uid, member] of room.members) {
    if (uid === excludeUserId) continue;
    if (member.ws.readyState !== 1) continue; // 1 = OPEN
    try {
      member.ws.send(json);
      sent++;
    } catch (err) {
      console.error(`[rooms] Send failed to ${uid}:`, err.message);
    }
  }
  return sent;
}

function getMemberList(room) {
  return Array.from(room.members.entries()).map(([uid, m]) => ({
    userId:   uid,
    username: m.username,
    isHost:   uid === room.syncState.hostId,
  }));
}

function applySync(room, type, time) {
  const serverTs = Date.now();
  if (type === 'PLAY')  room.syncState = applyPlay(room.syncState, time, serverTs);
  if (type === 'PAUSE') room.syncState = applyPause(room.syncState, time, serverTs);
  if (type === 'SEEK')  room.syncState = applySeek(room.syncState, time, serverTs);

  // Persist sync state changes (debounced — won't hammer disk)
  saveRooms(rooms);

  return { ...room.syncState, serverTs };
}

// ── Memory management: periodic cleanup ───────────────────────────────────
// This is the key to preventing memory leaks.
// We remove rooms that are:
//   1. Older than 24 hours (regardless of activity)
//   2. Empty for more than 2 hours

function cleanupRooms() {
  const now     = Date.now();
  let   removed = 0;

  for (const [roomId, room] of rooms) {
    const age          = now - room.createdAt;
    const emptyFor     = room._emptyAt ? now - room._emptyAt : 0;
    const isExpired    = age > ROOM_EXPIRY_MS;
    const isStaleEmpty = room.members.size === 0 && emptyFor > EMPTY_ROOM_TTL_MS;

    if (isExpired || isStaleEmpty) {
      // Close any stale WebSocket connections still in the map
      for (const [, member] of room.members) {
        try { member.ws.close(); } catch {}
      }
      rooms.delete(roomId);
      deleteRoomFromStore(roomId);
      removed++;

      const reason = isExpired ? 'expired (24h)' : 'empty (2h)';
      console.log(`[rooms] Removed room ${roomId}: ${reason}`);
    }
  }

  if (removed > 0) {
    console.log(`[rooms] Cleanup: removed ${removed} room(s). Active: ${rooms.size}`);
  }
}

// Run cleanup on a schedule
setInterval(cleanupRooms, CLEANUP_INTERVAL_MS);
// Also run once on startup to clean up any stale rooms from the store
setTimeout(cleanupRooms, 5000);

// ── Utilities ──────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  try {
    const patterns = [
      /(?:v=)([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /embed\/([a-zA-Z0-9_-]{11})/,
      /shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  } catch { return null; }
}

function getRoomStats() {
  let totalMembers = 0;
  for (const room of rooms.values()) totalMembers += room.members.size;
  return { totalRooms: rooms.size, totalMembers };
}

module.exports = {
  createRoom, getRoom, joinRoom, leaveRoom,
  broadcast, getMemberList, applySync,
  extractYouTubeId, getRoomStats,
};