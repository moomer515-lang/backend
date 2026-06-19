const fs = require('fs/promises')
const path = require('path')

const { DEPARTMENTS } = require('./aiReport.service')

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')
const OUTBOX_DIR = path.resolve(process.env.FORWARD_OUTBOX_DIR || './outbox/department-forwards')
const API_PUBLIC_URL = String(process.env.API_PUBLIC_URL || 'http://localhost:8000').replace(/\/$/, '')

const DEPARTMENT_EMAILS = {
  law_enforcement: 'police.intake@example.gov',
  traffic_transit: 'traffic.transit@example.gov',
  anti_corruption: 'anti-corruption@example.gov',
  local_services: 'local-services@example.gov',
  other: 'general-review@example.gov'
}

const emailSafe = (value) =>
  String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()

const cleanText = (value, fallback = '') =>
  String(value || fallback).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()

const wrapBase64 = (value) => String(value || '').replace(/.{1,76}/g, '$&\r\n').trim()

const encodeHeader = (value) => {
  const text = emailSafe(value)
  return /^[\x00-\x7F]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

const safeFileName = (value) =>
  emailSafe(value || 'attachment')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'attachment'

const resolveCategory = (report) =>
  report.adminRouting?.categoryOverride || report.aiReview?.category || 'other'

const resolveDepartment = (report) =>
  report.adminRouting?.departmentOverride ||
  report.aiReview?.department ||
  DEPARTMENTS[resolveCategory(report)] ||
  'General Review'

const getAttachmentPath = (item, kind) => {
  const fileName = item.storedName || path.basename(item.fileUrl || '')
  if (!fileName) return null
  return path.join(UPLOAD_DIR, kind, fileName)
}

const readAttachment = async (item, kind) => {
  const filePath = getAttachmentPath(item, kind)
  if (!filePath) return null

  try {
    const data = await fs.readFile(filePath)
    return {
      filename: safeFileName(item.originalName || path.basename(filePath)),
      mimeType: item.mimeType || 'application/octet-stream',
      data
    }
  } catch {
    return null
  }
}

const buildBody = (report, { to, department, notes }) => {
  const aiSummary = report.aiReview?.summary?.length
    ? report.aiReview.summary.map((item) => `- ${item}`).join('\n')
    : '- No AI summary available.'

  const evidenceLinks = (report.evidence || []).length
    ? report.evidence.map((ev) => `- ${ev.originalName}: ${API_PUBLIC_URL}${ev.fileUrl}`).join('\n')
    : '- No image/document evidence attached.'

  const voiceLink = report.voiceUrl
    ? `${API_PUBLIC_URL}${report.voiceUrl}`
    : 'No voice statement attached.'

  return [
    `Forwarded to: ${department} <${to}>`,
    `Report number: ${report.reportNumber}`,
    `Priority: ${report.aiReview?.severity || 'low'}`,
    `Category: ${resolveCategory(report)}`,
    '',
    'Report text',
    '-----------',
    `Title: ${cleanText(report.title, 'Untitled report')}`,
    `Description: ${cleanText(report.description, 'No description provided.')}`,
    `Additional context: ${cleanText(report.additionalContext, 'None')}`,
    `Relationship: ${cleanText(report.relationship, 'Not provided')}`,
    `Location: ${cleanText(report.locationName, 'Not provided')}`,
    '',
    'AI summary',
    '----------',
    aiSummary,
    '',
    'AI routing notes',
    '----------------',
    cleanText(report.aiReview?.routingNotes, 'No routing notes available.'),
    '',
    'Admin dispatch notes',
    '--------------------',
    cleanText(notes || report.adminRouting?.dispatchNotes, 'No dispatch notes provided.'),
    '',
    'Evidence links',
    '--------------',
    evidenceLinks,
    '',
    'Voice statement',
    '---------------',
    voiceLink,
    '',
    'Attachments',
    '-----------',
    'Images/documents and voice recordings available on disk were attached to this email draft.'
  ].join('\n')
}

const writeEml = async ({ report, to, department, notes, attachments }) => {
  await fs.mkdir(OUTBOX_DIR, { recursive: true })

  const from = emailSafe(process.env.FORWARD_FROM_EMAIL || 'noreply@nimir.local')
  const subject = `[Nimir] ${report.reportNumber} - ${department} - ${report.aiReview?.severity || 'low'} priority`
  const boundary = `nimir_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const body = buildBody(report, { to, department, notes })

  const lines = [
    `From: Nimir Safety Platform <${from}>`,
    `To: ${encodeHeader(department)} <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ]

  for (const attachment of attachments) {
    lines.push(
      '',
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      wrapBase64(attachment.data.toString('base64'))
    )
  }

  lines.push('', `--${boundary}--`, '')

  const fileName = `${safeFileName(report.reportNumber)}-${Date.now()}.eml`
  const outboxPath = path.join(OUTBOX_DIR, fileName)
  await fs.writeFile(outboxPath, lines.join('\r\n'), 'utf8')

  return { subject, outboxPath, body }
}

const collectAttachments = async (report) => {
  const evidenceAttachments = await Promise.all(
    (report.evidence || []).map((item) => readAttachment(item, 'evidence'))
  )

  const voiceAttachment = report.voiceUrl
    ? await readAttachment({
      fileUrl: report.voiceUrl,
      originalName: `voice-${report.reportNumber}.webm`,
      mimeType: 'audio/webm'
    }, 'voice')
    : null

  return [...evidenceAttachments, voiceAttachment].filter(Boolean)
}

const forwardReportToDepartment = async (report, options = {}) => {
  const category = resolveCategory(report)
  const department = resolveDepartment(report)
  const to = emailSafe(options.to || DEPARTMENT_EMAILS[category] || DEPARTMENT_EMAILS.other)
  const attachments = await collectAttachments(report)
  const email = await writeEml({
    report,
    to,
    department,
    notes: options.notes,
    attachments
  })

  return {
    to,
    department,
    category,
    subject: email.subject,
    outboxPath: email.outboxPath,
    attachmentCount: attachments.length,
    mode: 'eml_outbox'
  }
}

module.exports = {
  DEPARTMENT_EMAILS,
  forwardReportToDepartment
}
