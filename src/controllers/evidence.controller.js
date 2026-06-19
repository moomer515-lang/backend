const path   = require('path')
const fs     = require('fs')
const Report = require('../models/Report')
const { processReport } = require('../services/aiReport.service')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')

const normalizeRole = (req) => String(req.user?.role || '').toLowerCase() === 'admin' ? 'admin' : 'user'

const reportAccessFilter = (req) => {
  const filter = { _id: req.params.id }
  if (normalizeRole(req) !== 'admin') filter.user = req.user._id
  return filter
}

// ─── POST /api/reports/:id/evidence ──────────────────────────────────────────
const uploadEvidence = asyncHandler(async (req, res) => {
  if (!req.files?.length) throw ApiError.badRequest('No files uploaded.')

  const report = await Report.findOne(reportAccessFilter(req))
  if (!report) throw ApiError.notFound('Report not found.')

  const newEvidence = req.files.map((file) => ({
    originalName: file.originalname,
    storedName:   file.filename,
    mimeType:     file.mimetype,
    fileSize:     file.size,
    fileUrl:      `/uploads/evidence/${file.filename}`,
    isEncrypted:  true
  }))

  report.evidence.push(...newEvidence)
  await report.save()
  await processReport(report)

  return ApiResponse.created(
    res,
    { evidence: newEvidence, totalEvidenceCount: report.evidence.length, aiReview: report.aiReview },
    `${newEvidence.length} file(s) uploaded successfully.`
  )
})

// ─── DELETE /api/reports/:id/evidence/:evidenceId ────────────────────────────
const deleteEvidence = asyncHandler(async (req, res) => {
  const report = await Report.findOne(reportAccessFilter(req))
  if (!report) throw ApiError.notFound('Report not found.')

  const evItem = report.evidence.id(req.params.evidenceId)
  if (!evItem) throw ApiError.notFound('Evidence item not found.')

  // Remove physical file
  const filePath = path.join(UPLOAD_DIR, 'evidence', evItem.storedName)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  evItem.deleteOne()
  await report.save()
  await processReport(report)

  return ApiResponse.success(res, {}, 'Evidence file deleted.')
})

// ─── POST /api/reports/:id/voice ─────────────────────────────────────────────
const uploadVoice = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No audio file uploaded.')

  const report = await Report.findOne(reportAccessFilter(req))
  if (!report) throw ApiError.notFound('Report not found.')

  // Remove old voice file if it exists
  if (report.voiceUrl) {
    const oldPath = path.join(UPLOAD_DIR, 'voice', path.basename(report.voiceUrl))
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
  }

  report.voiceUrl = `/uploads/voice/${req.file.filename}`
  await report.save()
  await processReport(report)

  return ApiResponse.success(
    res,
    { voiceUrl: report.voiceUrl, aiReview: report.aiReview },
    'Voice recording saved.'
  )
})

// ─── DELETE /api/reports/:id/voice ───────────────────────────────────────────
const deleteVoice = asyncHandler(async (req, res) => {
  const report = await Report.findOne(reportAccessFilter(req))
  if (!report) throw ApiError.notFound('Report not found.')
  if (!report.voiceUrl) throw ApiError.notFound('No voice recording on this report.')

  const filePath = path.join(UPLOAD_DIR, 'voice', path.basename(report.voiceUrl))
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

  report.voiceUrl = null
  await report.save()
  await processReport(report)

  return ApiResponse.success(res, {}, 'Voice recording deleted.')
})

module.exports = { uploadEvidence, deleteEvidence, uploadVoice, deleteVoice }
