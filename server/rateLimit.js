// rateLimit.js
// Defines rate limiters for different parts of the API.
//
// WHY DIFFERENT LIMITS FOR DIFFERENT ROUTES?
//   - Room creation: expensive (writes to disk). Limit to 10/hour per IP.
//   - File upload: very expensive (disk I/O, large data). Limit to 5/hour.
//   - General API: cheap reads. Allow 100/15min.
//   - WebSocket messages: handled separately in the WS handler, not here.
//     We'll add per-connection message rate limiting in index.js.

const rateLimit = require('express-rate-limit');

// General API limiter — applies to all routes not covered below
const generalLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              100,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests. Please slow down.' },
});

// Room creation — expensive write operation
const createRoomLimiter = rateLimit({
  windowMs:         60 * 60 * 1000, // 1 hour
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many rooms created. Try again in an hour.' },
});

// File upload — very expensive
const uploadLimiter = rateLimit({
  windowMs:         60 * 60 * 1000, // 1 hour
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many uploads. Try again in an hour.' },
});

module.exports = { generalLimiter, createRoomLimiter, uploadLimiter };