const mongoose = require('mongoose')

const refreshTokenSchema = new mongoose.Schema(
  {
    user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, index: true },
    expiresAt: { type: Date,   required: true },
    userAgent: { type: String, maxlength: 300 },
    ipAddress: { type: String, maxlength: 50 }
  },
  { timestamps: true }
)

// Auto-remove expired tokens (MongoDB TTL index)
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
refreshTokenSchema.index({ user: 1 })

module.exports = mongoose.model('RefreshToken', refreshTokenSchema)
