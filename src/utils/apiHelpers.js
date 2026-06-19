// ─── ApiError ─────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, statusCode = 400, errors = []) {
    super(message)
    this.statusCode = statusCode
    this.errors     = errors
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }

  static badRequest(msg, errors)    { return new ApiError(msg, 400, errors) }
  static unauthorized(msg = 'Unauthorized')   { return new ApiError(msg, 401) }
  static forbidden(msg = 'Forbidden')         { return new ApiError(msg, 403) }
  static notFound(msg = 'Resource not found') { return new ApiError(msg, 404) }
  static conflict(msg)              { return new ApiError(msg, 409) }
  static internal(msg = 'Internal server error') { return new ApiError(msg, 500) }
}

// ─── asyncHandler ──────────────────────────────────────────────────────────────
// Wraps async route handlers to forward errors to Express error middleware
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next)
}

// ─── ApiResponse ──────────────────────────────────────────────────────────────
class ApiResponse {
  static success(res, data = {}, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({ success: true, message, data })
  }
  static created(res, data = {}, message = 'Created') {
    return ApiResponse.success(res, data, message, 201)
  }
  static paginated(res, items, total, page, limit, message = 'Success') {
    return res.status(200).json({
      success: true, message,
      data: {
        items,
        pagination: {
          total,
          page:  parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
          hasNext: parseInt(page) * parseInt(limit) < total,
          hasPrev: parseInt(page) > 1
        }
      }
    })
  }
}

module.exports = { ApiError, asyncHandler, ApiResponse }
