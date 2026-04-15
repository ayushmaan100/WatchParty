// rooms.js — In-memory room state
// A "room" knows: who's in it, what video is playing, current sync state.
// In Phase 2, we'll add sync state. For now: just membership.

const { v4: uuidv4 } = require('uuid');

// rooms is a Map: roomId → roomObject
const rooms = new Map();

function createRoom(videoFilename) {
  const roomId = uuidv4().slice(0, 8); // Short 8-char ID, easier to share
  
  const room = {
    id: roomId,
    videoFilename,          // e.g. "movie.mp4"
    createdAt: Date.now(),
    clients: new Set(),     // Will hold WebSocket connections in Phase 2
    
    // Sync state — populated in Phase 2
    syncState: {
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now(),
    }
  };
  
  rooms.set(roomId, room);
  console.log(`[rooms] Created room ${roomId} for video: ${videoFilename}`);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function listRooms() {
  // Returns array of room summaries (not full objects — don't expose WS clients)
  return Array.from(rooms.values()).map(r => ({
    id: r.id,
    videoFilename: r.videoFilename,
    createdAt: r.createdAt,
    memberCount: r.clients.size,
  }));
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
  console.log(`[rooms] Deleted room ${roomId}`);
}

module.exports = { createRoom, getRoom, listRooms, deleteRoom };