// wsRateLimit.js
// Per-connection WebSocket message rate limiter.
//
// STRATEGY: Token bucket algorithm.
//   - Each connection gets a bucket of N tokens
//   - Each message consumes 1 token
//   - Tokens refill at a steady rate
//   - If bucket is empty, message is dropped and a warning is sent
//
// This is better than a simple counter because it allows short bursts
// (e.g., joining a room triggers several messages at once) while still
// preventing sustained flooding.

class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this.capacity        = capacity;
    this.tokens          = capacity;
    this.refillPerSecond = refillPerSecond;
    this.lastRefill      = Date.now();
  }

  consume() {
    this._refill();
    if (this.tokens < 1) return false; // Bucket empty
    this.tokens -= 1;
    return true;
  }

  _refill() {
    const now     = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    const refill  = elapsed * this.refillPerSecond;

    this.tokens     = Math.min(this.capacity, this.tokens + refill);
    this.lastRefill = now;
  }
}

// Create a rate limiter for a WebSocket connection
// Allows bursts up to 20 messages, sustained rate of 5 messages/second
function createConnectionLimiter() {
  return new TokenBucket(20, 5);
}

module.exports = { createConnectionLimiter };