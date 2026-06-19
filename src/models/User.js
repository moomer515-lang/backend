const mongoose = require('mongoose')
const bcrypt   = require('bcryptjs')

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      minlength: [2,   'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters']
    },
    email: {
      type: String,
      sparse: true,      // allows null for ghost users
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
    },
    phone: {
      type: String,
      trim: true,
      match: [/^\+?[\d\s\-()]{7,20}$/, 'Please provide a valid phone number']
    },
    passwordHash: {
      type: String,
      select: false      // never returned in queries by default
    },
    mode: {
      type: String,
      enum: ['registered', 'ghost'],
      default: 'registered',
      required: true
    },
    role: {
  type: String,
  enum: ['user', 'admin'],
  default: 'user'
},
    isVerified: { type: Boolean, default: false },
    avatarUrl:  { type: String, default: null },
    language:   { type: String, default: 'en', maxlength: 5 },

    // Most recent known location, saved automatically by the client in the
    // background (app open / periodic ping) — independent of the one-shot
    // capture taken when a safety timer starts. Used as a fallback so timer
    // alert emails still include a location if the live capture at trigger
    // time was denied/unavailable.
    lastLocation: {
      lat:        { type: Number, min: -90,  max: 90,  default: null },
      lng:        { type: Number, min: -180, max: 180, default: null },
      accuracy:   { type: Number, default: null },
      capturedAt: { type: Date, default: null }
    },

    // Security
    passwordChangedAt: Date,
    accountDeletedAt:  Date,
    isDeleted: { type: Boolean, default: false, select: false },

    // Ghost session expiry
    ghostExpiresAt: Date
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash
        delete ret.__v
        delete ret.isDeleted
        return ret
      }
    }
  }
)

// ─── Indexes ──────────────────────────────────────────────────────────────────
userSchema.index({ email: 1 })
userSchema.index({ mode: 1, createdAt: -1 })

// ─── Instance methods ─────────────────────────────────────────────────────────
userSchema.methods.comparePassword = async function (plain) {
  if (!this.passwordHash) return false
  return bcrypt.compare(plain, this.passwordHash)
}

userSchema.methods.changedPasswordAfter = function (jwtTimestamp) {
  if (this.passwordChangedAt) {
    return parseInt(this.passwordChangedAt.getTime() / 1000, 10) > jwtTimestamp
  }
  return false
}

// ─── Static methods ───────────────────────────────────────────────────────────
userSchema.statics.hashPassword = async function (plain) {
  return bcrypt.hash(plain, parseInt(process.env.BCRYPT_SALT_ROUNDS || '12'))
}

// Filter out soft-deleted accounts by default
userSchema.pre(/^find/, function (next) {
  this.where({ isDeleted: { $ne: true } })
  next()
})

module.exports = mongoose.model('User', userSchema)
