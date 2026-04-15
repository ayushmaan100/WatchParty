// videoPlayer.js
// Wraps the <video> element with our own API.
// WHY: We never want the rest of the app calling video.play() directly.
// All video control goes through this class so Phase 2 sync can intercept it.

class VideoPlayer {
  constructor(elementId, filename) {
    this.video    = document.getElementById(elementId);
    this.filename = filename;
    this.isReady  = false;

    // Event callbacks — Phase 2 will hook into these
    this.onPlay   = null;
    this.onPause  = null;
    this.onSeek   = null;
    this.onReady  = null;
  }

  init() {
    // Set the video source to our streaming endpoint
    this.video.src = `/video/${encodeURIComponent(this.filename)}`;

    // ── Video Events ──────────────────────────────────────────────────────────

    this.video.addEventListener('loadedmetadata', () => {
      this.isReady = true;
      console.log(`[player] Ready. Duration: ${this.video.duration.toFixed(1)}s`);
      if (this.onReady) this.onReady(this.video.duration);
    });

    // We track when play/pause/seek happen so Phase 2 sync can broadcast them.
    // IMPORTANT: We listen to the actual video events (not button clicks)
    // because the user can also use keyboard shortcuts, mobile controls, etc.

    this.video.addEventListener('play', () => {
      console.log(`[player] play @ ${this.video.currentTime.toFixed(3)}s`);
      if (this.onPlay) this.onPlay(this.video.currentTime);
    });

    this.video.addEventListener('pause', () => {
      console.log(`[player] pause @ ${this.video.currentTime.toFixed(3)}s`);
      if (this.onPause) this.onPause(this.video.currentTime);
    });

    this.video.addEventListener('seeked', () => {
      console.log(`[player] seeked to ${this.video.currentTime.toFixed(3)}s`);
      if (this.onSeek) this.onSeek(this.video.currentTime);
    });

    this.video.addEventListener('error', (e) => {
      console.error('[player] Video error:', this.video.error);
    });

    this.video.addEventListener('waiting', () => {
      console.log('[player] Buffering...');
    });

    this.video.addEventListener('canplay', () => {
      console.log('[player] Can play (buffer ready)');
    });

    this.video.addEventListener('timeupdate', () => {
      // Update any UI that shows current time (Phase 2)
    });
  }

  // ── Programmatic controls (used by sync engine in Phase 2) ─────────────────
  // We use _silent variants to avoid feedback loops:
  // sync engine calls play() → 'play' event fires → sync engine broadcasts again → loop
  // Solution: suppress the event callback when WE are the ones triggering the action.

  play(time) {
    if (time !== undefined) this.video.currentTime = time;
    return this.video.play(); // Returns a Promise
  }

  pause(time) {
    if (time !== undefined) this.video.currentTime = time;
    this.video.pause();
  }

  seekTo(time) {
    this.video.currentTime = time;
  }

  getCurrentTime() {
    return this.video.currentTime;
  }

  getDuration() {
    return this.video.duration;
  }

  isPaused() {
    return this.video.paused;
  }
}