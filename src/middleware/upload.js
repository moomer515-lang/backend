const multer = require('multer')
const path   = require('path')
const fs     = require('fs')
const { v4: uuid } = require('uuid')
const { ApiError } = require('../utils/apiHelpers')

const UPLOAD_DIR   = path.resolve(process.env.UPLOAD_DIR || './uploads')
const MAX_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || '10') * 1024 * 1024

// Ensure sub-directories exist
const UPLOAD_SUBDIRS = ['evidence', 'avatars', 'voice']
UPLOAD_SUBDIRS.forEach((sub) => {
  const dir = path.join(UPLOAD_DIR, sub)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ─── Storage factory ──────────────────────────────────────────────────────────
const makeStorage = (subfolder) =>
  multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, subfolder)),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${uuid()}${ext}`)
    }
  })

// ─── File-type filters ────────────────────────────────────────────────────────
const ALLOWED_EVIDENCE = new Set([
  'image/jpeg','image/png','image/webp','image/gif',
  'image/heic','image/heif','image/heic-sequence','image/heif-sequence',
  'application/pdf','video/mp4','video/quicktime','application/octet-stream'
])
const ALLOWED_AUDIO = new Set([
  'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a'
])

const evidenceFilter = (req, file, cb) => {
  const isImage = file.mimetype.startsWith('image/')
  ;(ALLOWED_EVIDENCE.has(file.mimetype) || isImage)
    ? cb(null, true)
    : cb(new ApiError(`File type ${file.mimetype} is not allowed for evidence.`, 400))
}
const audioFilter = (req, file, cb) => {
  ALLOWED_AUDIO.has(file.mimetype)
    ? cb(null, true)
    : cb(new ApiError('Only audio files are accepted for voice recordings.', 400))
}
const imageFilter = (req, file, cb) => {
  file.mimetype.startsWith('image/')
    ? cb(null, true)
    : cb(new ApiError('Only image files are accepted for avatars.', 400))
}

// ─── Multer instances ─────────────────────────────────────────────────────────
const evidenceUpload = multer({
  storage:    makeStorage('evidence'),
  fileFilter: evidenceFilter,
  limits:     { fileSize: MAX_SIZE, files: 5 }
})

const voiceUpload = multer({
  storage:    makeStorage('voice'),
  fileFilter: audioFilter,
  limits:     { fileSize: MAX_SIZE, files: 1 }
})

const avatarUpload = multer({
  storage:    makeStorage('avatars'),
  fileFilter: imageFilter,
  limits:     { fileSize: 2 * 1024 * 1024, files: 1 }
})

// ─── Multer error handler ─────────────────────────────────────────────────────
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE:  `File too large. Maximum is ${process.env.MAX_FILE_SIZE_MB || 10}MB.`,
      LIMIT_FILE_COUNT: 'Too many files. Maximum 5 per upload.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field.'
    }
    return res.status(400).json({ success: false, message: map[err.code] || err.message })
  }
  if (err) return res.status(400).json({ success: false, message: err.message })
  next()
}

module.exports = { evidenceUpload, voiceUpload, avatarUpload, handleUploadError }