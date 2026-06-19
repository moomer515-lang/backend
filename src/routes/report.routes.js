const router  = require('express').Router()
const rateLimit = require('express-rate-limit')

const reportCtrl   = require('../controllers/report.controller')
const evidenceCtrl = require('../controllers/evidence.controller')
const { protect }  = require('../middleware/auth')
const { validate, schemas } = require('../middleware/validate')
const { evidenceUpload, voiceUpload, handleUploadError } = require('../middleware/upload')
const { audit } = require('../middleware/errorHandler')

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { success: false, message: 'Upload rate limit exceeded. Wait a moment.' }
})

// All report routes require authentication
router.use(protect)

// ─── Reports CRUD ─────────────────────────────────────────────────────────────
router.get(  '/',       validate(schemas.listReports, 'query'), reportCtrl.listReports)
router.get(  '/stats',                                          reportCtrl.getStats)
router.get(  '/:id',                                            reportCtrl.getReport)
router.get(  '/:id/chat',                                       reportCtrl.getReportChat)
router.post( '/',       validate(schemas.createReport),         audit('report.create', 'Report'), reportCtrl.createReport)
router.put(  '/:id',    validate(schemas.updateReport),         audit('report.update', 'Report'), reportCtrl.updateReport)
router.patch('/:id/status', validate(schemas.updateReportStatus), audit('report.status_change', 'Report'), reportCtrl.updateStatus)
router.patch('/:id/ai-review', validate(schemas.updateAiReview), audit('report.ai_review', 'Report'), reportCtrl.updateAiReview)
router.post( '/:id/ai-process', audit('report.ai_process', 'Report'), reportCtrl.reprocessReport)
router.post( '/:id/forward', validate(schemas.forwardReport), audit('report.forward', 'Report'), reportCtrl.forwardReport)
router.post( '/:id/chat',                                       reportCtrl.sendReportChatMessage)
router.delete('/:id',                                           audit('report.delete', 'Report'), reportCtrl.deleteReport)

// ─── Evidence sub-routes ──────────────────────────────────────────────────────
router.post('/:id/evidence',
  uploadLimiter,
  evidenceUpload.array('files', 5),
  handleUploadError,
  audit('evidence.upload', 'Report'),
  evidenceCtrl.uploadEvidence
)
router.delete('/:id/evidence/:evidenceId',
  audit('evidence.delete', 'Report'),
  evidenceCtrl.deleteEvidence
)

// ─── Voice sub-routes ─────────────────────────────────────────────────────────
router.post('/:id/voice',
  uploadLimiter,
  voiceUpload.single('audio'),
  handleUploadError,
  audit('voice.upload', 'Report'),
  evidenceCtrl.uploadVoice
)
router.delete('/:id/voice',
  audit('voice.delete', 'Report'),
  evidenceCtrl.deleteVoice
)

module.exports = router
