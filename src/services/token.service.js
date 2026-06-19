const jwt    = require('jsonwebtoken')
const crypto = require('crypto')
const RefreshToken = require('../models/RefreshToken')

// ─── Sign tokens ──────────────────────────────────────────────────────────────
const signAccessToken = (userId, expiresIn = process.env.JWT_EXPIRES_IN || '15m') =>
  jwt.sign({ sub: userId.toString() }, process.env.JWT_SECRET, {
    expiresIn,
    issuer: 'nimir-api'
  })

const signRefreshToken = async (userId, meta = {}) => {
  const token = jwt.sign({ sub: userId.toString() }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    issuer: 'nimir-api'
  })

  const hash = crypto.createHash('sha256').update(token).digest('hex')
  const decoded = jwt.decode(token)
  const expiresAt = new Date(decoded.exp * 1000)

  await RefreshToken.create({
    user:      userId,
    tokenHash: hash,
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 300),
    ipAddress: meta.ipAddress?.slice(0, 50)
  })

  return token
}

// ─── Verify & rotate ──────────────────────────────────────────────────────────
const verifyAccessToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET)

const verifyAndRotateRefreshToken = async (rawToken, meta = {}) => {
  let payload
  try {
    payload = jwt.verify(rawToken, process.env.JWT_REFRESH_SECRET)
  } catch {
    throw new Error('Invalid or expired refresh token.')
  }

  const hash   = crypto.createHash('sha256').update(rawToken).digest('hex')
  const record = await RefreshToken.findOne({ tokenHash: hash })
  if (!record) throw new Error('Refresh token not found or already revoked.')

  // Rotate: delete old, issue new
  await record.deleteOne()

  const newAccess  = signAccessToken(payload.sub)
  const newRefresh = await signRefreshToken(payload.sub, meta)

  return { accessToken: newAccess, refreshToken: newRefresh, userId: payload.sub }
}

// ─── Revoke ───────────────────────────────────────────────────────────────────
const revokeRefreshToken = async (rawToken) => {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex')
  await RefreshToken.deleteOne({ tokenHash: hash })
}

const revokeAllUserTokens = (userId) =>
  RefreshToken.deleteMany({ user: userId })

// ─── Token pair helper ────────────────────────────────────────────────────────
const issueTokenPair = async (userId, meta = {}) => ({
  accessToken:  signAccessToken(userId),
  refreshToken: await signRefreshToken(userId, meta)
})

module.exports = {
  signAccessToken, signRefreshToken,
  verifyAccessToken, verifyAndRotateRefreshToken,
  revokeRefreshToken, revokeAllUserTokens,
  issueTokenPair
}
