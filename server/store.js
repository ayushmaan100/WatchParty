// store.js
// Simple file-based persistence for rooms.
//
// DESIGN: We write the full rooms state to a JSON file on every change.
// On startup, we load it back. This survives server restarts.
//
// WRITE STRATEGY: We use a debounced write — if 10 things change in
// 500ms, we only write once. This prevents hammering the disk during
// a busy sync session.
//
// WHAT WE PERSIST: Room metadata and sync state only.
// We do NOT persist WebSocket connections (can't — they're live objects)
// or member presence (they'll reconnect). On restart, rooms are empty
// but their sync state (currentTime, isPlaying) is preserved.

const fs   = require('fs');
const path = require('path');

const STORE_PATH    = path.join(__dirname, '../data/rooms.json');
const WRITE_DELAY   = 500; // ms — debounce writes

// Ensure the data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let writeTimer = null;

// Load rooms from disk at startup.
// Returns a plain object: { roomId: roomData, ... }
function loadRooms() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      console.log('[store] No store file found. Starting fresh.');
      return {};
    }
    const raw  = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    console.log(`[store] Loaded ${Object.keys(data).length} rooms from disk.`);
    return data;
  } catch (err) {
    console.error('[store] Failed to load store:', err.message);
    console.error('[store] Starting with empty room state.');
    return {};
  }
}

// Serialize rooms Map → plain object → JSON, write to disk.
// Called with the rooms Map from rooms.js.
function saveRooms(roomsMap) {
  // Clear existing debounce timer
  if (writeTimer) clearTimeout(writeTimer);

  writeTimer = setTimeout(() => {
    try {
      const serializable = {};

      for (const [roomId, room] of roomsMap) {
        // Only persist what's useful after a restart.
        // Skip members (live WS connections) and clients.
        serializable[roomId] = {
          id:            room.id,
          mode:          room.mode,
          videoFilename: room.videoFilename,
          youtubeUrl:    room.youtubeUrl,
          videoId:       room.videoId,
          createdAt:     room.createdAt,
          // Persist sync state so late restarts resume at right position
          syncState: {
            isPlaying:   false, // Always start paused after restart
            currentTime: room.syncState.currentTime,
            lastUpdated: Date.now(),
            hostId:      null,  // Will be assigned to first person who rejoins
          },
        };
      }

      // Write atomically: write to temp file first, then rename.
      // This prevents a corrupt store if the process dies mid-write.
      const tmpPath = STORE_PATH + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(serializable, null, 2));
      fs.renameSync(tmpPath, STORE_PATH);

    } catch (err) {
      console.error('[store] Failed to save rooms:', err.message);
    }
  }, WRITE_DELAY);
}

// Delete a specific room from the persisted store.
function deleteRoomFromStore(roomId) {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    delete data[roomId];
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[store] Failed to delete room from store:', err.message);
  }
}

module.exports = { loadRooms, saveRooms, deleteRoomFromStore };