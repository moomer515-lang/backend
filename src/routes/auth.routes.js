const router  = require('express').Router()
const rateLimit = require('express-rate-limit')
const ctrl    = require('../controllers/auth.controller')
const { validate, schemas } = require('../middleware/validate')
const { protect } = require('../middleware/auth')
const { audit }   = require('../middleware/errorHandler')

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' }
})

router.post('/register',    authLimiter, validate(schemas.register),    audit('auth.register', 'User'), ctrl.register)
router.post('/login',       authLimiter, validate(schemas.login),       audit('auth.login',    'User'), ctrl.login)
router.post('/ghost',       authLimiter, validate(schemas.ghostSession), audit('auth.ghost',   'User'), ctrl.ghostSession)
router.post('/refresh',     authLimiter, validate(schemas.refreshToken),                                ctrl.refresh)
router.post('/logout',                                                                                   ctrl.logout)
router.post('/logout-all',  protect,                                    audit('auth.logout_all'),       ctrl.logoutAll)
router.get('/me',           protect,                                                                     ctrl.me)

module.exports = router
