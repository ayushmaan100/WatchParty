// syncClient.js
// Manages the WebSocket connection and translates sync events
// into video player commands.
//
// KEY DESIGN DECISION: The event suppression pattern.
//
// Problem: When the sync engine calls player.play(), the video fires
// a 'play' event. Our listener picks that up and broadcasts PLAY to
// the server. The server echoes it back. We call player.play() again.
// Infinite loop.
//
// Solution: Before we programmatically touch the player, we set
// _suppressNext[eventType] = true. The event handler checks this
// flag and skips the broadcast if set.

class SyncClient {
  constructor(player, roomId) {
    this.player   = player;
    this.roomId   = roomId;
    this.ws       = null;
    this.userId   = null;
    this.username = null;
    this.isHost   = false;

    // Suppression flags — prevent feedback loops
    this._suppress = { play: false, pause: false, seek: false };

    // Reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectDelay = 30000;
    this._intentionalClose  = false;

    // Callbacks for the UI
    this.onChat         = null; // (msg) → void
    this.onMemberUpdate = null; // (members, count) → void
    this.onSyncEvent    = null; // (type, time) → void  [for UI indicators]
    this.onConnected    = null;
    this.onDisconnected = null;
  }

  connect(username) {
    this.username = username;
    this._connect();
  }

  _connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url      = `${protocol}//${window.location.host}`;

    console.log(`[sync] Connecting to ${url}`);
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      console.log('[sync] Connected. Joining room...');
      this._reconnectAttempts = 0;

      this._send({ type: 'JOIN', roomId: this.roomId, username: this.username });
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (err) {
        console.error('[sync] Failed to parse message:', err);
      }
    });

    this.ws.addEventListener('close', () => {
      console.warn('[sync] Disconnected.');
      if (this.onDisconnected) this.onDisconnected();
      if (!this._intentionalClose) this._scheduleReconnect();
    });

    this.ws.addEventListener('error', (err) => {
      console.error('[sync] WebSocket error:', err);
    });
  }

  _scheduleReconnect() {
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), this._maxReconnectDelay);
    this._reconnectAttempts++;
    console.log(`[sync] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    setTimeout(() => this._connect(), delay);
  }

  _handleMessage(msg) {
    switch (msg.type) {

      // ── Initial room state on join ─────────────────────────────────────────
      case 'ROOM_STATE': {
        this.userId = msg.userId;
        this.isHost = msg.isHost;
        this._lastMembers = msg.members;

        console.log(`[sync] Room state received. I am ${this.isHost ? 'HOST' : 'guest'}. ` +
                    `Video is ${msg.syncState.isPlaying ? 'playing' : 'paused'} ` +
                    `@ ${msg.syncState.currentTime.toFixed(2)}s`);

        if (this.onConnected) this.onConnected(msg);
        if (this.onMemberUpdate) this.onMemberUpdate(msg.members, msg.members.length);

        // Apply initial state once the video is ready
        this._applySyncState(msg.syncState);
        break;
      }

      // ── Play command from server ───────────────────────────────────────────
      case 'PLAY': {
        // Compensate for network delay:
        // The server stamped this event at serverTs. Some time has passed since then.
        // We need to seek to where the video SHOULD be now, not where it was then.
        const now        = Date.now();
        const networkMs  = now - msg.serverTs;
        const targetTime = msg.time + (networkMs / 1000);

        console.log(`[sync] PLAY command. Network delay: ${networkMs}ms. ` +
                    `Seeking to ${targetTime.toFixed(3)}s`);

        this._suppress.seek = true;
        this._suppress.play = true;
        this.player.play(targetTime);

        if (this.onSyncEvent) this.onSyncEvent('play', targetTime, msg.username);
        break;
      }

      // ── Pause command from server ──────────────────────────────────────────
      case 'PAUSE': {
        const now       = Date.now();
        const networkMs = now - msg.serverTs;
        // For pause, we use the exact time (not compensated)
        // because a paused video should show the same frame for everyone
        const targetTime = msg.time;

        console.log(`[sync] PAUSE command @ ${targetTime.toFixed(3)}s (delay: ${networkMs}ms)`);

        this._suppress.pause = true;
        this._suppress.seek  = true;
        this.player.pause(targetTime);

        if (this.onSyncEvent) this.onSyncEvent('pause', targetTime, msg.username);
        break;
      }

      // ── Seek command from server ───────────────────────────────────────────
      case 'SEEK': {
        const now        = Date.now();
        const networkMs  = now - msg.serverTs;
        // Only compensate for network delay on seek if video is currently playing
        const targetTime = msg.time + (this.player.isPaused() ? 0 : networkMs / 1000);

        console.log(`[sync] SEEK to ${targetTime.toFixed(3)}s (delay: ${networkMs}ms)`);

        this._suppress.seek = true;
        this.player.seekTo(targetTime);

        if (this.onSyncEvent) this.onSyncEvent('seek', targetTime, msg.username);
        break;
      }

      // ── Chat message ───────────────────────────────────────────────────────
      case 'CHAT': {
        if (this.onChat) this.onChat(msg);
        break;
      }

      // ── Member list update ─────────────────────────────────────────────────
      case 'MEMBER_UPDATE': {
        this._lastMembers = msg.members;
        if (this.onMemberUpdate) this.onMemberUpdate(msg.members, msg.count);
        break;
      }

      case 'ERROR': {
        console.error('[sync] Server error:', msg.message);
        break;
      }
    }
  }

  // Apply a full sync state (used on initial join and reconnect)
  _applySyncState(syncState) {
    // Wait until the video is ready before applying state
    if (!this.player.isReady) {
      this.player.onReady = () => this._applySyncState(syncState);
      return;
    }

    if (syncState.isPlaying) {
      this._suppress.seek = true;
      this._suppress.play = true;
      this.player.play(syncState.currentTime);
    } else {
      this._suppress.seek = true;
      this.player.seekTo(syncState.currentTime);
    }
  }

  // ── Hook into player events ────────────────────────────────────────────────
  // Called from room.html after both player and syncClient are initialized.
  attachToPlayer() {
    this.player.onPlay = (time) => {
      if (this._suppress.play) {
        this._suppress.play = false;
        return; // This was triggered by us — don't re-broadcast
      }
      console.log(`[sync] Broadcasting PLAY @ ${time.toFixed(3)}s`);
      this._send({ type: 'PLAY', time });
    };

    this.player.onPause = (time) => {
      if (this._suppress.pause) {
        this._suppress.pause = false;
        return;
      }
      console.log(`[sync] Broadcasting PAUSE @ ${time.toFixed(3)}s`);
      this._send({ type: 'PAUSE', time });
    };

    this.player.onSeek = (time) => {
      if (this._suppress.seek) {
        this._suppress.seek = false;
        return;
      }
      console.log(`[sync] Broadcasting SEEK → ${time.toFixed(3)}s`);
      this._send({ type: 'SEEK', time });
    };
  }

  // ── Send chat message ──────────────────────────────────────────────────────
  sendChat(text) {
    this._send({ type: 'CHAT', text });
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[sync] Cannot send — WebSocket not open:', msg.type);
    }
  }

  disconnect() {
    this._intentionalClose = true;
    if (this.ws) this.ws.close();
  }
}