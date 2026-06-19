/**
 * Unit tests for the SafetyTimer lifecycle in src/services/timer.service.js.
 *
 * These tests mock the Mongoose models and the notification service so they
 * run anywhere (no real MongoDB needed) and stay fast. They focus on the
 * behavioral contract that matters most for a safety feature: a timer can
 * never fire twice, check-in/cancel are mutually exclusive with trigger,
 * and the "only one active timer per user" rule holds.
 */

jest.mock('../src/models/index', () => ({
  CheckinTimer: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn()
  },
  SafetyTimerEvent: {
    create: jest.fn().mockResolvedValue({})
  },
  TrustedContact: {
    countDocuments: jest.fn()
  }
}))

jest.mock('../src/services/notification.service', () => ({
  alertTimerExpired: jest.fn().mockResolvedValue({ delivered: true, contactsNotified: 1, channels: ['email'] })
}))

const { CheckinTimer, SafetyTimerEvent, TrustedContact } = require('../src/models/index')
const notificationService = require('../src/services/notification.service')
const timerService = require('../src/services/timer.service')

const leanResult = (value) => ({ lean: () => Promise.resolve(value) })

describe('timer.service — startTimer', () => {
  test('rejects starting a second timer while one is already active', async () => {
    CheckinTimer.findOne.mockReturnValueOnce(leanResult({ _id: 't1', status: 'active' }))

    await expect(timerService.startTimer('user1', 600)).rejects.toMatchObject({
      statusCode: 409
    })
    expect(CheckinTimer.findOneAndUpdate).not.toHaveBeenCalled()
  })

  test('rejects starting a timer with no trusted contacts configured', async () => {
    CheckinTimer.findOne.mockReturnValueOnce(leanResult(null))
    TrustedContact.countDocuments.mockResolvedValueOnce(0)

    await expect(timerService.startTimer('user1', 600)).rejects.toMatchObject({
      statusCode: 400
    })
  })

  test('creates an active timer with the correct expiresAt and logs a "started" event', async () => {
    CheckinTimer.findOne.mockReturnValueOnce(leanResult(null))
    TrustedContact.countDocuments.mockResolvedValueOnce(1)

    const fakeDoc = { _id: 'timer1', user: 'user1', status: 'active', expiresAt: new Date(Date.now() + 600000), lastLocation: {} }
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce(fakeDoc)

    const timer = await timerService.startTimer('user1', 600, { lat: 1, lng: 2 })

    expect(timer).toBe(fakeDoc)
    const [, update] = CheckinTimer.findOneAndUpdate.mock.calls[0]
    expect(update.$set.status).toBe('active')
    expect(update.$set.durationSeconds).toBe(600)
    expect(SafetyTimerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ timer: 'timer1', user: 'user1', type: 'started' })
    )
  })
})

describe('timer.service — checkIn / cancelTimer', () => {
  test('checkIn returns null when there is no active timer', async () => {
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce(null)
    const result = await timerService.checkIn('user1')
    expect(result).toBeNull()
    expect(SafetyTimerEvent.create).not.toHaveBeenCalled()
  })

  test('checkIn marks the timer checked_in and logs the event', async () => {
    const fakeDoc = { _id: 'timer1', user: 'user1', status: 'checked_in' }
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce(fakeDoc)

    const result = await timerService.checkIn('user1')

    expect(result).toBe(fakeDoc)
    const [filter, update] = CheckinTimer.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ user: 'user1', status: 'active' })
    expect(update.$set.status).toBe('checked_in')
    expect(SafetyTimerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checked_in' })
    )
  })

  test('cancelTimer only matches timers that are currently active', async () => {
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce({ _id: 'timer1', user: 'user1', status: 'cancelled' })

    await timerService.cancelTimer('user1')

    const [filter, update] = CheckinTimer.findOneAndUpdate.mock.calls[0]
    expect(filter.status).toBe('active')
    expect(update.$set.status).toBe('cancelled')
    expect(update.$set.isCancelled).toBe(true)
  })
})

describe('timer.service — triggerTimer (duplicate-trigger prevention)', () => {
  test('a successful claim flips status to triggered, logs the event, and dispatches alerts', async () => {
    const timerLean = { _id: 'timer1', user: 'user1', status: 'active', lockVersion: 0, expiresAt: new Date(Date.now() - 1000) }
    const claimedDoc = { ...timerLean, status: 'triggered', triggeredAt: new Date(), lastLocation: {} }
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce(claimedDoc)

    await timerService.triggerTimer(timerLean)

    // The claim must be conditioned on the timer still being active AND on
    // the lockVersion we read — this is what makes it safe under races.
    const [filter] = CheckinTimer.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'timer1', status: 'active', lockVersion: 0 })

    expect(SafetyTimerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'triggered' })
    )

    // dispatchAlerts is fire-and-forget; flush microtasks so we can assert it ran.
    await new Promise((r) => setImmediate(r))
    expect(notificationService.alertTimerExpired).toHaveBeenCalledWith('user1', expect.any(Object))
  })

  test('a lost race (lockVersion mismatch / already claimed) never alerts twice', async () => {
    const timerLean = { _id: 'timer1', user: 'user1', status: 'active', lockVersion: 0, expiresAt: new Date(Date.now() - 1000) }
    // Simulates another tick/instance having already claimed it: the
    // conditional update matches nothing and findOneAndUpdate resolves null.
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce(null)

    await timerService.triggerTimer(timerLean)

    expect(SafetyTimerEvent.create).not.toHaveBeenCalled()
    await new Promise((r) => setImmediate(r))
    expect(notificationService.alertTimerExpired).not.toHaveBeenCalled()
  })
})

describe('timer.service — runTick', () => {
  test('triggers timers whose expiresAt has passed and leaves others alone', async () => {
    const due  = { _id: 't-due',  user: 'u1', status: 'active', lockVersion: 0, expiresAt: new Date(Date.now() - 5000) }
    const live = { _id: 't-live', user: 'u2', status: 'active', lockVersion: 0, expiresAt: new Date(Date.now() + 60000) }

    CheckinTimer.find.mockReturnValueOnce(leanResult([due, live]))
    CheckinTimer.findOneAndUpdate.mockResolvedValueOnce({ ...due, status: 'triggered', triggeredAt: new Date() })

    await timerService.runTick()

    // Only the due timer should have attempted a claim (one findOneAndUpdate call).
    expect(CheckinTimer.findOneAndUpdate).toHaveBeenCalledTimes(1)
    expect(CheckinTimer.findOneAndUpdate.mock.calls[0][0]._id).toBe('t-due')
  })
})

describe('timer.service — getTimer', () => {
  test('returns remainingSeconds = 0 for a non-active timer', async () => {
    CheckinTimer.findOne.mockReturnValueOnce(leanResult({ status: 'cancelled', expiresAt: new Date(Date.now() + 100000) }))
    const timer = await timerService.getTimer('user1')
    expect(timer.remainingSeconds).toBe(0)
  })

  test('computes remainingSeconds from expiresAt for an active timer', async () => {
    CheckinTimer.findOne.mockReturnValueOnce(leanResult({ status: 'active', expiresAt: new Date(Date.now() + 30000) }))
    const timer = await timerService.getTimer('user1')
    expect(timer.remainingSeconds).toBeGreaterThan(25)
    expect(timer.remainingSeconds).toBeLessThanOrEqual(30)
  })
})
