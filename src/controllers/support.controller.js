const { SupportResource } = require('../models/index')
const { ApiResponse, asyncHandler } = require('../utils/apiHelpers')

// ─── GET /api/support/resources ──────────────────────────────────────────────
const listResources = asyncHandler(async (req, res) => {
  const resources = await SupportResource.find({ isActive: true })
    .sort({ sortOrder: 1 })
    .lean()

  return ApiResponse.success(res, { resources })
})

// ─── GET /api/support/resources/:category ────────────────────────────────────
const byCategory = asyncHandler(async (req, res) => {
  const resources = await SupportResource.find({
    isActive:  true,
    category:  req.params.category
  }).sort({ sortOrder: 1 }).lean()

  return ApiResponse.success(res, { resources })
})

module.exports = { listResources, byCategory }
