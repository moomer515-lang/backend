/**
 * Lightweight in-memory metrics for the Safety Timer subsystem.
 *
 * This is intentionally not a full metrics stack (Prometheus/StatsD) — it
 * gives the timer worker and alert service somewhere cheap to record
 * numbers that show up in logs and the /api/health-ish debug endpoint.
 * Swap `recordTimer`/`increment` bodies for a real exporter later without
 * touching call sites.
 */

const logger = require('./logger')

const state = {
  counters: {
    timersStarted: 0,
    timersCheckedIn: 0,
    timersCancelled: 0,
    timersTriggered: 0,
    duplicateTriggerAttempts: 0,
    alertsDispatched: 0,
    alertsFailed: 0,
    wsReconnects: 0
  },
  durationsMs: {
    triggerProcessing: [],   // time between expiresAt and the moment we flipped status -> triggered
    alertDispatchLatency: [] // time between trigger decision and alert delivery completing
  },
  drift: {
    // countdownDriftMs samples: client-reported remaining vs server-computed remaining at reconnect
    countdownDriftMs: []
  }
}

const MAX_SAMPLES = 500

const increment = (counter, by = 1) => {
  if (!(counter in state.counters)) state.counters[counter] = 0
  state.counters[counter] += by
}

const _pushSample = (bucket, key, valueMs) => {
  const arr = bucket[key]
  if (!arr) return
  arr.push(valueMs)
  if (arr.length > MAX_SAMPLES) arr.shift()
}

const recordDuration = (key, valueMs) => {
  _pushSample(state.durationsMs, key, valueMs)
  if (key === 'triggerProcessing' && valueMs > 1000) {
    logger.warn(`[Metrics] Trigger processing exceeded 1s target: ${valueMs}ms`)
  }
}

const recordDrift = (valueMs) => _pushSample(state.drift, 'countdownDriftMs', valueMs)

const _avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const _p95 = (arr) => {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

const snapshot = () => ({
  counters: { ...state.counters },
  durationsMs: {
    triggerProcessing: {
      avg: Math.round(_avg(state.durationsMs.triggerProcessing)),
      p95: Math.round(_p95(state.durationsMs.triggerProcessing)),
      samples: state.durationsMs.triggerProcessing.length
    },
    alertDispatchLatency: {
      avg: Math.round(_avg(state.durationsMs.alertDispatchLatency)),
      p95: Math.round(_p95(state.durationsMs.alertDispatchLatency)),
      samples: state.durationsMs.alertDispatchLatency.length
    }
  },
  countdownDriftMs: {
    avg: Math.round(_avg(state.drift.countdownDriftMs)),
    p95: Math.round(_p95(state.drift.countdownDriftMs)),
    samples: state.drift.countdownDriftMs.length
  },
  alertSuccessRate: state.counters.alertsDispatched + state.counters.alertsFailed > 0
    ? Number((state.counters.alertsDispatched / (state.counters.alertsDispatched + state.counters.alertsFailed)).toFixed(4))
    : null
})

module.exports = { increment, recordDuration, recordDrift, snapshot }
