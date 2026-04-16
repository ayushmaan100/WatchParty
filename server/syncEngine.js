// syncEngine.js
// Pure functions for managing room sync state.
// No WebSocket code here — just state logic. Easier to test.

function getVirtualTime(syncState) {
  // Calculate where the video "should be" right now based on stored state.
  if (!syncState.isPlaying) {
    return syncState.currentTime;
  }
  const elapsed = (Date.now() - syncState.lastUpdated) / 1000;
  return syncState.currentTime + elapsed;
}

function applyPlay(syncState, time, serverTs) {
  return {
    ...syncState,
    isPlaying:   true,
    currentTime: time,
    lastUpdated: serverTs,
  };
}

function applyPause(syncState, time, serverTs) {
  return {
    ...syncState,
    isPlaying:   false,
    currentTime: time,
    lastUpdated: serverTs,
  };
}

function applySeek(syncState, time, serverTs) {
  return {
    ...syncState,
    // Keep isPlaying as-is — seek doesn't change play state
    currentTime: time,
    lastUpdated: serverTs,
  };
}

module.exports = { getVirtualTime, applyPlay, applyPause, applySeek };