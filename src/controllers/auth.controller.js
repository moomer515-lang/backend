const User   = require('../models/User')
const { issueTokenPair, verifyAndRotateRefreshToken,
        revokeRefreshToken, revokeAllUserTokens } = require('../services/token.service')
const { sendWelcome } = require('../services/notification.service')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

// Helper: extract client meta for token records
const clientMeta = (req) => ({
  ipAddress: req.ip,
  userAgent: req.headers['user-agent']
})

const register = asyncHandler(async (req, res) => {
  const { fullName, email, password, phone, language } = req.body

  const exists = await User.findOne({ email }).lean()

  if (exists) {
    throw ApiError.conflict(
      'An account with this email already exists.'
    )
  }

  const passwordHash = await User.hashPassword(password)

  // Generate a unique DiceBear avatar using the user's name as seed
  const avatarSeed = encodeURIComponent(fullName || email)
  const avatarUrl = `https://api.dicebear.com/9.x/initials/svg?seed=${avatarSeed}&backgroundColor=366574&fontFamily=Arial&fontSize=42&fontWeight=700&textColor=ffffff`

  const user = await User.create({
    fullName,
    email,
    phone: phone || undefined,
    passwordHash,
    language,
    mode: 'registered',
    role: 'user',
    avatarUrl
  })

  const tokens = await issueTokenPair(
    user._id,
    clientMeta(req)
  )

  await sendWelcome(user._id, user.fullName)

  return ApiResponse.created(
    res,
    {
      user: sanitize(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    },
    'Account created successfully.'
  )
})

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body

  const user = await User.findOne({ email, mode: 'registered' }).select('+passwordHash')
  if (!user) throw ApiError.unauthorized('Invalid email or password.')

  const valid = await user.comparePassword(password)
  if (!valid) throw ApiError.unauthorized('Invalid email or password.')

  const tokens = await issueTokenPair(user._id, clientMeta(req))

  return ApiResponse.success(res, {
    user:         sanitize(user),
    accessToken:  tokens.accessToken,
    refreshToken: tokens.refreshToken
  }, 'Login successful.')
})

// ─── POST /api/auth/ghost ─────────────────────────────────────────────────────
const ghostSession = asyncHandler(async (req, res) => {
  const { displayName } = req.body

  // Ghost sessions expire in 24h — store expiry on the user document
  const ghostExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

  const user = await User.create({
    fullName: displayName || 'Anonymous',
    mode: 'ghost',
    ghostExpiresAt
  })

  // Ghost users get access token only — no refresh token
  const { signAccessToken } = require('../services/token.service')
  const accessToken = signAccessToken(user._id, '24h')

  return ApiResponse.created(res, {
    user:         sanitize(user),
    accessToken,
    refreshToken: null,
    expiresIn:    3600
  }, 'Ghost session started. No data will be stored server-side.')
})

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body

  const result = await verifyAndRotateRefreshToken(refreshToken, clientMeta(req))

  return ApiResponse.success(res, {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken
  }, 'Tokens refreshed.')
})

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body
  if (refreshToken) await revokeRefreshToken(refreshToken).catch(() => {})
  return ApiResponse.success(res, {}, 'Logged out successfully.')
})

// ─── POST /api/auth/logout-all ────────────────────────────────────────────────
const logoutAll = asyncHandler(async (req, res) => {
  await revokeAllUserTokens(req.user._id)
  return ApiResponse.success(res, {}, 'All sessions revoked.')
})

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
  return ApiResponse.success(res, { user: sanitize(user) })
})

// ─── Sanitize user doc (remove sensitive fields) ──────────────────────────────
const sanitize = (user) => {
  const obj = user.toObject ? user.toObject() : { ...user }
  delete obj.passwordHash
  delete obj.__v
  return obj
}

module.exports = { register, login, ghostSession, refresh, logout, logoutAll, me }
