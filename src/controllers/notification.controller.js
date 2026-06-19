const { Notification } = require('../models/index')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

// ─── GET /api/notifications ───────────────────────────────────────────────────
const list = asyncHandler(async (req, res) => {
  const { unreadOnly, page, limit } = req.query

  const filter = { user: req.user._id }
  if (unreadOnly) filter.isRead = false

  const skip  = (page - 1) * limit
  const total = await Notification.countDocuments(filter)

  const notifications = await Notification.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean()

  const unreadCount = await Notification.countDocuments({
    user: req.user._id,
    isRead: false
  })

  return ApiResponse.paginated(res, notifications, total, page, limit, 'Notifications retrieved.')
    // Attach unreadCount to response (override paginated for extra field)
    ||
    res.status(200).json({
      success: true,
      data: {
        items: notifications,
        unreadCount,
        pagination: {
          total, page, limit,
          pages: Math.ceil(total / limit)
        }
      }
    })
})

// ─── PATCH /api/notifications/:id/read ───────────────────────────────────────
const markRead = asyncHandler(async (req, res) => {
  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  )
  if (!notif) throw ApiError.notFound('Notification not found.')
  return ApiResponse.success(res, { notification: notif }, 'Marked as read.')
})

// ─── POST /api/notifications/read-all ────────────────────────────────────────
const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.user._id, isRead: false },
    { isRead: true }
  )
  return ApiResponse.success(
    res,
    { updated: result.modifiedCount },
    `${result.modifiedCount} notification(s) marked as read.`
  )
})

// ─── DELETE /api/notifications/:id ───────────────────────────────────────────
const deleteOne = asyncHandler(async (req, res) => {
  const result = await Notification.findOneAndDelete({
    _id:  req.params.id,
    user: req.user._id
  })
  if (!result) throw ApiError.notFound('Notification not found.')
  return ApiResponse.success(res, {}, 'Notification deleted.')
})

// ─── DELETE /api/notifications ───────────────────────────────────────────────
const clearAll = asyncHandler(async (req, res) => {
  const result = await Notification.deleteMany({ user: req.user._id })
  return ApiResponse.success(
    res,
    { deleted: result.deletedCount },
    `${result.deletedCount} notification(s) cleared.`
  )
})

module.exports = { list, markRead, markAllRead, deleteOne, clearAll }
