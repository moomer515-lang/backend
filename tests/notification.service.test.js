/**
 * Tests the alert-delivery fallback logic: email -> SMS (or vice versa) per
 * contact, with per-contact failures isolated so one bad contact doesn't
 * block the others, and a partial-failure overall result.
 */

jest.mock('../src/models/index', () => ({
  Notification: { create: jest.fn().mockResolvedValue({}) },
  TrustedContact: { find: jest.fn() }
}))

jest.mock('../src/models/User', () => ({
  findById: jest.fn()
}))

const { TrustedContact } = require('../src/models/index')
const User = require('../src/models/User')
const notificationService = require('../src/services/notification.service')

const selectMock = (value) => ({ select: jest.fn().mockResolvedValue(value) })

describe('notification.service — deliverToContact fallback', () => {
  test('falls back to SMS when email delivery throws', async () => {
    jest.spyOn(notificationService, 'sendEmail').mockRejectedValueOnce(new Error('SMTP timeout'))
    jest.spyOn(notificationService, 'sendSMS').mockResolvedValueOnce(true)

    const result = await notificationService.deliverToContact(
      { _id: 'c1', name: 'Alex', email: 'alex@example.com', phone: '+15550001111' },
      { subject: 'Alert', text: 'msg', smsText: 'msg' }
    )

    expect(result.delivered).toBe(true)
    expect(result.channel).toBe('sms')
    expect(result.attempted).toEqual(['email', 'sms'])
  })

  test('reports failure when every available channel fails', async () => {
    jest.spyOn(notificationService, 'sendEmail').mockRejectedValueOnce(new Error('SMTP down'))
    jest.spyOn(notificationService, 'sendSMS').mockRejectedValueOnce(new Error('carrier down'))

    const result = await notificationService.deliverToContact(
      { _id: 'c2', name: 'Sam', email: 'sam@example.com', phone: '+15550002222' },
      { subject: 'Alert', text: 'msg', smsText: 'msg' }
    )

    expect(result.delivered).toBe(false)
    expect(result.channel).toBeNull()
    expect(result.errors.length).toBe(2)
  })

  test('uses the only channel a contact has', async () => {
    jest.spyOn(notificationService, 'sendSMS').mockResolvedValueOnce(true)

    const result = await notificationService.deliverToContact(
      { _id: 'c3', name: 'Jo', phone: '+15550003333' },
      { subject: 'Alert', text: 'msg', smsText: 'msg' }
    )

    expect(result.delivered).toBe(true)
    expect(result.channel).toBe('sms')
    expect(result.attempted).toEqual(['sms'])
  })
})

describe('notification.service — alertTimerExpired', () => {
  test('returns no_trusted_contacts when the user has none configured', async () => {
    User.findById.mockReturnValueOnce(selectMock({ fullName: 'Riley', email: 'r@example.com' }))
    TrustedContact.find.mockResolvedValueOnce([])

    const result = await notificationService.alertTimerExpired('user1', {})
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('no_trusted_contacts')
  })

  test('aggregates per-contact results and reports partial delivery', async () => {
    User.findById.mockReturnValueOnce(selectMock({ fullName: 'Riley', email: 'r@example.com' }))
    TrustedContact.find.mockResolvedValueOnce([
      { _id: 'c1', name: 'Alex', email: 'alex@example.com', phone: null },
      { _id: 'c2', name: 'Sam', email: null, phone: '+15550002222' }
    ])

    jest.spyOn(notificationService, 'sendEmail').mockResolvedValueOnce(true)
    jest.spyOn(notificationService, 'sendSMS').mockResolvedValueOnce(true)

    const result = await notificationService.alertTimerExpired('user1', {
      lastLocation: { lat: 1.23, lng: 4.56 },
      triggeredAt: new Date()
    })

    expect(result.delivered).toBe(true)
    expect(result.contactsNotified).toBe(2)
    expect(result.channels.sort()).toEqual(['email', 'sms'])
  })
})
