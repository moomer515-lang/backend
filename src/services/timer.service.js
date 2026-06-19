const { CheckinTimer, SafetyTimerEvent, TrustedContact } = require('../models/index')
const { alertTimerExpired } = require('./notification.service')
const { ApiError } = require('../utils/apiHelpers')
const metrics = require('../utils/metrics')
const logger  = require('../utils/logger')

let pollHandle = null
let _io        = null   // Socket.io injected from server.js

// How often the worker scans for due timers / broadcasts ticks.
// Kept short (default 1s) so the "alert decision within well under 1s of
// expiry" target is achievable — the scan IS the expiry engine here
// (a periodic DB scan), no setTimeout-per-timer that would be lost on restart.
const TICK_MS = parseInt(process.env.TIMER_TICK_MS || '1000')
// Seconds remaining at which we emit a one-time "about to expire" warning.
const WARNING_THRESHOLD_SECONDS = parseInt(process.env.TIMER_WARNING_SECONDS || '60')

// In-memory "already warned" set. Purely a UX dedupe for the warning ping —
// losing it on restart just means a user might get one extra warning event,
// which is harmless (unlike the trigger/alert path, which uses a real DB lock).
const warnedTimerIds = new Set()

/** Inject Socket.io instance so we can push real-time events */
const setIO = (io) => { _io = io }

const emitToUser = (userId, event, payload) => {
  if (_io) _io.to(`user:${userId}`).emit(event, payload)
}

const logEvent = async (timerId, userId, type, detail = null) => {
  try {
    await SafetyTimerEvent.create({ timer: timerId, user: userId, type, detail })
  } catch (err) {
    logger.error(`[TimerService] Failed to log event ${type}:`, err.message)
  }
}

// ─── Expiry + tick engine ──────────────────────────────────────────────────────
// A single periodic DB scan plays the role of the "backend expiry mechanism."
// It does double duty: broadcast countdown ticks, and atomically claim +
// trigger any timer whose expiresAt has passed. The atomic claim (a
// findOneAndUpdate keyed on the current lockVersion) is what guarantees a
// timer can never fire twice, even if two worker ticks overlap or two
// server instances are scanning the same collection concurrently.
const runTick = async () => {
  let activeTimers
  try {
    activeTimers = await CheckinTimer.find({ status: 'active' }).lean()
  } catch (err) {
    logger.error('[TimerService] Tick scan failed:', err.message)
    return
  }

  const now = Date.now()

  for (const timer of activeTimers) {
    const remainingMs = new Date(timer.expiresAt).getTime() - now

    if (remainingMs <= 0) {
      await triggerTimer(timer)
      continue
    }

    const remainingSeconds = Math.round(remainingMs / 1000)
    emitToUser(timer.user, 'timer_tick', {
      timerId: timer._id,
      remainingSeconds,
      expiresAt: timer.expiresAt
    })

    if (remainingSeconds <= WARNING_THRESHOLD_SECONDS && !warnedTimerIds.has(String(timer._id))) {
      warnedTimerIds.add(String(timer._id))
      emitToUser(timer.user, 'timer_warning', {
        timerId: timer._id,
        remainingSeconds,
        message: `Your safety timer expires in ${remainingSeconds}s. Check in now if you're safe.`
      })
    }
  }
}

/**
 * Atomically claim a due timer and fire the alert pipeline exactly once.
 * Safe to call concurrently (overlapping ticks, multiple instances) — only
 * one caller will win the conditional update.
 */
const triggerTimer = async (timerLean) => {
  const claimStart = Date.now()

  const claimed = await CheckinTimer.findOneAndUpdate(
    { _id: timerLean._id, status: 'active', lockVersion: timerLean.lockVersion },
    {
      $set:  { status: 'triggered', isActive: false, wasTriggered: true, triggeredAt: new Date() },
      $inc:  { lockVersion: 1 }
    },
    { new: true }
  )

  if (!claimed) {
    // Another tick / instance already claimed this timer between our read
    // and our write. This is the duplicate-trigger-prevention path — log it
    // as a metric, do NOT alert again.
    metrics.increment('duplicateTriggerAttempts')
    logger.warn(`[TimerService] Duplicate trigger attempt suppressed — user ${timerLean.user}`)
    return
  }

  warnedTimerIds.delete(String(timerLean._id))
  metrics.increment('timersTriggered')
  metrics.recordDuration('triggerProcessing', Date.now() - new Date(claimed.expiresAt).getTime())

  await logEvent(claimed._id, claimed.user, 'triggered', {
    expiresAt: claimed.expiresAt,
    lastLocation: claimed.lastLocation
  })

  emitToUser(claimed.user, 'timer_expired', {
    timerId: claimed._id,
    message: 'Your check-in timer expired. Trusted contacts are being alerted.',
    triggeredAt: claimed.triggeredAt
  })

  logger.warn(`[TimerService] ⚠️ Timer fired — user ${claimed.user} (claim latency ${Date.now() - claimStart}ms)`)

  // Alert dispatch is intentionally fire-and-forget from the trigger path so
  // a slow SMTP/SMS provider can never delay the next tick's scan. Delivery
  // results are still logged + emitted once they resolve.
  dispatchAlerts(claimed).catch((err) => {
    logger.error('[TimerService] dispatchAlerts crashed:', err.message)
  })
}

const dispatchAlerts = async (timerDoc) => {
  const dispatchStart = Date.now()
  try {
    const result = await alertTimerExpired(timerDoc.user.toString(), {
      timerId: timerDoc._id,
      lastLocation: timerDoc.lastLocation,
      triggeredAt: timerDoc.triggeredAt
    })

    const latencyMs = Date.now() - dispatchStart
    metrics.recordDuration('alertDispatchLatency', latencyMs)

    if (result?.delivered) {
      metrics.increment('alertsDispatched')
      await logEvent(timerDoc._id, timerDoc.user, 'alert_dispatched', { ...result, latencyMs })
      emitToUser(timerDoc.user, 'alert_dispatched', {
        timerId: timerDoc._id,
        contactsNotified: result.contactsNotified,
        channels: result.channels,
        latencyMs
      })
    } else {
      metrics.increment('alertsFailed')
      await logEvent(timerDoc._id, timerDoc.user, 'alert_failed', { ...result, latencyMs })
      emitToUser(timerDoc.user, 'alert_dispatched', {
        timerId: timerDoc._id,
        failed: true,
        reason: result?.reason || 'unknown'
      })
    }
  } catch (err) {
    metrics.increment('alertsFailed')
    await logEvent(timerDoc._id, timerDoc.user, 'alert_failed', { error: err.message })
    logger.error('[TimerService] Alert dispatch error:', err.message)
  }
}

// ─── Worker lifecycle ───────────────────────────────────────────────────────────
const start = () => {
  if (pollHandle) return
  logger.info(`[TimerService] Started — scanning every ${TICK_MS}ms`)
  pollHandle = setInterval(() => {
    runTick().catch((err) => logger.error('[TimerService] Tick error:', err.message))
  }, TICK_MS)

  // Run one pass immediately so timers that expired while the server was
  // down (or mid-restart) get processed without waiting a full interval.
  runTick().catch((err) => logger.error('[TimerService] Initial tick error:', err.message))
}

const stop = () => {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
    logger.info('[TimerService] Stopped.')
  }
}

/**
 * Called once at boot, before the tick loop starts. Logs an audit trail
 * entry for every timer that was still "active" across the restart so
 * there's a record that the server recovered it rather than silently
 * resuming. The actual recovery logic is just "the tick loop picks it up
 * normally" — `expiresAt` lives in the DB, not in process memory, so a
 * restart never resets or loses the deadline.
 */
const recoverPendingTimers = async () => {
  try {
    const pending = await CheckinTimer.find({ status: 'active' }).lean()
    for (const timer of pending) {
      await logEvent(timer._id, timer.user, 'recovered', { expiresAt: timer.expiresAt })
    }
    if (pending.length) {
      logger.info(`[TimerService] Recovered ${pending.length} active timer(s) from a previous run.`)
    }
    return pending.length
  } catch (err) {
    logger.error('[TimerService] Recovery scan failed:', err.message)
    return 0
  }
}

// ─── Timer CRUD / lifecycle actions ───────────────────────────────────────────

const normalizeLocation = (location) => {
  if (!location || (location.lat == null && location.lng == null)) {
    return { lat: null, lng: null, accuracy: null, capturedAt: null, source: 'none' }
  }
  return {
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy ?? null,
    capturedAt: new Date(),
    source: location.source || 'device'
  }
}

/**
 * Start (or restart) a timer for a user. Enforces "only one active timer
 * per user" and requires at least one trusted contact configured to
 * receive the alert.
 */
const startTimer = async (userId, durationSeconds, location) => {
  const existing = await CheckinTimer.findOne({ user: userId }).lean()
  if (existing && existing.status === 'active') {
    throw ApiError.conflict('A safety timer is already active. Check in or cancel it before starting a new one.')
  }

  const contactCount = await TrustedContact.countDocuments({ user: userId, notifyOnCheckin: true })
  if (contactCount === 0) {
    throw ApiError.badRequest('Add at least one trusted contact (with check-in alerts enabled) before starting a safety timer.')
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + durationSeconds * 1000)

  const timer = await CheckinTimer.findOneAndUpdate(
    { user: userId },
    {
      $set: {
        user: userId,
        durationSeconds,
        startedAt: now,
        expiresAt,
        status: 'active',
        isActive: true,
        wasTriggered: false,
        isCancelled: false,
        triggeredAt: null,
        cancelledAt: null,
        checkedInAt: null,
        deactivatedAt: null,
        lastLocation: normalizeLocation(location)
      },
      $inc: { lockVersion: 1 }
    },
    { upsert: true, new: true, runValidators: true }
  )

  warnedTimerIds.delete(String(timer._id))
  metrics.increment('timersStarted')
  await logEvent(timer._id, userId, 'started', { durationSeconds, expiresAt, location: timer.lastLocation })

  return timer
}

/**
 * Check in: immediately marks the timer safe and stops future expiry
 * processing. Distinct from cancel — a check-in implies "I'm fine," a
 * cancel implies "never mind, I didn't need this timer."
 */
const checkIn = async (userId) => {
  const now = new Date()
  const timer = await CheckinTimer.findOneAndUpdate(
    { user: userId, status: 'active' },
    {
      $set: { status: 'checked_in', isActive: false, checkedInAt: now, deactivatedAt: now },
      $inc: { lockVersion: 1 }
    },
    { new: true }
  )
  if (!timer) return null

  warnedTimerIds.delete(String(timer._id))
  metrics.increment('timersCheckedIn')
  await logEvent(timer._id, userId, 'checked_in', { checkedInAt: now })
  return timer
}

/**
 * Cancel (deactivate) the active timer for a user. Only works on an active
 * timer; prevents the alert path from ever running for it.
 */
const cancelTimer = async (userId) => {
  const now = new Date()
  const timer = await CheckinTimer.findOneAndUpdate(
    { user: userId, status: 'active' },
    {
      $set: { status: 'cancelled', isActive: false, isCancelled: true, cancelledAt: now, deactivatedAt: now },
      $inc: { lockVersion: 1 }
    },
    { new: true }
  )
  if (!timer) return null

  warnedTimerIds.delete(String(timer._id))
  metrics.increment('timersCancelled')
  await logEvent(timer._id, userId, 'cancelled', { cancelledAt: now })
  return timer
}

/**
 * Get the current timer record for a user, augmented with remainingSeconds.
 * This is the call clients use on load/reconnect to resync — the server's
 * expiresAt is always the source of truth, never the client's own clock.
 */
const getTimer = async (userId) => {
  const timer = await CheckinTimer.findOne({ user: userId }).lean()
  if (!timer) return null

  const remaining = timer.status === 'active'
    ? Math.max(0, Math.round((new Date(timer.expiresAt).getTime() - Date.now()) / 1000))
    : 0

  return { ...timer, remainingSeconds: remaining }
}

/**
 * Paginated event history for a user (started/checked_in/cancelled/
 * triggered/alert_dispatched/alert_failed/recovered).
 */
const getHistory = async (userId, { page = 1, limit = 20 } = {}) => {
  const skip = (page - 1) * limit
  const [items, total] = await Promise.all([
    SafetyTimerEvent.find({ user: userId }).sort({ occurredAt: -1 }).skip(skip).limit(limit).lean(),
    SafetyTimerEvent.countDocuments({ user: userId })
  ])
  return { items, total }
}

module.exports = {
  setIO, start, stop, recoverPendingTimers,
  startTimer, checkIn, cancelTimer, getTimer, getHistory,
  // exported for tests
  triggerTimer, runTick
}
