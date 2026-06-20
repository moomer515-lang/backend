const nodemailer = require('nodemailer')
const { Notification, TrustedContact } = require('../models/index')
const User   = require('../models/User')
const logger = require('../utils/logger')

// ─── In-app notification ──────────────────────────────────────────────────────
const createNotification = async (userId, type, title, body, metadata = null) => {
  try {
    return await Notification.create({ user: userId, type, title, body, metadata })
  } catch (err) {
    logger.error('[NotificationService] DB create error:', err.message)
    return null
  }
}



// ─── Email (Gmail via nodemailer, authenticated with an App Password) ────────
// Lazily created + cached so a missing/invalid config fails fast on first
// send rather than at module load time (keeps tests, which mock sendEmail
// directly, from ever touching this).
let _transporter = null
const getTransporter = () => {
  if (_transporter) return _transporter

  const user = process.env.SMTP_USER
  const pass = (process.env.APP_PASSWORDS || process.env.SMTP_PASS || '').replace(/\s+/g, '')

  if (!user || !pass) {
    throw new Error('Email is not configured — set SMTP_USER and APP_PASSWORDS in .env')
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  })
  return _transporter
}

const sendEmail = async ({ to, subject, text }) => {
  const transporter = getTransporter()
  const from = process.env.SMTP_USER
  const info = await transporter.sendMail({ from: `"Shield Safety Alerts" <${from}>`, to, subject, text })
  logger.info(`[Email] Sent to ${to} | Subject: ${subject} | messageId: ${info.messageId}`)
  return info
}

// ─── SMS (mock — replace with Twilio / Africa's Talking) ─────────────────────
const sendSMS = async ({ to, message }) => {
  logger.info(`[SMS MOCK] To: ${to} | Message: ${message?.slice(0, 120)}`)
  // TODO production:
  // const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
  // await client.messages.create({ body: message, from: process.env.TWILIO_FROM, to })
  return true
}

// ─── Business notifications ───────────────────────────────────────────────────

const formatLocation = (loc) => {
  if (!loc || loc.lat == null || loc.lng == null) return 'Location unavailable'
  const acc = loc.accuracy != null ? ` (±${Math.round(loc.accuracy)}m)` : ''
  return `https://maps.google.com/?q=${loc.lat},${loc.lng}${acc}`
}

/**
 * Deliver one contact's alert, trying email first and falling back to SMS
 * (and vice versa) if the primary channel throws. Returns a per-contact
 * delivery record rather than throwing, so one bad contact never blocks
 * the others.
 */
const deliverToContact = async (contact, { subject, text, smsText }) => {
  const attempted = []
  const errors = []

  // Routed through `module.exports` (rather than the local const) so tests
  // can spy on/replace sendEmail or sendSMS independently of the rest of
  // this module — and so a future swap to a real provider only touches
  // those two functions.
  if (contact.email) {
    attempted.push('email')
    try {
      await module.exports.sendEmail({ to: contact.email, subject, text })
      return { contactId: contact._id, name: contact.name, channel: 'email', delivered: true, attempted }
    } catch (err) {
      errors.push(`email: ${err.message}`)
      logger.warn(`[TimerAlert] Email failed for contact ${contact._id}, falling back to SMS — ${err.message}`)
    }
  }

  if (contact.phone) {
    attempted.push('sms')
    try {
      await module.exports.sendSMS({ to: contact.phone, message: smsText })
      return { contactId: contact._id, name: contact.name, channel: 'sms', delivered: true, attempted }
    } catch (err) {
      errors.push(`sms: ${err.message}`)
    }
  }

  return { contactId: contact._id, name: contact.name, channel: null, delivered: false, attempted, errors }
}

/**
 * Alert all notify_on_checkin contacts when a timer fires. Saves an in-app
 * notification, attempts email with SMS fallback (or vice-versa) per
 * contact, and returns a structured delivery result so the caller (the
 * timer worker) can log it and report it over the socket.
 */
const alertTimerExpired = async (userId, context = {}) => {
  const { lastLocation, triggeredAt, timerId } = context

  try {
    const user     = await User.findById(userId).select('fullName email lastLocation')
    const contacts = await TrustedContact.find({ user: userId, notifyOnCheckin: true })

    if (!user) return { delivered: false, reason: 'user_not_found', contactsNotified: 0, channels: [] }

    if (contacts.length === 0) {
      await createNotification(
        userId,
        'timer_expired',
        'Safety Timer Expired — No Contacts',
        'Your safety check-in timer expired, but you have no trusted contacts configured to notify.'
      )
      return { delivered: false, reason: 'no_trusted_contacts', contactsNotified: 0, channels: [] }
    }

    const when = triggeredAt ? new Date(triggeredAt).toLocaleString() : new Date().toLocaleString()

    // The timer's own capture (taken when the timer was started) is the
    // freshest signal. If it's missing — geolocation denied/timed out at
    // that moment — fall back to the user's auto-saved last-known location
    // instead of always showing "Location unavailable".
    const effectiveLocation = (lastLocation && lastLocation.lat != null) ? lastLocation : user.lastLocation
    const locationLine = formatLocation(effectiveLocation)

    const msg = `⚠️ SHIELD SAFETY ALERT — ${user.fullName} set a check-in timer that expired at ${when} without being deactivated. Please check on them immediately. Last known location: ${locationLine}. If you believe they are in danger, call emergency services.`
    const subject = `Safety Alert from Shield — ${user.fullName}`

    const results = await Promise.all(
      contacts.map((c) => deliverToContact(c, { subject, text: msg, smsText: msg }))
    )

    const delivered = results.filter((r) => r.delivered)
    const channels   = [...new Set(delivered.map((r) => r.channel))]

    await createNotification(
      userId,
      'timer_expired',
      'Safety Timer Alert Sent',
      `Your safety check-in timer expired. ${delivered.length}/${contacts.length} trusted contact(s) were alerted.`,
      { timerId, channels, results }
    )

    logger.info(`[TimerAlert] Fired for user ${userId} — ${delivered.length}/${contacts.length} contact(s) notified`)

    return {
      delivered: delivered.length > 0,
      contactsNotified: delivered.length,
      totalContacts: contacts.length,
      channels,
      results
    }
  } catch (err) {
    logger.error('[TimerAlert] Error:', err.message)
    return { delivered: false, reason: err.message, contactsNotified: 0, channels: [] }
  }
}

/**
 * Notify a user when their report status changes.
 */
const notifyReportUpdate = async (userId, reportNumber, status) => {
  const messages = {
    under_review: 'Your report is now under review by our support team.',
    reviewed:     'Your report has been reviewed. Legal support has been assigned to your file.',
    closed:       'Your report has been closed. All records are securely archived.'
  }
  const body = messages[status] || `Your report status has changed to: ${status}.`
  const title = `Report ${reportNumber} Updated`

  await createNotification(userId, 'report_update', title, body, { reportNumber, status })

  const user = await User.findById(userId).select('email')
  if (user?.email) {
    await sendEmail({ to: user.email, subject: `Nimir — ${title}`, text: body }).catch(() => {})
  }
}

/**
 * Welcome notification after account creation.
 */
const sendWelcome = async (userId, name) => {
  await createNotification(
    userId,
    'welcome',
    `Welcome to Nimir, ${name}`,
    'Your account is active. You can now submit reports, set trusted contacts, and access support resources.'
  )
}

module.exports = {
  createNotification,
  alertTimerExpired,
  deliverToContact,
  notifyReportUpdate,
  sendWelcome,
  sendEmail,
  sendSMS
}
