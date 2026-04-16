// rooms.js — updated for Phase 2
const { v4: uuidv4 } = require('uuid');
const { getVirtualTime, applyPlay, applyPause, applySeek } = require('./syncEngine');

const rooms = new Map();

function createRoom(videoFilename) {
  const roomId = uuidv4().slice(0, 8);
  const room = {
    id: roomId,
    videoFilename,
    createdAt: Date.now(),

    // Map of userId → { ws, username, joinedAt }
    members: new Map(),

    syncState: {
      isPlaying:   false,
      currentTime: 0,
      lastUpdated: Date.now(),
      hostId:      null,
    },
  };
  rooms.set(roomId, room);
  console.log(`[rooms] Created room ${roomId} → ${videoFilename}`);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

// Add a WebSocket client to a room
function joinRoom(roomId, userId, ws, username) {
  const room = getRoom(roomId);
  if (!room) return null;

  // First member becomes host
  if (room.members.size === 0) {
    room.syncState.hostId = userId;
    console.log(`[rooms] ${userId} is host of ${roomId}`);
  }

  room.members.set(userId, { ws, username, joinedAt: Date.now() });
  console.log(`[rooms] ${username} (${userId}) joined room ${roomId}. Members: ${room.members.size}`);
  return room;
}

function leaveRoom(roomId, userId) {
  const room = getRoom(roomId);
  if (!room) return;

  const member = room.members.get(userId);
  room.members.delete(userId);
  console.log(`[rooms] ${userId} left room ${roomId}. Members: ${room.members.size}`);

  // If host left, assign next host
  if (room.syncState.hostId === userId && room.members.size > 0) {
    const nextHostId = room.members.keys().next().value;
    room.syncState.hostId = nextHostId;
    console.log(`[rooms] New host: ${nextHostId}`);
  }

  // Optionally clean up empty rooms
  if (room.members.size === 0) {
    // Keep room alive for 10 minutes in case they reconnect
    setTimeout(() => {
      if (rooms.has(roomId) && rooms.get(roomId).members.size === 0) {
        rooms.delete(roomId);
        console.log(`[rooms] Cleaned up empty room ${roomId}`);
      }
    }, 10 * 60 * 1000);
  }
}

// Broadcast a message to all members of a room except optional excludeId
function broadcast(roomId, message, excludeUserId = null) {
  const room = getRoom(roomId);
  if (!room) return;

  const json = JSON.stringify(message);
  let sent = 0;

  for (const [uid, member] of room.members) {
    if (uid === excludeUserId) continue;
    // Only send to open connections (2 = OPEN in WebSocket spec)
    if (member.ws.readyState === 2 || member.ws.readyState === 3) continue;
    try {
      member.ws.send(json);
      sent++;
    } catch (err) {
      console.error(`[rooms] Failed to send to ${uid}:`, err.message);
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

// Apply a sync event and return the updated state
function applySync(room, type, time) {
  const serverTs = Date.now();
  if (type === 'PLAY')  room.syncState = applyPlay(room.syncState, time, serverTs);
  if (type === 'PAUSE') room.syncState = applyPause(room.syncState, time, serverTs);
  if (type === 'SEEK')  room.syncState = applySeek(room.syncState, time, serverTs);
  return { ...room.syncState, serverTs };
}

module.exports = {
  createRoom, getRoom, joinRoom, leaveRoom,
  broadcast, getMemberList, applySync, getVirtualTime,
};