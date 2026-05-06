'use strict'

const TRANSITIONS = {
  pending: ['running', 'failed'],
  running: ['done', 'failed', 'retrying', 'waiting'],
  retrying: ['running', 'failed'],
  waiting: ['running', 'failed'],
  done: [],
  failed: []
}

function assertTransition(from, to) {
  const allowed = TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}`)
  }
}

module.exports = { TRANSITIONS, assertTransition }
