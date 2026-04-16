// youtubePlayer.js
//
// Wraps the YouTube IFrame API to match VideoPlayer's interface exactly.
// The sync engine (syncClient.js) calls the same methods on both classes
// and never knows the difference.
//
// YOUTUBE API LOADING:
// The YouTube IFrame API loads asynchronously by injecting a <script> tag.
// When ready, it calls window.onYouTubeIframeAPIReady globally. We handle
// this with a Promise so we can await it cleanly.
//
// SEEK DETECTION:
// YouTube has no 'seeked' event. We detect seeks by polling getCurrentTime()
// every 500ms and comparing to expected position. If the gap is > 1.5s and
// we didn't trigger it, we broadcast a SEEK event.
//
// BUFFERING GUARD:
// YouTube fires PAUSED state during buffering. We ignore PAUSED events that
// occur within 2s of a buffering state to avoid false pause broadcasts.

class YouTubePlayer {
  constructor(containerId, videoId) {
    this.containerId = containerId;
    this.videoId     = videoId;
    this.player      = null;  // YT.Player instance
    this.isReady     = false;

    // Interface — same as VideoPlayer
    this.onPlay   = null;
    this.onPause  = null;
    this.onSeek   = null;
    this.onReady  = null;

    // Internal state
    this._lastKnownTime    = 0;
    this._isPlaying        = false;
    this._suppressPlay     = false;
    this._suppressPause    = false;
    this._suppressSeek     = false;
    this._isBuffering      = false;
    this._bufferEndedAt    = 0;
    this._seekPollInterval = null;
    this._seekDebounceTimer = null;

    // YouTube state constants (from YT API docs)
    this.YT_STATES = {
      UNSTARTED: -1,
      ENDED:      0,
      PLAYING:    1,
      PAUSED:     2,
      BUFFERING:  3,
      CUED:       5,
    };
  }

  // ── Load the YouTube IFrame API and create the player ─────────────────────
  async init() {
    await this._loadYouTubeAPI();
    this._createPlayer();
  }

  _loadYouTubeAPI() {
    // If already loaded, resolve immediately
    if (window.YT && window.YT.Player) return Promise.resolve();

    return new Promise((resolve) => {
      // YouTube API calls this global function when ready
      const existing = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (existing) existing();
        resolve();
      };

      // Only inject the script if not already injected
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src   = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(script);
      }
    });
  }

  _createPlayer() {
    this.player = new YT.Player(this.containerId, {
      videoId: this.videoId,
      width:   '100%',
      height:  '100%',
      playerVars: {
        // Disable autoplay — sync engine controls when to play
        autoplay:       0,
        // Allow seeking to any position
        start:          0,
        // Clean UI — hide YouTube branding where possible
        rel:            0,   // Don't show related videos
        modestbranding: 1,   // Minimal YouTube logo
        // These are required for the API to work in iframes
        enablejsapi:    1,
        origin:         window.location.origin,
      },
      events: {
        onReady:       (e) => this._onReady(e),
        onStateChange: (e) => this._onStateChange(e),
        onError:       (e) => this._onError(e),
      },
    });
  }

  _onReady() {
    this.isReady = true;
    console.log('[yt] Player ready. Duration:', this.player.getDuration());
    if (this.onReady) this.onReady(this.player.getDuration());

    // Start polling for seek detection
    this._startSeekDetection();
  }

  _onStateChange(event) {
    const state = event.data;
    console.log(`[yt] State: ${this._stateName(state)}`);

    switch (state) {

      case this.YT_STATES.PLAYING: {
        this._isBuffering = false;
        this._isPlaying   = true;

        if (this._suppressPlay) {
          this._suppressPlay = false;
          return; // We triggered this — don't broadcast
        }

        const time = this.player.getCurrentTime();
        console.log(`[yt] User pressed PLAY @ ${time.toFixed(2)}s`);
        if (this.onPlay) this.onPlay(time);
        break;
      }

      case this.YT_STATES.PAUSED: {
        this._isPlaying = false;

        // BUFFERING GUARD: Ignore pause events that happen right after buffering.
        // YouTube briefly enters PAUSED state during/after buffering.
        const msSinceBufferEnd = Date.now() - this._bufferEndedAt;
        if (this._isBuffering || msSinceBufferEnd < 2000) {
          console.log('[yt] Ignoring spurious pause (buffering-related)');
          return;
        }

        if (this._suppressPause) {
          this._suppressPause = false;
          return;
        }

        const time = this.player.getCurrentTime();
        console.log(`[yt] User pressed PAUSE @ ${time.toFixed(2)}s`);
        if (this.onPause) this.onPause(time);
        break;
      }

      case this.YT_STATES.BUFFERING: {
        this._isBuffering  = true;
        this._bufferEndedAt = 0;
        console.log('[yt] Buffering...');
        break;
      }

      case this.YT_STATES.ENDED: {
        this._isPlaying = false;
        // Treat end-of-video as a pause — sync engine handles it
        if (this.onPause) this.onPause(this.player.getDuration());
        break;
      }
    }

    // Update last known time on any state change
    if (this.player && this.player.getCurrentTime) {
      this._lastKnownTime = this.player.getCurrentTime();
    }
  }

  _onError(event) {
    // YouTube error codes:
    // 2  = invalid videoId
    // 5  = HTML5 player error
    // 100 = video not found / private
    // 101, 150 = video can't be embedded
    const errorMessages = {
      2:   'Invalid video ID.',
      5:   'HTML5 player error.',
      100: 'Video not found or private.',
      101: 'This video cannot be embedded.',
      150: 'This video cannot be embedded.',
    };
    const msg = errorMessages[event.data] || `YouTube error: ${event.data}`;
    console.error('[yt] Error:', msg);

    // Show error in UI
    const container = document.getElementById(this.containerId);
    if (container) {
      container.innerHTML = `
        <div class="yt-error">
          <p>⚠️ ${msg}</p>
          <p>Check if the video is public and allows embedding.</p>
        </div>
      `;
    }
  }

  // ── Seek detection via polling ─────────────────────────────────────────────
  // YouTube doesn't fire a 'seeked' event. We detect seeks by comparing
  // current time to expected time (based on playback rate) every 500ms.
  _startSeekDetection() {
    const POLL_MS          = 500;
    const SEEK_THRESHOLD_S = 1.5; // Gap larger than this = a seek occurred

    this._seekPollInterval = setInterval(() => {
      if (!this.player || !this._isPlaying) return;

      const current  = this.player.getCurrentTime();
      const expected = this._lastKnownTime + (POLL_MS / 1000);
      const drift    = Math.abs(current - expected);

      if (drift > SEEK_THRESHOLD_S) {
        // Time jumped — this was a seek
        if (this._suppressSeek) {
          this._suppressSeek = false;
        } else {
          console.log(`[yt] Seek detected: ${this._lastKnownTime.toFixed(2)} → ${current.toFixed(2)}s`);
          if (this.onSeek) this.onSeek(current);
        }
      }

      this._lastKnownTime = current;
    }, POLL_MS);
  }

  _stopSeekDetection() {
    if (this._seekPollInterval) {
      clearInterval(this._seekPollInterval);
      this._seekPollInterval = null;
    }
  }

  // ── Public API — matches VideoPlayer interface exactly ─────────────────────

  play(time) {
    if (!this.player || !this.isReady) return;
    this._suppressPlay = true;
    if (time !== undefined) {
      this._suppressSeek = true;
      this.player.seekTo(time, true);
    }
    this.player.playVideo();
  }

  pause(time) {
    if (!this.player || !this.isReady) return;
    this._suppressPause = true;
    if (time !== undefined) {
      this._suppressSeek = true;
      this.player.seekTo(time, true);
    }
    this.player.pauseVideo();
  }

  seekTo(time) {
    if (!this.player || !this.isReady) return;
    this._suppressSeek = true;
    this.player.seekTo(time, true); // true = allowSeekAhead (fetches new buffer if needed)
    this._lastKnownTime = time;
  }

  getCurrentTime() {
    if (!this.player || !this.isReady) return 0;
    return this.player.getCurrentTime();
  }

  getDuration() {
    if (!this.player || !this.isReady) return 0;
    return this.player.getDuration();
  }

  isPaused() {
    if (!this.player) return true;
    return this.player.getPlayerState() !== this.YT_STATES.PLAYING;
  }

  destroy() {
    this._stopSeekDetection();
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _stateName(state) {
    const names = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
    return names[state] ?? state;
  }
}