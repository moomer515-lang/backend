const timerService = require('../services/timer.service')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

// ─── GET /api/timer ───────────────────────────────────────────────────────────
const getStatus = asyncHandler(async (req, res) => {
  const timer = await timerService.getTimer(req.user._id)
  return ApiResponse.success(res, { timer })
})

// ─── GET /api/timer/history ───────────────────────────────────────────────────
const history = asyncHandler(async (req, res) => {
  const { page, limit } = req.query
  const { items, total } = await timerService.getHistory(req.user._id, { page, limit })
  return ApiResponse.paginated(res, items, total, page, limit, 'Safety timer history.')
})

// ─── POST /api/timer/start ────────────────────────────────────────────────────
const start = asyncHandler(async (req, res) => {
  const { durationSeconds, location } = req.body
  // startTimer() throws (409) if a timer is already active, or (400) if the
  // user has no trusted contacts configured to receive the alert.
  const timer = await timerService.startTimer(req.user._id, durationSeconds, location)

  const io = req.app.get('io')
  if (io) {
    io.to(`user:${req.user._id}`).emit('timer_started', {
      timerId: timer._id,
      durationSeconds,
      expiresAt: timer.expiresAt,
      message: `Check-in timer started for ${Math.round(durationSeconds / 60)} min(s).`
    })
  }

  return ApiResponse.created(res, { timer }, 'Check-in timer started.')
})

// ─── POST /api/timer/check-in ─────────────────────────────────────────────────
const checkIn = asyncHandler(async (req, res) => {
  const timer = await timerService.checkIn(req.user._id)
  if (!timer) throw ApiError.notFound('No active timer to check in to.')

  const io = req.app.get('io')
  if (io) {
    io.to(`user:${req.user._id}`).emit('timer_checked_in', {
      timerId: timer._id,
      message: "You're checked in. Your trusted contacts will not be alerted."
    })
  }

  return ApiResponse.success(res, { timer }, "Checked in. You're marked safe.")
})

// ─── DELETE /api/timer/cancel ─────────────────────────────────────────────────
const cancel = asyncHandler(async (req, res) => {
  const timer = await timerService.cancelTimer(req.user._id)
  if (!timer) throw ApiError.notFound('No active timer to cancel.')

  const io = req.app.get('io')
  if (io) {
    io.to(`user:${req.user._id}`).emit('timer_cancelled', {
      timerId: timer._id,
      message: 'Check-in timer cancelled. Contacts will NOT be alerted.'
    })
  }

  return ApiResponse.success(res, { timer }, 'Timer cancelled. Your contacts will not be alerted.')
})

module.exports = { getStatus, history, start, checkIn, cancel }
