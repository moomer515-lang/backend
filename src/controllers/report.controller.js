const mongoose = require('mongoose')
const path     = require('path')
const fs       = require('fs')
const Report   = require('../models/Report')
const { notifyReportUpdate } = require('../services/notification.service')
const { DEPARTMENTS, processReport } = require('../services/aiReport.service')
const { forwardReportToDepartment } = require('../services/departmentForwarding.service')
const { ApiError, ApiResponse, asyncHandler } = require('../utils/apiHelpers')

const normalizeRole = (req) => {
  const role = String(req.user?.role || '').toLowerCase()
  return role === 'admin' ? 'admin' : 'user'
}

const requireAdmin = (req) => {
  if (normalizeRole(req) !== 'admin') throw ApiError.forbidden('Admin access required.')
}

const applyForwardResult = (report, forwardResult, dispatchNotes) => {
  report.adminRouting.dispatchStatus = 'forwarded'
  report.adminRouting.forwardedTo = forwardResult.to
  report.adminRouting.dispatchNotes = dispatchNotes ?? report.adminRouting.dispatchNotes
  report.adminRouting.forwardedAt = new Date()
  report.adminRouting.forwardEmail = {
    to: forwardResult.to,
    subject: forwardResult.subject,
    outboxPath: forwardResult.outboxPath,
    attachmentCount: forwardResult.attachmentCount,
    mode: forwardResult.mode
  }
  if (!['closed', 'quarantined'].includes(report.status)) report.status = 'reviewed'
}

// ─── GET /api/reports ─────────────────────────────────────────────────────────
const listReports = asyncHandler(async (req, res) => {
  const { page = 1, limit = 8, status, search, category, severity, dispatchStatus } = req.query

  const role = normalizeRole(req)

  // Admin sees all reports
  const filter = role === 'admin'
    ? {}
    : { user: req.user._id }

  if (status) filter.status = status
  if (search) filter.$text = { $search: search }
  if (category) {
    filter.$or = [
      { 'adminRouting.categoryOverride': category },
      {
        $and: [
          { $or: [{ 'adminRouting.categoryOverride': null }, { 'adminRouting.categoryOverride': { $exists: false } }] },
          { 'aiReview.category': category }
        ]
      }
    ]
  }
  if (severity) filter['aiReview.severity'] = severity
  if (dispatchStatus) filter['adminRouting.dispatchStatus'] = dispatchStatus

  const skip = (page - 1) * limit

  const total = await Report.countDocuments(filter)
  const sort = role === 'admin'
    ? { 'aiReview.spam.isSpam': 1, 'aiReview.priorityRank': -1, updatedAt: -1 }
    : { updatedAt: -1 }

  const reports = await Report.find(filter, {
    title: 1,
    reportNumber: 1,
    status: 1,
    currentStep: 1,
    totalSteps: 1,
    locationName: 1,
    relationship: 1,
    isAnonymous: 1,
    selfDestruct: 1,
    evidence: { $slice: 0 },
    createdAt: 1,
    updatedAt: 1,
    evidenceCount: 1,
    aiReview: 1,
    adminRouting: 1,

    // optional
    user: 1
  })
    .populate('user', 'fullName email')
    .sort(sort)
    .skip(skip)
    .limit(Number(limit))
    .lean({ virtuals: true })

  const enriched = reports.map((r) => ({
    ...r,
    evidenceCount: r.evidence?.length || 0,
    evidence: undefined
  }))

  return ApiResponse.paginated(
    res,
    enriched,
    total,
    Number(page),
    Number(limit)
  )
})
// ─── GET /api/reports/stats ───────────────────────────────────────────────────
const getStats = asyncHandler(async (req, res) => {
  const role = normalizeRole(req)
  const match = role === 'admin' ? {} : { user: req.user._id }

  const stats = await Report.aggregate([
    { $match: match },
    {
      $group: {
        _id:          null,
        total:        { $sum: 1 },
        draft:        { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
        submitted:    { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
        under_review: { $sum: { $cond: [{ $eq: ['$status', 'under_review'] }, 1, 0] } },
        reviewed:     { $sum: { $cond: [{ $eq: ['$status', 'reviewed'] }, 1, 0] } },
        closed:       { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
        quarantined:  { $sum: { $cond: [{ $eq: ['$status', 'quarantined'] }, 1, 0] } },
        critical:     { $sum: { $cond: [{ $eq: ['$aiReview.severity', 'critical'] }, 1, 0] } },
        high:         { $sum: { $cond: [{ $eq: ['$aiReview.severity', 'high'] }, 1, 0] } },
        aiProcessed:  { $sum: { $cond: [{ $eq: ['$aiReview.status', 'processed'] }, 1, 0] } }
      }
    },
    { $project: { _id: 0 } }
  ])

  return ApiResponse.success(res, { stats: stats[0] || { total: 0 } })
})

// ─── GET /api/reports/:id ─────────────────────────────────────────────────────


const getReport = asyncHandler(async (req, res) => {
  const role = normalizeRole(req)

  // Admin can access any report
  const filter = {
    _id: req.params.id
  }

  // Normal users can only access their own reports
  if (role !== 'admin') {
    filter.user = req.user._id
  }

  const report = await Report.findOne(filter)
    .populate('chatMessages.sender', 'fullName email role')
    .populate('user', 'fullName email role')
    .lean({ virtuals: true })

  if (!report) {
    throw ApiError.notFound('Report not found.')
  }

  return ApiResponse.success(res, { report })
})

// ─── GET /api/reports/:id/chat ───────────────────────────────────────────────
const getReportChat = asyncHandler(async (req, res) => {
  const report = await Report.findOne({
    _id: req.params.id,
    user: req.user._id
  })
    .select('chatMessages user')
    .populate('chatMessages.sender', 'fullName')
    .lean()

  if (!report) throw ApiError.notFound('Report not found.')

  const messages = (report.chatMessages || []).map((msg) => ({
    _id: msg._id,
    senderId: msg.sender?._id || msg.sender || null,
    senderName: msg.senderName || msg.sender?.fullName || 'Unknown',
    senderRole: msg.senderRole || 'user',
    content: msg.content,
    createdAt: msg.createdAt
  }))

  return ApiResponse.success(res, { messages })
})

// ─── POST /api/reports/:id/chat ──────────────────────────────────────────────
const sendReportChatMessage = asyncHandler(async (req, res) => {
  const content = String(req.body?.content || '').trim()
  if (!content) throw ApiError.badRequest('Message content is required.')

  const report = await Report.findOne({
    _id: req.params.id,
    user: req.user._id
  })

  if (!report) throw ApiError.notFound('Report not found.')

  const message = {
    sender: req.user._id,
    senderName: req.user.fullName || 'User',
    senderRole: normalizeRole(req),
    content
  }
  report.chatMessages.push(message)
  await report.save()

  const sentMessage = report.chatMessages[report.chatMessages.length - 1]
  const payload = {
    _id: sentMessage._id,
    reportId: report._id.toString(),
    senderId: req.user._id.toString(),
    senderName: message.senderName,
    senderRole: message.senderRole,
    content: message.content,
    createdAt: sentMessage.createdAt
  }

  const io = req.app.get('io')
  if (io) io.to(`report:${report._id}`).emit('report:chat_message', payload)

  return ApiResponse.created(res, { message: payload }, 'Message sent.')
})

// ─── POST /api/reports ────────────────────────────────────────────────────────
const createReport = asyncHandler(async (req, res) => {
  const {
    title, description, relationship, additionalContext,
    locationName, locationLat, locationLng,
    locationObfuscated, selfDestruct, isAnonymous
  } = req.body

  const reportNumber = await Report.generateReportNumber()

  const reportData = {
    reportNumber,
    user: req.user._id,
    title,
    description,
    relationship,
    additionalContext,
    locationName,
    locationObfuscated,
    selfDestruct,
    isAnonymous,
    status: 'submitted',
    currentStep: 4
  }

  // Store coordinates as GeoJSON Point
  if (locationLat != null && locationLng != null) {
    reportData.location = {
      type: 'Point',
      coordinates: [locationLng, locationLat]   // GeoJSON: [lng, lat]
    }
  }

  let report = await Report.create(reportData)
  report = await processReport(report)

  return ApiResponse.created(res, { report }, 'Report created successfully.')
})

// ─── PUT /api/reports/:id ─────────────────────────────────────────────────────
const updateReport = asyncHandler(async (req, res) => {
  const report = await Report.findOne({ _id: req.params.id, user: req.user._id })
  if (!report) throw ApiError.notFound('Report not found.')
  if (report.status === 'closed') throw ApiError.forbidden('Cannot edit a closed report.')

  const allowed = [
    'title', 'description', 'relationship', 'additionalContext',
    'locationName', 'locationObfuscated', 'selfDestruct', 'currentStep'
  ]

  for (const key of allowed) {
    if (req.body[key] !== undefined) report[key] = req.body[key]
  }

  // Update location if coordinates provided
  if (req.body.locationLat != null && req.body.locationLng != null) {
    report.location = {
      type: 'Point',
      coordinates: [req.body.locationLng, req.body.locationLat]
    }
  }

  await report.save()
  await processReport(report)

  return ApiResponse.success(res, { report }, 'Report updated.')
})

// ─── PATCH /api/reports/:id/status ───────────────────────────────────────────
const updateStatus = asyncHandler(async (req, res) => {
  const { status, legalNotes, assignedAdvocate } = req.body

  const filter = { _id: req.params.id }
  if (normalizeRole(req) !== 'admin') filter.user = req.user._id

  const report = await Report.findOne(filter)
  if (!report) throw ApiError.notFound('Report not found.')

  if (status != null) report.status = status
  if (legalNotes       != null) report.legalNotes       = legalNotes
  if (assignedAdvocate != null) report.assignedAdvocate = assignedAdvocate

  await report.save()

  // Notify owner
  await notifyReportUpdate(report.user.toString(), report.reportNumber, report.status)

  // Real-time push via Socket.io
  const io = req.app.get('io')
  if (io) {
    io.to(`user:${report.user}`).emit('report:updated', {
      reportNumber: report.reportNumber,
      status: report.status,
      message: `Your report ${report.reportNumber} has been updated to: ${report.status}`
    })
  }

  return ApiResponse.success(res, { report }, 'Status updated.')
})

// â”€â”€â”€ PATCH /api/reports/:id/ai-review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const updateAiReview = asyncHandler(async (req, res) => {
  requireAdmin(req)

  const report = await Report.findById(req.params.id)
  if (!report) throw ApiError.notFound('Report not found.')

  const {
    categoryOverride, departmentOverride, overrideReason,
    dispatchStatus, forwardedTo, dispatchNotes
  } = req.body

  if (categoryOverride !== undefined) {
    report.adminRouting.categoryOverride = categoryOverride || null
    report.adminRouting.departmentOverride = categoryOverride
      ? (departmentOverride || DEPARTMENTS[categoryOverride] || 'General Review')
      : null
  } else if (departmentOverride !== undefined) {
    report.adminRouting.departmentOverride = departmentOverride || null
  }

  if (overrideReason !== undefined) report.adminRouting.overrideReason = overrideReason
  if (dispatchStatus !== undefined) report.adminRouting.dispatchStatus = dispatchStatus
  if (forwardedTo !== undefined) report.adminRouting.forwardedTo = forwardedTo
  if (dispatchNotes !== undefined) report.adminRouting.dispatchNotes = dispatchNotes

  report.adminRouting.reviewedBy = req.user._id
  report.adminRouting.reviewedAt = new Date()

  let forwardResult = null
  if (dispatchStatus === 'forwarded') {
    forwardResult = await forwardReportToDepartment(report, {
      to: forwardedTo,
      notes: dispatchNotes
    })
    applyForwardResult(report, forwardResult, dispatchNotes)
  } else if (dispatchStatus === 'approved' && report.status === 'submitted') {
    report.status = 'under_review'
  } else if (dispatchStatus === 'rejected') {
    report.status = 'quarantined'
  }

  await report.save()

  if (['approved', 'forwarded', 'rejected'].includes(dispatchStatus)) {
    await notifyReportUpdate(report.user.toString(), report.reportNumber, report.status)
  }

  return ApiResponse.success(res, { report, forward: forwardResult }, 'AI review updated.')
})

// â”€â”€â”€ POST /api/reports/:id/ai-process â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const reprocessReport = asyncHandler(async (req, res) => {
  requireAdmin(req)

  const report = await Report.findById(req.params.id)
  if (!report) throw ApiError.notFound('Report not found.')

  const processed = await processReport(report)
  return ApiResponse.success(res, { report: processed }, 'Report processed by AI.')
})

// ─── DELETE /api/reports/:id ──────────────────────────────────────────────────
const forwardReport = asyncHandler(async (req, res) => {
  requireAdmin(req)

  const report = await Report.findById(req.params.id)
  if (!report) throw ApiError.notFound('Report not found.')
  if (report.status === 'quarantined') {
    throw ApiError.badRequest('Quarantined reports must be approved before forwarding.')
  }

  const forwardResult = await forwardReportToDepartment(report, {
    to: req.body?.forwardedTo,
    notes: req.body?.dispatchNotes
  })

  report.adminRouting.reviewedBy = req.user._id
  report.adminRouting.reviewedAt = new Date()
  applyForwardResult(report, forwardResult, req.body?.dispatchNotes)
  await report.save()

  await notifyReportUpdate(report.user.toString(), report.reportNumber, report.status)

  return ApiResponse.success(res, { report, forward: forwardResult }, 'Report forwarded to department.')
})

const deleteReport = asyncHandler(async (req, res) => {
  const filter = { _id: req.params.id }
  if (normalizeRole(req) !== 'admin') filter.user = req.user._id

  const report = await Report.findOne(filter)
  if (!report) throw ApiError.notFound('Report not found.')

  // Remove physical evidence files from disk
  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')
  for (const ev of report.evidence) {
    const filePath = path.join(UPLOAD_DIR, 'evidence', ev.storedName)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
  if (report.voiceUrl) {
    const voicePath = path.join(UPLOAD_DIR, 'voice', path.basename(report.voiceUrl))
    if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath)
  }

  await report.deleteOne()

  return ApiResponse.success(res, {}, 'Report and all associated files deleted.')
})

module.exports = {
  listReports, getStats, getReport,
  createReport, updateReport, updateStatus, deleteReport,
  updateAiReview, reprocessReport, forwardReport,
  getReportChat, sendReportChatMessage
}
