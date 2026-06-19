const express   = require('express')
const rateLimit = require('express-rate-limit')

const contactsCtrl = require('../controllers/contacts.controller')
const timerCtrl    = require('../controllers/timer.controller')
const profileCtrl  = require('../controllers/profile.controller')
const notifCtrl    = require('../controllers/notification.controller')
const supportCtrl  = require('../controllers/support.controller')

const { protect, requireRegistered } = require('../middleware/auth')
const { validate, schemas }          = require('../middleware/validate')
const { avatarUpload, handleUploadError } = require('../middleware/upload')
const { audit } = require('../middleware/errorHandler')

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 })

// ─── /api/contacts ────────────────────────────────────────────────────────────
const contactRouter = express.Router()
contactRouter.use(protect, requireRegistered)
contactRouter.get(   '/',    contactsCtrl.list)
contactRouter.get(   '/:id', contactsCtrl.getOne)
contactRouter.post(  '/',    validate(schemas.createContact), audit('contact.create', 'TrustedContact'), contactsCtrl.create)
contactRouter.put(   '/:id', validate(schemas.updateContact), audit('contact.update', 'TrustedContact'), contactsCtrl.update)
contactRouter.delete('/:id',                                   audit('contact.delete', 'TrustedContact'), contactsCtrl.remove)

// ─── /api/timer ───────────────────────────────────────────────────────────────
const timerRouter = express.Router()
timerRouter.use(protect)
timerRouter.get(   '/',         timerCtrl.getStatus)
timerRouter.get(   '/current',  timerCtrl.getStatus)
timerRouter.get(   '/history',  validate(schemas.listTimerHistory, 'query'), timerCtrl.history)
timerRouter.post(  '/start',    validate(schemas.startTimer), audit('timer.start'), timerCtrl.start)
timerRouter.post(  '/check-in', audit('timer.check_in'), timerCtrl.checkIn)
timerRouter.delete('/cancel',                                 audit('timer.cancel'), timerCtrl.cancel)

// ─── /api/profile ─────────────────────────────────────────────────────────────
const profileRouter = express.Router()
profileRouter.use(protect)
profileRouter.get(   '/',         profileCtrl.getProfile)
profileRouter.put(   '/',         validate(schemas.updateProfile), audit('profile.update'), profileCtrl.updateProfile)
profileRouter.put(   '/location', validate(schemas.updateLocation), profileCtrl.updateLocation)
profileRouter.post(  '/password', validate(schemas.changePassword), requireRegistered, audit('profile.password_change'), profileCtrl.changePassword)
profileRouter.post(  '/avatar',   uploadLimiter, avatarUpload.single('avatar'), handleUploadError, audit('profile.avatar_upload'), profileCtrl.uploadAvatar)
profileRouter.delete('/avatar',   audit('profile.avatar_delete'),  profileCtrl.deleteAvatar)
profileRouter.delete('/',         audit('profile.delete_account'), profileCtrl.deleteAccount)

// ─── /api/notifications ───────────────────────────────────────────────────────
const notifRouter = express.Router()
notifRouter.use(protect)
notifRouter.get(   '/',         validate(schemas.listNotifications, 'query'), notifCtrl.list)
notifRouter.patch( '/:id/read', notifCtrl.markRead)
notifRouter.post(  '/read-all', notifCtrl.markAllRead)
notifRouter.delete('/:id',      notifCtrl.deleteOne)
notifRouter.delete('/',         notifCtrl.clearAll)

// ─── /api/support ─────────────────────────────────────────────────────────────
const supportRouter = express.Router()
supportRouter.get('/resources',            supportCtrl.listResources)
supportRouter.get('/resources/:category',  supportCtrl.byCategory)

module.exports = { contactRouter, timerRouter, profileRouter, notifRouter, supportRouter }