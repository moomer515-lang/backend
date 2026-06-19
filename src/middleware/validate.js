const Joi = require('joi')
const { ApiError } = require('../utils/apiHelpers')

const validate = (schema, source = 'body') => (req, res, next) => {
  const { error, value } = schema.validate(
    source === 'body' ? req.body : source === 'query' ? req.query : req.params,
    { abortEarly: true, stripUnknown: true, convert: true }
  )
  if (error) {
    const msg   = error.details[0].message.replace(/['"]/g, '')
    const field = error.details[0].path[0] || null
    return next(ApiError.badRequest(msg, [{ field }]))
  }
  if (source === 'body')  req.body  = value
  if (source === 'query') req.query = value
  next()
}

// ─── Reusable field definitions ───────────────────────────────────────────────
const phone = () =>
  Joi.string().pattern(/^\+?[\d\s\-()]{7,20}$/).messages({
    'string.pattern.base': 'Please provide a valid phone number'
  })

const password = () =>
  Joi.string().min(8).max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .messages({
      'string.pattern.base': 'Password must contain uppercase, lowercase and a number'
    })

// ─── Schemas ──────────────────────────────────────────────────────────────────
const schemas = {

  // Auth
  register: Joi.object({
    fullName: Joi.string().min(2).max(100).required(),
    email:    Joi.string().email().required(),
    password: password().required(),
    phone:    phone().optional().allow('', null),
    language: Joi.string().length(2).default('en')
  }),

  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required()
  }),

  ghostSession: Joi.object({
    displayName: Joi.string().min(1).max(50).default('Anonymous')
  }),

  refreshToken: Joi.object({
    refreshToken: Joi.string().required()
  }),

  // Reports
  createReport: Joi.object({
    title:              Joi.string().max(200).optional().allow('', null),
    description:        Joi.string().max(10000).optional().allow('', null),
    relationship:       Joi.string().max(100).optional().allow('', null),
    additionalContext:  Joi.string().max(5000).optional().allow('', null),
    locationName:       Joi.string().max(200).optional().allow('', null),
    locationLat:        Joi.number().min(-90).max(90).optional().allow(null),
    locationLng:        Joi.number().min(-180).max(180).optional().allow(null),
    locationObfuscated: Joi.boolean().default(true),
    selfDestruct:       Joi.boolean().default(false),
    isAnonymous:        Joi.boolean().default(false)
  }),

  updateReport: Joi.object({
    title:              Joi.string().max(200).optional(),
    description:        Joi.string().max(10000).optional(),
    relationship:       Joi.string().max(100).optional(),
    additionalContext:  Joi.string().max(5000).optional(),
    locationName:       Joi.string().max(200).optional(),
    locationLat:        Joi.number().min(-90).max(90).optional().allow(null),
    locationLng:        Joi.number().min(-180).max(180).optional().allow(null),
    locationObfuscated: Joi.boolean().optional(),
    selfDestruct:       Joi.boolean().optional(),
    currentStep:        Joi.number().integer().min(1).max(4).optional()
  }),

  updateReportStatus: Joi.object({
    status: Joi.string()
      .valid('draft', 'submitted', 'under_review', 'reviewed', 'closed', 'quarantined')
      .optional(),
    legalNotes:       Joi.string().max(3000).optional().allow('', null),
    assignedAdvocate: Joi.string().max(100).optional().allow('', null)
  }).or('status', 'legalNotes', 'assignedAdvocate'),

  // Trusted contacts
  createContact: Joi.object({
    name:            Joi.string().min(1).max(100).required(),
    email:           Joi.string().email().optional().allow('', null),
    phone:           phone().optional().allow('', null),
    relationship:    Joi.string().max(50).optional().allow('', null),
    notifyOnCheckin: Joi.boolean().default(true),
    notifyOnReport:  Joi.boolean().default(false),
    isPrimary:       Joi.boolean().default(false)
  }),

  updateContact: Joi.object({
    name:            Joi.string().min(1).max(100).optional(),
    email:           Joi.string().email().optional().allow('', null),
    phone:           phone().optional().allow('', null),
    relationship:    Joi.string().max(50).optional().allow('', null),
    notifyOnCheckin: Joi.boolean().optional(),
    notifyOnReport:  Joi.boolean().optional(),
    isPrimary:       Joi.boolean().optional()
  }),

  // Timer
  startTimer: Joi.object({
    durationSeconds: Joi.number().integer()
      .min(parseInt(process.env.TIMER_MIN_DURATION_SECONDS || '120'))
      .max(parseInt(process.env.TIMER_MAX_DURATION_SECONDS || '300'))
      .required(),
    location: Joi.object({
      lat:      Joi.number().min(-90).max(90).required(),
      lng:      Joi.number().min(-180).max(180).required(),
      accuracy: Joi.number().min(0).optional().allow(null),
      source:   Joi.string().valid('device', 'profile').default('device')
    }).optional().allow(null)
  }),

  listTimerHistory: Joi.object({
    page:  Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20)
  }),

  // Profile
  updateProfile: Joi.object({
    fullName: Joi.string().min(2).max(100).optional(),
    phone:    phone().optional().allow('', null),
    language: Joi.string().length(2).optional()
  }),

  updateLocation: Joi.object({
    lat:      Joi.number().min(-90).max(90).required(),
    lng:      Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).optional().allow(null)
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword:     password().required()
  }),

  // Query params
  listReports: Joi.object({
    page:   Joi.number().integer().min(1).default(1),
    limit:  Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid('draft','submitted','under_review','reviewed','closed','quarantined').optional(),
    search: Joi.string().max(200).optional(),
    category: Joi.string().valid('law_enforcement','traffic_transit','anti_corruption','local_services','other').optional(),
    severity: Joi.string().valid('critical','high','medium','low').optional(),
    dispatchStatus: Joi.string().valid('pending','approved','forwarded','rejected').optional()
  }),

  updateAiReview: Joi.object({
    categoryOverride: Joi.string()
      .valid('law_enforcement','traffic_transit','anti_corruption','local_services','other')
      .optional()
      .allow(null, ''),
    departmentOverride: Joi.string()
      .valid('Law Enforcement','Traffic & Transit','Anti-Corruption Bureau','Local Services Office','General Review')
      .optional()
      .allow(null, ''),
    overrideReason: Joi.string().max(1000).optional().allow('', null),
    dispatchStatus: Joi.string().valid('pending','approved','forwarded','rejected').optional(),
    forwardedTo: Joi.string().max(200).optional().allow('', null),
    dispatchNotes: Joi.string().max(1500).optional().allow('', null)
  }).min(1),

  forwardReport: Joi.object({
    forwardedTo: Joi.string().email().optional().allow('', null),
    dispatchNotes: Joi.string().max(1500).optional().allow('', null)
  }),

  listNotifications: Joi.object({
    unreadOnly: Joi.boolean().default(false),
    page:  Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20)
  })
}

module.exports = { validate, schemas }
