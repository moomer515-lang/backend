/**
 * Seed script — populates MongoDB with demo data for development.
 *   node src/config/seed.js
 */
require('dotenv').config()
const mongoose  = require('mongoose')
const bcrypt    = require('bcryptjs')
const User      = require('../models/User')
const Report    = require('../models/Report')
const { TrustedContact, Notification, SupportResource } = require('../models/index')
const logger    = require('../utils/logger')

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/nimir'

const seed = async () => {
  await mongoose.connect(MONGO_URI)
  logger.info('Connected to MongoDB for seeding...')

  // ── Support resources (always upsert) ──────────────────────────────────────
  await SupportResource.deleteMany({})
  await SupportResource.insertMany([
    { category: 'ai',           title: 'Talk to Tara AI',     description: '24/7 trauma-informed AI counselling. Available anytime, no judgment.',              actionLabel: 'Start Chat',  icon: 'psychology',       sortOrder: 1 },
    { category: 'legal',        title: 'Legal Guidance',      description: 'Understand your rights and legal options with certified advisors.',                  actionLabel: 'Get Advice',  icon: 'gavel',            sortOrder: 2 },
    { category: 'mental_health',title: 'Mental Health',       description: 'Breathing exercises, grounding techniques and crisis support resources.',            actionLabel: 'Explore',     icon: 'favorite',         sortOrder: 3 },
    { category: 'community',    title: 'Support Groups',      description: 'Connect anonymously with survivor communities near you.',                            actionLabel: 'Find Groups', icon: 'group',            sortOrder: 4 },
    { category: 'emergency',    title: 'Crisis Hotline',      description: 'Emergency human support available 24/7. Call anytime.',                             actionLabel: 'Call Now',    icon: 'call',  phone: '+1-800-799-7233', sortOrder: 5 },
    { category: 'emergency',    title: 'Text Crisis Line',    description: 'Text HOME to 741741 to reach a trained crisis counselor right now.',                 actionLabel: 'Text Now',    icon: 'sms',              sortOrder: 6 },
    { category: 'legal',        title: 'Evidence Guide',      description: 'Learn how to preserve and document evidence correctly for legal proceedings.',       actionLabel: 'Read Guide',  icon: 'menu_book',        sortOrder: 7 },
  ])
  logger.info('✅ Support resources seeded')

  // ── Demo user ──────────────────────────────────────────────────────────────
  const existingUser = await User.findOne({ email: 'alex@demo.nimir.app' })
  if (existingUser) {
    logger.info('Demo user already exists — skipping user seed.')
    await mongoose.disconnect()
    return
  }

  const passwordHash = await bcrypt.hash('Password123!', 12)
  const user = await User.create({
    fullName:     'Alex Johnson',
    email:        'alex@demo.nimir.app',
    phone:        '+254712345678',
    passwordHash,
    mode:         'registered',
    isVerified:   true,
    language:     'en'
  })
  logger.info(`✅ Demo user created — ${user.email}`)

  // ── Trusted contacts ───────────────────────────────────────────────────────
  await TrustedContact.insertMany([
    {
      user:         user._id,
      name:         'Dr. Sarah Osei',
      email:        'sarah@demo.nimir.app',
      phone:        '+254722000001',
      relationship: 'Therapist',
      notifyOnCheckin: true,
      notifyOnReport:  false,
      isPrimary:    true
    },
    {
      user:         user._id,
      name:         'James Kimani',
      email:        'james@demo.nimir.app',
      phone:        '+254733000002',
      relationship: 'Friend',
      notifyOnCheckin: true,
      notifyOnReport:  true,
      isPrimary:    false
    }
  ])
  logger.info('✅ Trusted contacts seeded')

  // ── Sample reports ─────────────────────────────────────────────────────────
  const r1 = await Report.create({
    reportNumber:     'NMR-2024-4289',
    user:             user._id,
    title:            'Workplace Harassment',
    description:      'Repeated inappropriate comments and intimidation tactics by a senior colleague over a period of three months.',
    relationship:     'Colleague',
    locationName:     'Nairobi CBD Office Block',
    location:         { type: 'Point', coordinates: [36.8219, -1.2921] },
    locationObfuscated: true,
    status:           'reviewed',
    currentStep:      4,
    assignedAdvocate: 'Adv. Grace Mwangi',
    legalNotes:       'Case reviewed. Legal filing in preparation. Documentation complete.',
    statusHistory:    [
      { status: 'submitted',   changedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000) },
      { status: 'under_review',changedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
      { status: 'reviewed',    changedAt: new Date(Date.now() - 2 * 3600 * 1000) }
    ]
  })

  const r2 = await Report.create({
    reportNumber:  'NMR-2024-4301',
    user:          user._id,
    title:         'Domestic Incident',
    description:   'Incident at residence requiring documentation for protective order application.',
    relationship:  'Partner/Ex-Partner',
    locationName:  'Westlands Residential Area',
    location:      { type: 'Point', coordinates: [36.8066, -1.2697] },
    locationObfuscated: true,
    status:        'submitted',
    currentStep:   2,
    statusHistory: [
      { status: 'submitted', changedAt: new Date(Date.now() - 24 * 3600 * 1000) }
    ]
  })

  await Report.create({
    reportNumber:  'NMR-2024-4278',
    user:          user._id,
    title:         'Neighbourhood Dispute',
    description:   'Escalating verbal harassment from neighbour.',
    locationName:  'Kibera, Nairobi',
    status:        'closed',
    currentStep:   4,
    statusHistory: [
      { status: 'submitted',    changedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) },
      { status: 'under_review', changedAt: new Date(Date.now() - 8  * 24 * 3600 * 1000) },
      { status: 'reviewed',     changedAt: new Date(Date.now() - 6  * 24 * 3600 * 1000) },
      { status: 'closed',       changedAt: new Date(Date.now() - 5  * 24 * 3600 * 1000) }
    ]
  })
  logger.info('✅ Sample reports seeded')

  // ── Sample notifications ───────────────────────────────────────────────────
  await Notification.insertMany([
    {
      user:  user._id, type: 'welcome',
      title: 'Welcome to Nimir, Alex',
      body:  'Your account is active. You can now submit reports and set up trusted contacts.',
      isRead: true
    },
    {
      user:  user._id, type: 'report_update',
      title: `Report ${r1.reportNumber} Updated`,
      body:  'Your report has been reviewed. Legal support has been assigned to your file.',
      isRead: false,
      metadata: { reportNumber: r1.reportNumber, status: 'reviewed' }
    },
    {
      user:  user._id, type: 'report_update',
      title: `Report ${r2.reportNumber} Received`,
      body:  'Your report has been submitted and is pending review.',
      isRead: false,
      metadata: { reportNumber: r2.reportNumber, status: 'submitted' }
    }
  ])
  logger.info('✅ Sample notifications seeded')

  logger.info('\n🎉 Seed complete!')
  logger.info('   Demo login → Email: alex@demo.nimir.app  |  Password: Password123!')

  await mongoose.disconnect()
  process.exit(0)
}

seed().catch((err) => {
  logger.error('Seed failed:', err)
  process.exit(1)
})
