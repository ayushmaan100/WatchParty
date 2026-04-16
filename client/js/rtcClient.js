// rtcClient.js
// Manages all WebRTC peer connections for video chat.
//
// ARCHITECTURE:
// This class maintains a Map of peerId → RTCPeerConnection.
// When a new member joins, we create a connection to them.
// When they leave, we destroy it.
//
// OFFER/ANSWER RULE (prevents "glare"):
// When two peers try to call each other simultaneously, you get a collision.
// We solve this with a simple rule: the peer with the lexicographically
// SMALLER userId sends the offer. The other waits for an offer.
// This is deterministic — both sides independently make the same decision.

class RTCClient {
  constructor(syncClient) {
    this.syncClient = syncClient;         // For sending signaling via WebSocket
    this.localStream  = null;             // Our camera+mic stream
    this.peers        = new Map();        // peerId → { pc, stream, elements }
    this.isMuted      = false;
    this.isCameraOff  = false;
    this.isInCall     = false;

    // Callbacks for UI
    this.onRemoteStream  = null;  // (peerId, stream, username) → void
    this.onPeerLeft      = null;  // (peerId) → void
    this.onLocalStream   = null;  // (stream) → void
    this.onError         = null;  // (message) → void

    // STUN servers — using Google's free ones for now
    // In production, add your own TURN server here
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    this._hookSignaling();
  }

  // ── Hook into syncClient's WebSocket messages ─────────────────────────────
  // We intercept WebRTC signaling messages that come through the WS connection.
  _hookSignaling() {
    // We extend the syncClient's message handler to also handle RTC messages.
    // Store original handler reference.
    const originalHandle = this.syncClient._handleMessage.bind(this.syncClient);

    this.syncClient._handleMessage = (msg) => {
      // Let sync client handle its own messages first
      originalHandle(msg);
      // Then check if it's an RTC message for us
      this._handleSignal(msg);
    };
  }

  _handleSignal(msg) {
    switch (msg.type) {
      case 'CALL_OFFER':      this._onOffer(msg);     break;
      case 'CALL_ANSWER':     this._onAnswer(msg);    break;
      case 'ICE_CANDIDATE':   this._onIceCandidate(msg); break;
      case 'CALL_HANGUP':     this._onHangup(msg);    break;

      // When member list updates, initiate connections to new members
      case 'MEMBER_UPDATE':
        if (this.isInCall) this._syncPeers(msg.members);
        break;
    }
  }

  // ── Join/Leave call ───────────────────────────────────────────────────────

  async joinCall() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });

      this.isInCall = true;
      if (this.onLocalStream) this.onLocalStream(this.localStream);

      // Initiate connections to everyone currently in the room
      const room = await fetch(`/api/rooms/${this.syncClient.roomId}`).then(r => r.json());
      // We'll get the member list from the last MEMBER_UPDATE — stored in syncClient
      // For now, trigger via a fresh MEMBER_UPDATE by calling _syncPeers with known members
      if (this.syncClient._lastMembers) {
        this._syncPeers(this.syncClient._lastMembers);
      }

      console.log('[rtc] Joined call. Local stream ready.');
      return true;

    } catch (err) {
      console.error('[rtc] getUserMedia failed:', err);
      const msg = err.name === 'NotAllowedError'
        ? 'Camera/mic permission denied. Please allow access and try again.'
        : `Could not access camera/mic: ${err.message}`;
      if (this.onError) this.onError(msg);
      return false;
    }
  }

  leaveCall() {
    // Close all peer connections
    for (const [peerId] of this.peers) {
      this._closePeer(peerId);
    }

    // Stop local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.isInCall = false;
    console.log('[rtc] Left call.');
  }

  // ── Sync peer connections with current member list ────────────────────────
  // Called when member list changes while in a call.
  _syncPeers(members) {
    const myId = this.syncClient.userId;

    for (const member of members) {
      if (member.userId === myId) continue;              // Skip self
      if (this.peers.has(member.userId)) continue;       // Already connected

      // OFFER RULE: smaller userId initiates
      if (myId < member.userId) {
        console.log(`[rtc] I initiate offer to ${member.userId} (${member.username})`);
        this._createPeerConnection(member.userId, member.username, true);
      } else {
        // Create the connection object but wait for their offer
        console.log(`[rtc] Waiting for offer from ${member.userId} (${member.username})`);
        this._createPeerConnection(member.userId, member.username, false);
      }
    }

    // Close connections for members who left
    const memberIds = new Set(members.map(m => m.userId));
    for (const [peerId] of this.peers) {
      if (!memberIds.has(peerId)) {
        this._closePeer(peerId);
      }
    }
  }

  // ── Create RTCPeerConnection ───────────────────────────────────────────────
  _createPeerConnection(peerId, username, shouldOffer) {
    const pc = new RTCPeerConnection(this.iceConfig);

    // Add our local tracks to the connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // When we receive remote media tracks
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      console.log(`[rtc] Got remote stream from ${peerId}`);
      if (this.onRemoteStream) this.onRemoteStream(peerId, remoteStream, username);
    };

    // When ICE finds a candidate, send it to the peer via signaling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.syncClient._send({
          type:      'ICE_CANDIDATE',
          targetId:  peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[rtc] ICE state with ${peerId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[rtc] ICE failed with ${peerId}. May need TURN server.`);
      }
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
        this._closePeer(peerId);
      }
    };

    pc.onnegotiationneeded = async () => {
      if (!shouldOffer) return;
      try {
        await this._sendOffer(peerId, pc);
      } catch (err) {
        console.error(`[rtc] Negotiation failed with ${peerId}:`, err);
      }
    };

    this.peers.set(peerId, { pc, username });
    return pc;
  }

  // ── Send offer ────────────────────────────────────────────────────────────
  async _sendOffer(peerId, pc) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.syncClient._send({
      type:     'CALL_OFFER',
      targetId: peerId,
      sdp:      pc.localDescription,
    });

    console.log(`[rtc] Sent offer to ${peerId}`);
  }

  // ── Handle incoming offer ─────────────────────────────────────────────────
  async _onOffer(msg) {
    if (!this.isInCall) return; // Ignore if we're not in a call

    const { fromId, sdp, username } = msg;
    console.log(`[rtc] Received offer from ${fromId} (${username})`);

    let peer = this.peers.get(fromId);
    if (!peer) {
      this._createPeerConnection(fromId, username, false);
      peer = this.peers.get(fromId);
    }

    const { pc } = peer;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.syncClient._send({
        type:     'CALL_ANSWER',
        targetId: fromId,
        sdp:      pc.localDescription,
      });

      console.log(`[rtc] Sent answer to ${fromId}`);
    } catch (err) {
      console.error(`[rtc] Error handling offer from ${fromId}:`, err);
    }
  }

  // ── Handle answer ─────────────────────────────────────────────────────────
  async _onAnswer(msg) {
    const peer = this.peers.get(msg.fromId);
    if (!peer) return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      console.log(`[rtc] Answer set for ${msg.fromId}`);
    } catch (err) {
      console.error(`[rtc] Error setting answer from ${msg.fromId}:`, err);
    }
  }

  // ── Handle ICE candidate ──────────────────────────────────────────────────
  async _onIceCandidate(msg) {
    const peer = this.peers.get(msg.fromId);
    if (!peer) return;

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      // Benign: can happen if connection is closing
      console.warn(`[rtc] ICE candidate error from ${msg.fromId}:`, err.message);
    }
  }

  // ── Handle hangup ─────────────────────────────────────────────────────────
  _onHangup(msg) {
    console.log(`[rtc] Hangup from ${msg.fromId}`);
    this._closePeer(msg.fromId);
  }

  // ── Close and clean up a peer connection ──────────────────────────────────
  _closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.pc.close();
    this.peers.delete(peerId);

    if (this.onPeerLeft) this.onPeerLeft(peerId);
    console.log(`[rtc] Closed connection with ${peerId}`);
  }

  // ── Media controls ────────────────────────────────────────────────────────
  toggleMute() {
    if (!this.localStream) return false;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
    return this.isMuted;
  }

  toggleCamera() {
    if (!this.localStream) return false;
    this.isCameraOff = !this.isCameraOff;
    this.localStream.getVideoTracks().forEach(t => { t.enabled = !this.isCameraOff; });
    return this.isCameraOff;
  }
}