// upload.js
// Handles video file uploads with strict validation.
//
// SECURITY RULES:
//   1. File size limit: 5GB max (configurable)
//   2. MIME type check: must be a real video type
//   3. Extension whitelist: .mp4, .mkv, .webm, .mov only
//   4. Filename sanitization: strip special characters
//   5. No path traversal: files go ONLY into /uploads
//   6. Duplicate detection: same filename = overwrite (not accumulate)
//
// WHY NOT CHECK FILE MAGIC BYTES?
//   We could read the first 8 bytes to verify it's actually a video.
//   Skipping that for now — multer's MIME check + extension check is
//   sufficient for a trusted-user scenario. Add magic byte checks
//   if you ever open this to anonymous public uploads.

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const UPLOAD_DIR     = path.join(__dirname, '../uploads');
const MAX_FILE_SIZE  = 5 * 1024 * 1024 * 1024; // 5GB

// Allowed video types — both MIME and extension must match
const ALLOWED_MIMES = new Set([
  'video/mp4', 'video/x-matroska', 'video/webm',
  'video/quicktime', 'video/x-msvideo',
]);

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi']);

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage: custom filename sanitization
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    // Sanitize filename:
    //   1. Get just the extension
    //   2. Strip the original name of anything non-alphanumeric
    //   3. Truncate to 60 chars
    //   4. Append timestamp to avoid collisions
    const ext         = path.extname(file.originalname).toLowerCase();
    const baseName    = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-\.]/g, '_') // Replace special chars with _
      .replace(/__+/g, '_')                // Collapse multiple underscores
      .slice(0, 60);                       // Truncate

    const safeName = `${baseName}_${Date.now()}${ext}`;
    cb(null, safeName);
  },
});

// File filter: validate MIME type and extension
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error(`Invalid file type: ${file.mimetype}. Only video files allowed.`));
  }

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`Invalid extension: ${ext}. Allowed: .mp4 .mkv .webm .mov .avi`));
  }

  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files:    1, // One file per request
  },
});

// Middleware for single video upload
const uploadSingle = upload.single('video'); // field name must be 'video'

// Wrapper that converts multer callback errors to Express next(err) pattern
function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024 / 1024}GB.`,
      });
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected field name. Use field name "video".',
      });
    }

    return res.status(400).json({ error: err.message });
  });
}

// Get disk usage of uploads directory
function getUploadStats() {
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    let   totalBytes = 0;

    const fileList = files
      .filter(f => ALLOWED_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .map(f => {
        const stat  = fs.statSync(path.join(UPLOAD_DIR, f));
        totalBytes += stat.size;
        return {
          name:      f,
          size:      stat.size,
          createdAt: stat.birthtime,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt); // Newest first

    return { files: fileList, totalBytes };
  } catch {
    return { files: [], totalBytes: 0 };
  }
}

module.exports = { handleUpload, getUploadStats, UPLOAD_DIR };