'use strict'

const { describe, it, expect } = require('@jest/globals')
const { TRANSITIONS, assertTransition } = require('../../core/state-machine')

describe('state-machine', () => {
  describe('TRANSITIONS', () => {
    it('should allow pending -> running', () => {
      expect(TRANSITIONS.pending).toContain('running')
    })

    it('should allow pending -> failed', () => {
      expect(TRANSITIONS.pending).toContain('failed')
    })

    it('should allow running -> done', () => {
      expect(TRANSITIONS.running).toContain('done')
    })

    it('should allow running -> failed', () => {
      expect(TRANSITIONS.running).toContain('failed')
    })

    it('should allow running -> retrying', () => {
      expect(TRANSITIONS.running).toContain('retrying')
    })

    it('should allow running -> waiting', () => {
      expect(TRANSITIONS.running).toContain('waiting')
    })

    it('should allow retrying -> running', () => {
      expect(TRANSITIONS.retrying).toContain('running')
    })

    it('should allow waiting -> running', () => {
      expect(TRANSITIONS.waiting).toContain('running')
    })

    it('should have done as terminal state', () => {
      expect(TRANSITIONS.done).toEqual([])
    })

    it('should have failed as terminal state', () => {
      expect(TRANSITIONS.failed).toEqual([])
    })
  })

  describe('assertTransition', () => {
    it('should not throw for valid transition pending -> running', () => {
      expect(() => assertTransition('pending', 'running')).not.toThrow()
    })

    it('should not throw for valid transition running -> done', () => {
      expect(() => assertTransition('running', 'done')).not.toThrow()
    })

    it('should not throw for valid transition running -> waiting', () => {
      expect(() => assertTransition('running', 'waiting')).not.toThrow()
    })

    it('should not throw for valid transition waiting -> running', () => {
      expect(() => assertTransition('waiting', 'running')).not.toThrow()
    })

    it('should throw for invalid transition done -> running', () => {
      expect(() => assertTransition('done', 'running')).toThrow('Invalid workflow transition: done -> running')
    })

    it('should throw for invalid transition failed -> running', () => {
      expect(() => assertTransition('failed', 'running')).toThrow('Invalid workflow transition: failed -> running')
    })

    it('should throw for invalid transition pending -> done', () => {
      expect(() => assertTransition('pending', 'done')).toThrow('Invalid workflow transition: pending -> done')
    })

    it('should throw for unknown state', () => {
      expect(() => assertTransition('unknown', 'running')).toThrow()
    })
  })
})
