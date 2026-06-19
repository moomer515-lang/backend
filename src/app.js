const express            = require('express')
const cors               = require('cors')
const helmet             = require('helmet')
const morgan             = require('morgan')
const compression        = require('compression')
const mongoSanitize      = require('express-mongo-sanitize')
const rateLimit          = require('express-rate-limit')
const path               = require('path')

const authRoutes         = require('./routes/auth.routes')
const reportRoutes       = require('./routes/report.routes')
const { contactRouter, timerRouter, profileRouter, notifRouter, supportRouter }
                         = require('./routes/other.routes')
const { errorHandler, notFound } = require('./middleware/errorHandler')
const logger             = require('./utils/logger')

const app = express()

// ─── Trust proxy (for correct IP behind Nginx / load balancer) ───────────────
app.set('trust proxy', 1)

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }  // allow serving uploads
}))

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Set CORS_ORIGINS in .env (or Render's environment settings) as a comma-separated
// list of allowed frontend URLs.
// Example: CORS_ORIGINS=https://shield-frontend.onrender.com,http://127.0.0.1:5501
const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  'http://127.0.0.1:5501,http://localhost:5501,http://127.0.0.1:5500,http://localhost:5500'
).split(',').map((s) => s.trim())

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (Postman, curl, mobile apps)
    if (!origin) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    logger.warn(`CORS blocked: ${origin}`)
    cb(new Error(`CORS: origin ${origin} not allowed.`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}

// Must register CORS before ALL other middleware so preflight OPTIONS
// requests are answered before Helmet or any route handler sees them.
app.use(cors(corsOptions))
app.options('*', cors(corsOptions)) 

// ─── Compression ─────────────────────────────────────────────────────────────
app.use(compression())

// ─── HTTP logging ─────────────────────────────────────────────────────────────
app.use(morgan(
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
  { stream: { write: (msg) => logger.http(msg.trim()) } }
))

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// ─── NoSQL injection sanitization ────────────────────────────────────────────
app.use(mongoSanitize())

// ─── Global rate limiter ──────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '200'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
}))

// ─── Static: uploaded files ───────────────────────────────────────────────────
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '1h',
  setHeaders: (res) => {
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Cache-Control', 'private, max-age=3600')
  }
}))

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes)
app.use('/api/reports',       reportRoutes)
app.use('/api/contacts',      contactRouter)
app.use('/api/timer',         timerRouter)
app.use('/api/profile',       profileRouter)
app.use('/api/notifications', notifRouter)
app.use('/api/support',       supportRouter)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const mongoose = require('mongoose')
  res.json({
    success:     true,
    service:     'nimir-api',
    version:     '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    database:    mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp:   new Date().toISOString(),
    uptime:      `${Math.round(process.uptime())}s`
  })
})

// ─── Safety timer reliability metrics (dev/ops visibility) ───────────────────
app.get('/api/health/safety-timer-metrics', (req, res) => {
  const metrics = require('./utils/metrics')
  res.json({ success: true, data: metrics.snapshot() })
})

app.get('/', (req, res) => {
  res.json({ name: 'Nimir API', version: '1.0.0', docs: '/api/health' })
})

// ─── 404 + error handlers ─────────────────────────────────────────────────────
app.use(notFound)
app.use(errorHandler)

module.exports = app