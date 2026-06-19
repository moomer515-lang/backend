const fs = require('fs/promises')
const path = require('path')

const Report = require('../models/Report')
const logger = require('../utils/logger')

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || ''
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads')

const DEPARTMENTS = {
  law_enforcement: 'Law Enforcement',
  traffic_transit: 'Traffic & Transit',
  anti_corruption: 'Anti-Corruption Bureau',
  local_services: 'Local Services Office',
  other: 'General Review'
}

const VALID_CATEGORIES = Object.keys(DEPARTMENTS)
const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low']
const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

const keywordGroups = {
  law_enforcement: [
    'assault', 'attack', 'murder', 'homicide', 'kill', 'weapon', 'gun', 'knife',
    'robbery', 'theft', 'stolen', 'violence', 'threat', 'kidnap', 'burglary',
    'rape', 'abuse', 'fight'
  ],
  traffic_transit: [
    'traffic', 'crash', 'accident', 'collision', 'reckless', 'speeding',
    'drunk driving', 'roadblock', 'vehicle', 'taxi', 'bus', 'train', 'parking',
    'transit', 'intersection'
  ],
  anti_corruption: [
    'bribe', 'bribery', 'fraud', 'embezzle', 'embezzlement', 'kickback',
    'corrupt', 'corruption', 'tender', 'procurement', 'official', 'malpractice',
    'extortion', 'nepotism', 'forged'
  ],
  local_services: [
    'water pipe', 'burst pipe', 'sewage', 'sanitation', 'garbage', 'waste',
    'power line', 'electricity', 'streetlight', 'pothole', 'drain', 'flood',
    'public toilet', 'infrastructure', 'sinkhole'
  ]
}

const severityKeywords = {
  critical: [
    'life threatening', 'murder', 'homicide', 'gun', 'knife', 'weapon',
    'explosion', 'fire', 'collapsed', 'live wire', 'electrocution',
    'unconscious', 'bleeding', 'kidnap'
  ],
  high: [
    'assault', 'robbery', 'rape', 'violent', 'threat', 'fraud', 'embezzle',
    'extortion', 'bribe', 'major damage', 'burst pipe', 'power line'
  ],
  medium: [
    'traffic', 'crash', 'accident', 'reckless', 'pothole', 'sanitation',
    'sewage', 'streetlight', 'water leak', 'corruption'
  ]
}

const spamKeywords = [
  'buy now', 'casino', 'crypto', 'forex', 'loan approved', 'click here',
  'free money', 'winner', 'promo code', 'subscribe'
]

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const textIncludesAny = (text, words) => words.some((word) => text.includes(word))

const cleanString = (value, fallback = '') =>
  String(value || fallback).replace(/\s+/g, ' ').trim()

const normalizeText = (value) =>
  cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const parseJsonFromText = (text) => {
  const raw = String(text || '').trim()
  const withoutFence = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('AI response did not include JSON.')
  return JSON.parse(withoutFence.slice(start, end + 1))
}

const pickCategory = (value) => {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  return VALID_CATEGORIES.includes(normalized) ? normalized : 'other'
}

const pickSeverity = (value) => {
  const normalized = cleanString(value).toLowerCase()
  return VALID_SEVERITIES.includes(normalized) ? normalized : 'low'
}

const sanitizeResult = (result, source, model, error = '') => {
  const category = pickCategory(result.category)
  const summary = Array.isArray(result.summary)
    ? result.summary.map((item) => cleanString(item)).filter(Boolean).slice(0, 6)
    : cleanString(result.summary)
      ? [cleanString(result.summary)]
      : []

  const severity = pickSeverity(result.severity)

  return {
    status: 'processed',
    model,
    source,
    category,
    department: DEPARTMENTS[category],
    severity,
    priorityRank: PRIORITY_RANK[severity],
    confidence: clamp(Number(result.confidence) || 0, 0, 1),
    summary: summary.length ? summary : ['Report received for human review.'],
    routingNotes: cleanString(result.routingNotes || result.routing_notes).slice(0, 1200),
    spam: {
      isSpam: Boolean(result.spam?.isSpam ?? result.isSpam),
      reason: cleanString(result.spam?.reason || result.spamReason || '').slice(0, 600)
    },
    duplicate: {
      isDuplicate: Boolean(result.duplicate?.isDuplicate ?? result.isDuplicate),
      reason: cleanString(result.duplicate?.reason || result.duplicateReason || '').slice(0, 600),
      possibleReport: result.duplicate?.possibleReport || result.possibleReport || null
    },
    processedAt: new Date(),
    error: cleanString(error).slice(0, 600)
  }
}

const buildReportText = (report) => {
  const evidence = (report.evidence || [])
    .map((ev) => `${ev.originalName || 'file'} (${ev.mimeType || 'unknown type'})`)
    .join(', ')

  return [
    `Report number: ${report.reportNumber || 'pending'}`,
    `Title: ${report.title || ''}`,
    `Description: ${report.description || ''}`,
    `Relationship: ${report.relationship || ''}`,
    `Additional context: ${report.additionalContext || ''}`,
    `Location: ${report.locationName || ''}`,
    `Evidence files: ${evidence || 'none'}`,
    `Voice attached: ${report.voiceUrl ? 'yes' : 'no'}`
  ].join('\n')
}

const buildPrompt = (report, duplicateContext) => `You are an AI triage engine for a civic safety reporting platform.
Classify this report for government routing and human review.

Allowed categories:
- law_enforcement: theft, violent assault, murder, weapons, public safety crimes.
- traffic_transit: traffic violations, crashes, transport and transit issues.
- anti_corruption: bribery, fraud, embezzlement, procurement abuse, official malpractice.
- local_services: broken power lines, burst water pipes, sanitation, waste, streetlights, public infrastructure.
- other: unclear cases needing general review.

Allowed severity values: critical, high, medium, low.
Critical means immediate danger to life or major infrastructure hazard.
High means serious crime, credible threat, major fraud, or serious service failure.
Medium means important but not immediately life-threatening.
Low means minor or unclear.

Also detect spam, fake/noise reports, and likely duplicates.
Return strict JSON only with this shape:
{
  "category": "law_enforcement|traffic_transit|anti_corruption|local_services|other",
  "severity": "critical|high|medium|low",
  "confidence": 0.0,
  "summary": ["short bullet", "short bullet"],
  "routingNotes": "brief routing guidance for an admin",
  "spam": { "isSpam": false, "reason": "" },
  "duplicate": { "isDuplicate": false, "reason": "" }
}

Duplicate context: ${duplicateContext || 'No matching prior report found.'}

Report:
${buildReportText(report)}`

const localClassify = (report, duplicate = {}) => {
  const text = normalizeText(buildReportText(report))
  const scores = Object.fromEntries(VALID_CATEGORIES.map((category) => [category, 0]))

  for (const [category, words] of Object.entries(keywordGroups)) {
    for (const word of words) {
      if (text.includes(word)) scores[category] += 1
    }
  }

  let category = 'other'
  let topScore = 0
  for (const [candidate, score] of Object.entries(scores)) {
    if (score > topScore) {
      category = candidate
      topScore = score
    }
  }

  let severity = 'low'
  if (textIncludesAny(text, severityKeywords.critical)) severity = 'critical'
  else if (textIncludesAny(text, severityKeywords.high)) severity = 'high'
  else if (textIncludesAny(text, severityKeywords.medium)) severity = 'medium'
  else if (topScore > 1) severity = 'medium'

  const description = cleanString(report.description || report.additionalContext || report.title)
  const summary = []
  if (description) summary.push(description.length > 180 ? `${description.slice(0, 177)}...` : description)
  if (report.locationName) summary.push(`Location: ${report.locationName}`)
  if (report.evidence?.length) summary.push(`${report.evidence.length} evidence file(s) attached`)
  if (report.voiceUrl) summary.push('Voice statement attached')

  const hasSpamKeyword = textIncludesAny(text, spamKeywords)
  const tooSparse = text.replace(/\s/g, '').length < 12 && !report.evidence?.length && !report.voiceUrl
  const repeatedChars = /(.)\1{8,}/.test(text)
  const isSpam = hasSpamKeyword || tooSparse || repeatedChars

  return {
    category,
    severity,
    confidence: topScore ? clamp(0.45 + topScore * 0.12, 0.45, 0.88) : 0.35,
    summary,
    routingNotes: `Route to ${DEPARTMENTS[category]} for ${severity} priority review.`,
    spam: {
      isSpam,
      reason: isSpam
        ? (tooSparse ? 'Report has too little usable content.' : 'Report matches spam/noise patterns.')
        : ''
    },
    duplicate: {
      isDuplicate: Boolean(duplicate.isDuplicate),
      reason: duplicate.reason || ''
    }
  }
}

const findPossibleDuplicate = async (report) => {
  const normalized = normalizeText(`${report.title || ''} ${report.description || ''}`)
  if (normalized.length < 60) return null

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const duplicate = await Report.findOne({
    _id: { $ne: report._id },
    user: report.user,
    createdAt: { $gte: sevenDaysAgo },
    description: report.description
  }).select('_id reportNumber').lean()

  if (!duplicate) return null
  return {
    isDuplicate: true,
    reason: `Very similar report was submitted recently: ${duplicate.reportNumber}.`,
    possibleReport: duplicate._id
  }
}

const loadMediaParts = async (report) => {
  const parts = []
  const media = [
    ...(report.evidence || []).filter((ev) => /^image\//.test(ev.mimeType || '')),
    ...(report.voiceUrl ? [{ mimeType: 'audio/webm', fileUrl: report.voiceUrl, storedName: path.basename(report.voiceUrl) }] : [])
  ].slice(0, 5)

  for (const item of media) {
    const kind = /^image\//.test(item.mimeType) ? 'evidence' : 'voice'
    const fileName = item.storedName || path.basename(item.fileUrl || '')
    const filePath = path.join(UPLOAD_DIR, kind, fileName)

    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 8 * 1024 * 1024) continue
      const data = await fs.readFile(filePath)
      parts.push({
        inlineData: {
          mimeType: item.mimeType || 'application/octet-stream',
          data: data.toString('base64')
        }
      })
    } catch (err) {
      logger.warn(`[AI] Could not attach media ${fileName}: ${err.message}`)
    }
  }

  return parts
}

const callGemini = async (report, duplicateContext) => {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 12000))

  try {
    const mediaParts = await loadMediaParts(report)
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: buildPrompt(report, duplicateContext) },
              ...mediaParts
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error?.message || `Gemini request failed (${response.status}).`)
    }

    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n')
    if (!text) throw new Error('Gemini returned an empty response.')
    return parseJsonFromText(text)
  } finally {
    clearTimeout(timeout)
  }
}

const persistReview = async (report, review) => {
  report.aiReview = review
  if (review.spam?.isSpam || review.duplicate?.isDuplicate) {
    report.status = 'quarantined'
  } else if (report.status === 'draft') {
    report.status = 'submitted'
  }
  await report.save()
  return report
}

const processReport = async (reportOrId, options = {}) => {
  const report = typeof reportOrId === 'string'
    ? await Report.findById(reportOrId)
    : reportOrId

  if (!report) return null
  if (options.skipIfProcessed && report.aiReview?.status === 'processed') return report

  const duplicate = await findPossibleDuplicate(report)
  const duplicateContext = duplicate?.reason || ''

  let result
  let source = 'local_rules'
  let model = 'local-rules-v1'
  let error = ''

  try {
    result = await callGemini(report, duplicateContext)
    source = 'gemini'
    model = GEMINI_MODEL
  } catch (err) {
    error = err.message
    logger.warn(`[AI] Gemini unavailable for ${report.reportNumber}: ${err.message}`)
    result = localClassify(report, duplicate || {})
  }

  if (duplicate) {
    result.duplicate = {
      ...(result.duplicate || {}),
      isDuplicate: true,
      reason: duplicate.reason,
      possibleReport: duplicate.possibleReport
    }
  }

  const review = sanitizeResult(result, source, model, error)
  return persistReview(report, review)
}

module.exports = {
  DEPARTMENTS,
  processReport,
  localClassify
}
