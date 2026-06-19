const path = require('path')
const fs   = require('fs')
const User            = require('../models/User')
const Report          = require('../models/Report')
const { TrustedContact } = require('../models/index')
const { revokeAllUserTokens } = require('../services/token.service')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')

// ─── GET /api/profile ─────────────────────────────────────────────────────────
const getProfile = asyncHandler(async (req, res) => {
  const [user, reportCount, contactCount] = await Promise.all([
    User.findById(req.user._id),
    Report.countDocuments({ user: req.user._id }),
    TrustedContact.countDocuments({ user: req.user._id })
  ])

  return ApiResponse.success(res, {
    user,
    stats: { reports: reportCount, contacts: contactCount }
  })
})

// ─── PUT /api/profile ─────────────────────────────────────────────────────────
const updateProfile = asyncHandler(async (req, res) => {
  const { fullName, phone, language } = req.body
  const user = await User.findById(req.user._id)

  if (fullName  != null) user.fullName = fullName
  if (phone     != null) user.phone    = phone || undefined
  if (language  != null) user.language = language

  await user.save()
  return ApiResponse.success(res, { user }, 'Profile updated.')
})

// ─── PUT /api/profile/location ────────────────────────────────────────────────
// Auto-saved by the client in the background (app open / periodic ping), so
// there's always a recent location on file even if the user denies/misses
// the one-shot prompt shown when a safety timer starts.
const updateLocation = asyncHandler(async (req, res) => {
  const { lat, lng, accuracy } = req.body
  await User.findByIdAndUpdate(req.user._id, {
    lastLocation: { lat, lng, accuracy: accuracy ?? null, capturedAt: new Date() }
  })
  return ApiResponse.success(res, {}, 'Location saved.')
})

// ─── POST /api/profile/password ───────────────────────────────────────────────
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body

  if (req.user.mode === 'ghost') {
    throw ApiError.forbidden('Ghost users cannot set passwords.')
  }

  const user = await User.findById(req.user._id).select('+passwordHash')
  const valid = await user.comparePassword(currentPassword)
  if (!valid) throw ApiError.unauthorized('Current password is incorrect.')

  user.passwordHash       = await User.hashPassword(newPassword)
  user.passwordChangedAt  = new Date()
  await user.save()

  // Revoke all other sessions so re-login is required everywhere
  await revokeAllUserTokens(user._id)

  return ApiResponse.success(res, {}, 'Password changed. Please log in again on all devices.')
})

// ─── POST /api/profile/avatar ─────────────────────────────────────────────────
const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No image file provided.')

  const user = await User.findById(req.user._id)

  // Delete old avatar file from disk
  if (user.avatarUrl) {
    const oldPath = path.join(UPLOAD_DIR, 'avatars', path.basename(user.avatarUrl))
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  }

  user.avatarUrl = `/uploads/avatars/${req.file.filename}`
  await user.save()

  return ApiResponse.success(res, { avatarUrl: user.avatarUrl }, 'Avatar updated.')
})

// ─── DELETE /api/profile/avatar ───────────────────────────────────────────────
const deleteAvatar = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
  if (!user.avatarUrl) throw ApiError.notFound('No avatar to delete.')

  const filePath = path.join(UPLOAD_DIR, 'avatars', path.basename(user.avatarUrl))
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  user.avatarUrl = null
  await user.save()

  return ApiResponse.success(res, {}, 'Avatar deleted.')
})

// ─── DELETE /api/profile ──────────────────────────────────────────────────────
// Soft delete: anonymize PII, keep reports for legal purposes
const deleteAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)

  // Revoke all sessions
  await revokeAllUserTokens(user._id)

  // Remove avatar file
  if (user.avatarUrl) {
    const avatarPath = path.join(UPLOAD_DIR, 'avatars', path.basename(user.avatarUrl))
    if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath)
  }

  // Anonymise user — mark as deleted but keep record for FK integrity
  user.fullName          = 'Deleted User'
  user.email             = undefined
  user.phone             = undefined
  user.passwordHash      = undefined
  user.avatarUrl         = null
  user.isDeleted         = true
  user.accountDeletedAt  = new Date()
  await user.save({ validateBeforeSave: false })

  return ApiResponse.success(res, {}, 'Account deleted. Reports retained for legal compliance.')
})

module.exports = {
  getProfile, updateProfile,
  updateLocation,
  changePassword,
  uploadAvatar, deleteAvatar,
  deleteAccount
}
