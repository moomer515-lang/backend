const mongoose = require('mongoose')
const { AuditLog } = require('../models/index')
const logger = require('../utils/logger')
const { ApiError } = require('../utils/apiHelpers')

// ─── Global Error Handler ─────────────────────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  let error = { ...err }
  error.message = err.message

  // Log all server errors
  if (!err.isOperational || err.statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} — ${err.message}`, {
      stack: err.stack,
      userId: req.user?._id
    })
  }

  // Mongoose: CastError (invalid ObjectId)
  if (err.name === 'CastError') {
    error = ApiError.badRequest(`Invalid value for field: ${err.path}`)
  }

  // Mongoose: duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field'
    const value = err.keyValue?.[field]
    error = ApiError.conflict(`${field} '${value}' is already taken.`)
  }

  // Mongoose: validation errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message)
    error = ApiError.badRequest(messages[0], messages.map((m) => ({ message: m })))
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError')  error = ApiError.unauthorized('Invalid token.')
  if (err.name === 'TokenExpiredError')  error = new ApiError('Token expired.', 401, [{ code: 'TOKEN_EXPIRED' }])

  const statusCode = error.statusCode || 500
  const message    = error.message    || 'Internal server error.'

  res.status(statusCode).json({
    success: false,
    message,
    ...(error.errors?.length ? { errors: error.errors } : {}),
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {})
  })
}

// ─── 404 handler ─────────────────────────────────────────────────────────────
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`
  })
}

// ─── Audit log middleware factory ─────────────────────────────────────────────
// Usage: router.post('/', audit('report.create', 'Report'), handler)
const audit = (action, resourceType = null) => (req, res, next) => {
  const originalJson = res.json.bind(res)

  res.json = (body) => {
    if (res.statusCode < 400) {
      setImmediate(() => {
        AuditLog.create({
          user:         req.user?._id || null,
          action,
          resourceType,
          resourceId:   body?.data?._id?.toString() ||
                        body?.data?.report?._id?.toString() ||
                        req.params?.id || null,
          ipAddress:    req.ip,
          userAgent:    req.headers['user-agent']?.slice(0, 300),
          metadata:     { method: req.method, path: req.originalUrl }
        }).catch(() => { /* non-fatal */ })
      })
    }
    return originalJson(body)
  }
  next()
}

module.exports = { errorHandler, notFound, audit }
