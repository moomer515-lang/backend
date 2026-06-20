require('dotenv').config()

const http        = require('http')
const { Server }  = require('socket.io')
const jwt         = require('jsonwebtoken')
const Report      = require('./src/models/Report')
const User        = require('./src/models/User')

const app         = require('./src/app')
const { connectDB, disconnectDB } = require('./src/config/db')
const timerService = require('./src/services/timer.service')
const metrics      = require('./src/utils/metrics')
const logger      = require('./src/utils/logger')

const PORT = process.env.PORT || 8000

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app)

// ─── Socket.io ────────────────────────────────────────────────────────────────
// Same CORS_ORIGINS env var used by Express (see src/app.js) so the Socket.io
// handshake is allowed from the deployed frontend URL too.
const allowedOrigins = (
  '*'
).split(',').map((s) => s.trim())


// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000
  }
})

// ─── Socket auth middleware ───────────────────────────────────────────────────
io.use(async (socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace('Bearer ', '')

  if (!token) return next(new Error('Authentication required.'))

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    socket.userId = payload.sub
    const user = await User.findById(payload.sub).select('fullName role')
    socket.userName = user?.fullName || 'User'
    socket.userRole = user?.role === 'admin' ? 'admin' : 'user'
    next()
  } catch {
    next(new Error('Invalid or expired token.'))
  }
})

// ─── Socket connection handler ────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Each user gets their own private room for targeted pushes
  socket.join(`user:${socket.userId}`)

  if (socket.recovered) {
    // Reconnected within the recovery window — client state was resumed,
    // but we still treat this as a reconnect for metrics purposes.
    metrics.increment('wsReconnects')
  }
  logger.info(`[Socket.io] ✅ User ${socket.userId} connected (${socket.id}) recovered=${Boolean(socket.recovered)}`)

  // Client calls this on initial load AND on every reconnect. The server's
  // expiresAt/remainingSeconds is the only value the client should trust —
  // never resume a countdown purely from client-side memory.
  socket.on('timer:get_status', async () => {
    try {
      const timer = await timerService.getTimer(socket.userId)
      socket.emit('timer:status', { timer, serverTime: new Date().toISOString() })
    } catch (err) {
      socket.emit('error', { message: 'Could not retrieve timer status.' })
    }
  })

  // Optional: client reports what its local countdown said remaining was
  // right before it resynced, so we can track clock drift across
  // reconnects/long sessions as a reliability metric.
  socket.on('timer:report_drift', ({ clientRemainingSeconds, serverRemainingSeconds }) => {
    if (typeof clientRemainingSeconds === 'number' && typeof serverRemainingSeconds === 'number') {
      metrics.recordDrift(Math.abs(clientRemainingSeconds - serverRemainingSeconds) * 1000)
    }
  })

  // Lightweight connection health ping the client can use independently of
  // Socket.io's own engine-level ping/pong (useful for app-level "are we
  // really live" indicators in the UI).
  socket.on('health:ping', () => socket.emit('health:pong', { at: new Date().toISOString() }))

  // Typing indicators for future chat feature
  socket.on('chat:typing', ({ roomId }) => {
    socket.to(`room:${roomId}`).emit('chat:typing', { userId: socket.userId })
  })

  socket.on('report:join', async ({ reportId }) => {
    if (!reportId) return
    try {
      const report = await Report.findById(reportId).select('_id')
      if (!report) return
      socket.join(`report:${reportId}`)
      socket.emit('report:joined', { reportId })
    } catch {
      socket.emit('error', { message: 'Could not join report chat.' })
    }
  })

  socket.on('report:leave', ({ reportId }) => {
    if (!reportId) return
    socket.leave(`report:${reportId}`)
  })

  socket.on('report:chat_send', async ({ reportId, content }) => {
    const messageText = String(content || '').trim()
    if (!reportId || !messageText) return
    try {
      const report = await Report.findById(reportId)
      if (!report) return

      const message = {
        sender: socket.userId,
        senderName: socket.userName || 'User',
        senderRole: socket.userRole || 'user',
        content: messageText
      }
      report.chatMessages.push(message)
      await report.save()

      const saved = report.chatMessages[report.chatMessages.length - 1]
      io.to(`report:${reportId}`).emit('report:chat_message', {
        _id: saved._id,
        reportId: report._id.toString(),
        senderId: socket.userId,
        senderName: message.senderName,
        senderRole: message.senderRole,
        content: message.content,
        createdAt: saved.createdAt
      })
    } catch {
      socket.emit('error', { message: 'Could not send chat message.' })
    }
  })

  socket.on('disconnect', (reason) => {
    logger.info(`[Socket.io] ❌ User ${socket.userId} disconnected — ${reason}`)
  })
})

// Make io available to Express controllers via app.set
app.set('io', io)

// Inject io into timer service for real-time expiry notifications
timerService.setIO(io)

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const bootstrap = async () => {
  try {
    // Connect to MongoDB
    await connectDB()

    // Recover any safety timers that were still active when the process
    // last stopped (crash, deploy, restart). expiresAt is persisted in the
    // DB, so nothing needs to be "restored" into memory — this just writes
    // an audit trail entry per timer before the tick loop resumes scanning.
    await timerService.recoverPendingTimers()

    // Start background timer polling
    timerService.start()

    // Start HTTP server
    server.listen(PORT, () => {
      logger.info('═'.repeat(50))
      logger.info(`  NIMIR API v1.0.0`)
      logger.info(`  ENV  : ${process.env.NODE_ENV || 'development'}`)
      logger.info(`  PORT : ${PORT}`)
      logger.info(`  DB   : ${process.env.MONGO_URI?.replace(/:\/\/.*@/, '://***@') || 'mongodb://localhost/nimir'}`)
      logger.info(`  WS   : Socket.io active`)
      logger.info('═'.repeat(50))
    })
  } catch (err) {
    logger.error('Bootstrap failed:', err)
    process.exit(1)
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`\n[${signal}] Shutting down gracefully...`)

  // Stop accepting new connections
  server.close(async () => {
    try {
      timerService.stop()
      await disconnectDB()
      logger.info('Server shut down cleanly.')
      process.exit(0)
    } catch (err) {
      logger.error('Error during shutdown:', err)
      process.exit(1)
    }
  })

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Forced exit after timeout.')
    process.exit(1)
  }, 15000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// Handle uncaught exceptions — log and exit (let process manager restart)
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION:', err)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED REJECTION:', reason)
  shutdown('unhandledRejection')
})

bootstrap()

module.exports = { server, io }
