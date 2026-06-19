const { verifyAccessToken } = require('../services/token.service')
const User  = require('../models/User')
const { ApiError, asyncHandler } = require('../utils/apiHelpers')

/**
 * Protect: verify Bearer token and attach req.user
 */
const protect = asyncHandler(async (req, res, next) => {
  const auth  = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null

  if (!token) throw ApiError.unauthorized('Access token required.')

  let payload
  try {
    payload = verifyAccessToken(token)
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new ApiError('Token expired. Please refresh.', 401, [{ code: 'TOKEN_EXPIRED' }])
    }
    throw ApiError.unauthorized('Invalid access token.')
  }

  const user = await User.findById(payload.sub).select('+passwordHash')
  if (!user) throw ApiError.unauthorized('Account not found or has been deleted.')

  // Invalidate tokens issued before a password change
  if (user.changedPasswordAfter(payload.iat)) {
    throw ApiError.unauthorized('Password was changed. Please log in again.')
  }

  req.user = user
  next()
})

/**
 * Require registered (non-ghost) mode
 */
const requireRegistered = (req, res, next) => {
  if (req.user?.mode === 'ghost') {
    return next(new ApiError('This feature requires a registered account.', 403, [{ code: 'GHOST_RESTRICTED' }]))
  }
  next()
}

/**
 * Optional auth — attaches req.user if valid token present, never rejects
 */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const auth  = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (token) {
    try {
      const payload = verifyAccessToken(token)
      const user    = await User.findById(payload.sub)
      if (user) req.user = user
    } catch (_) { /* silent */ }
  }
  next()
})

module.exports = { protect, requireRegistered, optionalAuth }
