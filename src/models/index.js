const mongoose = require('mongoose')

// ─── TrustedContact ───────────────────────────────────────────────────────────
const trustedContactSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    name:         { type: String, required: true, trim: true, maxlength: 100 },
    email:        { type: String, lowercase: true, trim: true },
    phone:        { type: String, trim: true },
    relationship: { type: String, trim: true, maxlength: 50 },
    notifyOnCheckin: { type: Boolean, default: true },
    notifyOnReport:  { type: Boolean, default: false },
    isPrimary:       { type: Boolean, default: false }
  },
  {
    timestamps: true,
    toJSON: { transform(doc, ret) { delete ret.__v; return ret } }
  }
)

trustedContactSchema.pre('validate', function (next) {
  if (!this.email && !this.phone) {
    return next(new Error('A trusted contact must have at least one of: email, phone.'))
  }
  next()
})


// ─── CheckinTimer (SafetyTimer) ────────────────────────────────────────────────
// Status lifecycle: active -> (checked_in | cancelled | triggered)
// "expired" is a derived/transient state — the worker flips an active timer
// whose expiresAt has passed straight to "triggered" once the alert decision
// is made, so persisted state never sits in a plain "expired" limbo.
const TIMER_STATUSES = ['active', 'checked_in', 'cancelled', 'triggered']

const checkinTimerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true   // one timer DOCUMENT per user — re-used across the lifecycle,
                      // but only one may be in the "active" status at a time
    },
    durationSeconds: { type: Number, required: true, min: 60 },
    startedAt:  { type: Date, required: true, default: Date.now },
    expiresAt:  { type: Date, required: true, index: true },

    status: { type: String, enum: TIMER_STATUSES, default: 'active', index: true },

    // Legacy/derived flags kept for backward compatibility with existing
    // frontend + queries; always kept in sync with `status`.
    isActive:     { type: Boolean, default: true, index: true },
    wasTriggered: { type: Boolean, default: false },
    isCancelled:  { type: Boolean, default: false },

    triggeredAt:   { type: Date, default: null },
    cancelledAt:   { type: Date, default: null },
    checkedInAt:   { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },

    // Optimistic lock token — bumped on every state transition so the
    // expiry worker can atomically claim a timer with a conditional update
    // (compare-and-swap) instead of a blind findByIdAndUpdate.
    lockVersion: { type: Number, default: 0 },

    lastLocation: {
      lat:        { type: Number, min: -90,  max: 90,  default: null },
      lng:        { type: Number, min: -180, max: 180, default: null },
      accuracy:   { type: Number, default: null },
      capturedAt: { type: Date, default: null },
      source:     { type: String, enum: ['device', 'profile', 'none'], default: 'none' }
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) { delete ret.__v; return ret }
    }
  }
)

checkinTimerSchema.virtual('remainingSeconds').get(function () {
  if (this.status !== 'active') return 0
  return Math.max(0, Math.round((this.expiresAt.getTime() - Date.now()) / 1000))
})

checkinTimerSchema.index({ status: 1, expiresAt: 1 })


// ─── SafetyTimerEvent ──────────────────────────────────────────────────────────
// Append-only audit trail for every meaningful transition of a safety timer.
const TIMER_EVENT_TYPES = [
  'started', 'checked_in', 'cancelled', 'triggered',
  'alert_dispatched', 'alert_failed', 'recovered'
]

const safetyTimerEventSchema = new mongoose.Schema(
  {
    timer: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckinTimer', required: true, index: true },
    user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:  { type: String, enum: TIMER_EVENT_TYPES, required: true, index: true },
    detail:   { type: mongoose.Schema.Types.Mixed, default: null },
    occurredAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true,
    toJSON: { transform(doc, ret) { delete ret.__v; return ret } }
  }
)

safetyTimerEventSchema.index({ timer: 1, occurredAt: 1 })
// Auto-delete events after 1 year, same retention as AuditLog
safetyTimerEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 })


// ─── Notification ─────────────────────────────────────────────────────────────
const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    type: {
      type: String,
      required: true,
      enum: ['welcome', 'report_update', 'timer_expired', 'contact_added', 'system']
    },
    title:    { type: String, required: true, maxlength: 200 },
    body:     { type: String, required: true, maxlength: 1000 },
    isRead:   { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  {
    timestamps: true,
    toJSON: { transform(doc, ret) { delete ret.__v; return ret } }
  }
)

// Auto-delete notifications older than 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 })
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 })


// ─── SupportResource ──────────────────────────────────────────────────────────
const supportResourceSchema = new mongoose.Schema(
  {
    category:    { type: String, required: true },
    title:       { type: String, required: true },
    description: { type: String, required: true },
    actionLabel: { type: String, required: true },
    icon:        { type: String, required: true },
    url:         { type: String },
    phone:       { type: String },
    isActive:    { type: Boolean, default: true },
    sortOrder:   { type: Number, default: 0 }
  },
  {
    timestamps: true,
    toJSON: { transform(doc, ret) { delete ret.__v; return ret } }
  }
)


// ─── AuditLog ─────────────────────────────────────────────────────────────────
const auditLogSchema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action:       { type: String, required: true, index: true },
    resourceType: { type: String },
    resourceId:   { type: String },
    ipAddress:    { type: String },
    userAgent:    { type: String, maxlength: 300 },
    metadata:     { type: mongoose.Schema.Types.Mixed }
  },
  { timestamps: true }
)

// Auto-delete audit logs after 1 year
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 })
auditLogSchema.index({ user: 1, action: 1 })


module.exports = {
  TrustedContact:   mongoose.model('TrustedContact',   trustedContactSchema),
  CheckinTimer:     mongoose.model('CheckinTimer',     checkinTimerSchema),
  SafetyTimerEvent: mongoose.model('SafetyTimerEvent', safetyTimerEventSchema),
  Notification:     mongoose.model('Notification',     notificationSchema),
  SupportResource:  mongoose.model('SupportResource',  supportResourceSchema),
  AuditLog:         mongoose.model('AuditLog',         auditLogSchema),
  TIMER_STATUSES,
  TIMER_EVENT_TYPES
}
