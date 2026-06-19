const mongoose = require('mongoose')

// ─── Evidence sub-document ────────────────────────────────────────────────────
const evidenceSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedName:   { type: String, required: true },
    mimeType:     { type: String, required: true },
    fileSize:     { type: Number, required: true },  // bytes
    fileUrl:      { type: String, required: true },
    isEncrypted:  { type: Boolean, default: true }
  },
  { timestamps: true }
)

const chatMessageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    senderName: { type: String, required: true, trim: true, maxlength: 120 },
    senderRole: { type: String, enum: ['admin', 'user'], default: 'user' },
    content: { type: String, required: true, trim: true, maxlength: 2000 }
  },
  { timestamps: true }
)

const aiReviewSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'processed', 'failed', 'skipped'],
      default: 'pending',
      index: true
    },
    model: { type: String, trim: true },
    source: {
      type: String,
      enum: ['gemini', 'local_rules'],
      default: 'local_rules'
    },
    category: {
      type: String,
      enum: ['law_enforcement', 'traffic_transit', 'anti_corruption', 'local_services', 'other'],
      default: 'other',
      index: true
    },
    department: {
      type: String,
      enum: ['Law Enforcement', 'Traffic & Transit', 'Anti-Corruption Bureau', 'Local Services Office', 'General Review'],
      default: 'General Review'
    },
    severity: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'low',
      index: true
    },
    priorityRank: { type: Number, min: 1, max: 4, default: 1, index: true },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    summary: [{ type: String, trim: true, maxlength: 300 }],
    routingNotes: { type: String, trim: true, maxlength: 1200 },
    spam: {
      isSpam: { type: Boolean, default: false, index: true },
      reason: { type: String, trim: true, maxlength: 600 }
    },
    duplicate: {
      isDuplicate: { type: Boolean, default: false },
      reason: { type: String, trim: true, maxlength: 600 },
      possibleReport: { type: mongoose.Schema.Types.ObjectId, ref: 'Report' }
    },
    processedAt: Date,
    error: { type: String, trim: true, maxlength: 600 }
  },
  { _id: false }
)

const adminRoutingSchema = new mongoose.Schema(
  {
    categoryOverride: {
      type: String,
      enum: ['law_enforcement', 'traffic_transit', 'anti_corruption', 'local_services', 'other', null],
      default: null
    },
    departmentOverride: {
      type: String,
      enum: ['Law Enforcement', 'Traffic & Transit', 'Anti-Corruption Bureau', 'Local Services Office', 'General Review', null],
      default: null
    },
    overrideReason: { type: String, trim: true, maxlength: 1000 },
    dispatchStatus: {
      type: String,
      enum: ['pending', 'approved', 'forwarded', 'rejected'],
      default: 'pending',
      index: true
    },
    forwardedTo: { type: String, trim: true, maxlength: 200 },
    dispatchNotes: { type: String, trim: true, maxlength: 1500 },
    forwardEmail: {
      to: { type: String, trim: true, maxlength: 200 },
      subject: { type: String, trim: true, maxlength: 300 },
      outboxPath: { type: String, trim: true, maxlength: 500 },
      attachmentCount: { type: Number, default: 0 },
      mode: { type: String, enum: ['eml_outbox'], default: 'eml_outbox' }
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    forwardedAt: Date
  },
  { _id: false }
)

// ─── Report schema ────────────────────────────────────────────────────────────
const reportSchema = new mongoose.Schema(
  {
    reportNumber: {
      type: String,
      unique: true,
      required: true,
      uppercase: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    title:             { type: String, trim: true, maxlength: 200 },
    description:       { type: String, maxlength: 10000 },
    relationship:      { type: String, trim: true, maxlength: 100 },
    additionalContext: { type: String, maxlength: 5000 },

    // Location
    locationName:      { type: String, maxlength: 200 },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }  // [lng, lat]
    },
    locationObfuscated: { type: Boolean, default: true },

    // Flags
    selfDestruct: { type: Boolean, default: false },
    isAnonymous:  { type: Boolean, default: false },

    // Media
    voiceUrl: { type: String, default: null },
    evidence: [evidenceSchema],
    chatMessages: [chatMessageSchema],

    // AI-assisted processing and admin routing
    aiReview: { type: aiReviewSchema, default: () => ({}) },
    adminRouting: { type: adminRoutingSchema, default: () => ({}) },

    // Status workflow
    status: {
      type: String,
      enum: ['draft', 'submitted', 'under_review', 'reviewed', 'closed', 'quarantined'],
      default: 'draft',
      index: true
    },
    currentStep: { type: Number, default: 1, min: 1, max: 4 },
    totalSteps:  { type: Number, default: 4 },

    // Case management
    assignedAdvocate: { type: String, trim: true },
    legalNotes:       { type: String, maxlength: 3000 },

    // Metadata
    statusHistory: [
      {
        status:    { type: String },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note:      String,
        changedAt: { type: Date, default: Date.now }
      }
    ]
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v
        return ret
      }
    }
  }
)

// ─── Indexes ──────────────────────────────────────────────────────────────────
reportSchema.index({ user: 1, status: 1 })
reportSchema.index({ user: 1, createdAt: -1 })
reportSchema.index({ 'aiReview.category': 1, 'aiReview.severity': 1, updatedAt: -1 })
reportSchema.index({ 'adminRouting.dispatchStatus': 1, updatedAt: -1 })
reportSchema.index({ location: '2dsphere' })
reportSchema.index({
  title: 'text',
  description: 'text',
  reportNumber: 'text'
}, { name: 'report_text_search' })

// ─── Virtuals ─────────────────────────────────────────────────────────────────
reportSchema.virtual('evidenceCount').get(function () {
  return this.evidence?.length || 0
})

reportSchema.virtual('effectiveCategory').get(function () {
  return this.adminRouting?.categoryOverride || this.aiReview?.category || 'other'
})

reportSchema.virtual('effectiveDepartment').get(function () {
  return this.adminRouting?.departmentOverride || this.aiReview?.department || 'General Review'
})

// ─── Pre-save: record status changes ─────────────────────────────────────────
reportSchema.pre('save', function (next) {
  if (this.isModified('status') && !this.isNew) {
    this.statusHistory.push({ status: this.status, changedAt: new Date() })
  }
  next()
})

// ─── Static: generate unique report number ────────────────────────────────────
reportSchema.statics.generateReportNumber = async function () {
  const year = new Date().getFullYear()
  let number
  let exists = true
  while (exists) {
    const rand = Math.floor(1000 + Math.random() * 9000)
    number = `NMR-${year}-${rand}`
    exists = await this.exists({ reportNumber: number })
  }
  return number
}

module.exports = mongoose.model('Report', reportSchema)
