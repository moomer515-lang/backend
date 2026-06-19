const { TrustedContact } = require('../models/index')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

const MAX_CONTACTS = 5

// ─── GET /api/contacts ────────────────────────────────────────────────────────
const list = asyncHandler(async (req, res) => {
  const contacts = await TrustedContact.find({ user: req.user._id })
    .sort({ isPrimary: -1, createdAt: 1 })
    .lean()

  return ApiResponse.success(res, { contacts })
})

// ─── GET /api/contacts/:id ────────────────────────────────────────────────────
const getOne = asyncHandler(async (req, res) => {
  const contact = await TrustedContact.findOne({
    _id:  req.params.id,
    user: req.user._id
  }).lean()

  if (!contact) throw ApiError.notFound('Contact not found.')
  return ApiResponse.success(res, { contact })
})

// ─── POST /api/contacts ───────────────────────────────────────────────────────
const create = asyncHandler(async (req, res) => {
  const count = await TrustedContact.countDocuments({ user: req.user._id })
  if (count >= MAX_CONTACTS) {
    throw ApiError.badRequest(`Maximum of ${MAX_CONTACTS} trusted contacts allowed.`)
  }

  // Only one primary contact allowed
  if (req.body.isPrimary) {
    await TrustedContact.updateMany(
      { user: req.user._id },
      { isPrimary: false }
    )
  }

  const contact = await TrustedContact.create({
    ...req.body,
    user: req.user._id
  })

  return ApiResponse.created(res, { contact }, 'Trusted contact added.')
})

// ─── PUT /api/contacts/:id ────────────────────────────────────────────────────
const update = asyncHandler(async (req, res) => {
  const contact = await TrustedContact.findOne({
    _id:  req.params.id,
    user: req.user._id
  })
  if (!contact) throw ApiError.notFound('Contact not found.')

  // Demote others if setting this one as primary
  if (req.body.isPrimary === true) {
    await TrustedContact.updateMany(
      { user: req.user._id, _id: { $ne: contact._id } },
      { isPrimary: false }
    )
  }

  const allowed = [
    'name', 'email', 'phone', 'relationship',
    'notifyOnCheckin', 'notifyOnReport', 'isPrimary'
  ]
  for (const key of allowed) {
    if (req.body[key] !== undefined) contact[key] = req.body[key]
  }

  await contact.save()
  return ApiResponse.success(res, { contact }, 'Contact updated.')
})

// ─── DELETE /api/contacts/:id ─────────────────────────────────────────────────
const remove = asyncHandler(async (req, res) => {
  const result = await TrustedContact.findOneAndDelete({
    _id:  req.params.id,
    user: req.user._id
  })
  if (!result) throw ApiError.notFound('Contact not found.')
  return ApiResponse.success(res, {}, 'Contact removed.')
})

module.exports = { list, getOne, create, update, remove }
