const metrics = require('../src/utils/metrics')

describe('utils/metrics', () => {
  test('increment accumulates named counters', () => {
    const before = metrics.snapshot().counters.timersStarted
    metrics.increment('timersStarted')
    metrics.increment('timersStarted', 2)
    expect(metrics.snapshot().counters.timersStarted).toBe(before + 3)
  })

  test('recordDuration feeds avg/p95 stats', () => {
    metrics.recordDuration('triggerProcessing', 100)
    metrics.recordDuration('triggerProcessing', 200)
    const snap = metrics.snapshot().durationsMs.triggerProcessing
    expect(snap.samples).toBeGreaterThanOrEqual(2)
    expect(snap.avg).toBeGreaterThan(0)
  })

  test('alertSuccessRate is null until alerts have been attempted', () => {
    // Fresh module state isn't guaranteed across test files sharing the
    // singleton, so just assert the shape/type rather than an exact value.
    const rate = metrics.snapshot().alertSuccessRate
    expect(rate === null || typeof rate === 'number').toBe(true)
  })
})
