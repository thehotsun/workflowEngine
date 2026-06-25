'use strict'

const { describe, it, expect } = require('@jest/globals')
const WorkflowContext = require('../../core/context')

describe('WorkflowContext', () => {
  describe('constructor', () => {
    it('should create empty context with no initial data', () => {
      const ctx = new WorkflowContext()
      expect(ctx.toJSON()).toEqual({})
    })

    it('should create context with initial data', () => {
      const ctx = new WorkflowContext({ a: 1, b: 'hello' })
      expect(ctx.get('a')).toBe(1)
      expect(ctx.get('b')).toBe('hello')
    })

    it('should shallow-copy initial data (top-level keys independent)', () => {
      const initial = { a: 1, b: 2 }
      const ctx = new WorkflowContext(initial)
      initial.a = 99
      expect(ctx.get('a')).toBe(1)
    })

    it('nested objects are shared reference (shallow copy)', () => {
      const initial = { nested: { value: 42 } }
      const ctx = new WorkflowContext(initial)
      // shallow copy: nested is same reference
      expect(ctx.get('nested')).toBe(initial.nested)
    })
  })

  describe('get', () => {
    it('should return value for existing key', () => {
      const ctx = new WorkflowContext({ key: 'val' })
      expect(ctx.get('key')).toBe('val')
    })

    it('should return undefined for missing key', () => {
      const ctx = new WorkflowContext()
      expect(ctx.get('missing')).toBeUndefined()
    })

    it('should return default for missing key', () => {
      const ctx = new WorkflowContext()
      expect(ctx.get('missing', 'default')).toBe('default')
    })

    it('should return null value without falling back to default', () => {
      const ctx = new WorkflowContext({ key: null })
      expect(ctx.get('key', 'default')).toBeNull()
    })
  })

  describe('set', () => {
    it('should set a new key', () => {
      const ctx = new WorkflowContext()
      ctx.set('x', 10)
      expect(ctx.get('x')).toBe(10)
    })

    it('should overwrite existing key', () => {
      const ctx = new WorkflowContext({ x: 1 })
      ctx.set('x', 2)
      expect(ctx.get('x')).toBe(2)
    })

    it('should return the set value', () => {
      const ctx = new WorkflowContext()
      expect(ctx.set('x', 42)).toBe(42)
    })
  })

  describe('delete', () => {
    it('should remove existing key', () => {
      const ctx = new WorkflowContext({ a: 1 })
      ctx.delete('a')
      expect(ctx.has('a')).toBe(false)
    })

    it('should be safe to delete non-existent key', () => {
      const ctx = new WorkflowContext()
      expect(() => ctx.delete('nope')).not.toThrow()
    })
  })

  describe('merge', () => {
    it('should merge multiple keys', () => {
      const ctx = new WorkflowContext({ a: 1 })
      ctx.merge({ b: 2, c: 3 })
      expect(ctx.get('a')).toBe(1)
      expect(ctx.get('b')).toBe(2)
      expect(ctx.get('c')).toBe(3)
    })

    it('should overwrite existing keys', () => {
      const ctx = new WorkflowContext({ a: 1 })
      ctx.merge({ a: 99 })
      expect(ctx.get('a')).toBe(99)
    })

    it('should return merged data', () => {
      const ctx = new WorkflowContext({ a: 1 })
      const result = ctx.merge({ b: 2 })
      expect(result).toEqual({ a: 1, b: 2 })
    })
  })

  describe('has', () => {
    it('should return true for existing key', () => {
      const ctx = new WorkflowContext({ key: 'val' })
      expect(ctx.has('key')).toBe(true)
    })

    it('should return false for missing key', () => {
      const ctx = new WorkflowContext()
      expect(ctx.has('missing')).toBe(false)
    })

    it('should return true for null/undefined values', () => {
      const ctx = new WorkflowContext({ a: null, b: undefined })
      expect(ctx.has('a')).toBe(true)
      expect(ctx.has('b')).toBe(true)
    })
  })

  describe('snapshot', () => {
    it('should create independent copy', () => {
      const ctx = new WorkflowContext({ a: 1 })
      const snap = ctx.snapshot()
      ctx.set('a', 99)
      expect(snap.get('a')).toBe(1)
    })

    it('should be a WorkflowContext instance', () => {
      const ctx = new WorkflowContext({ a: 1 })
      const snap = ctx.snapshot()
      expect(snap).toBeInstanceOf(WorkflowContext)
    })
  })

  describe('toJSON', () => {
    it('should return plain object', () => {
      const ctx = new WorkflowContext({ a: 1, b: 'hello' })
      const json = ctx.toJSON()
      expect(json).toEqual({ a: 1, b: 'hello' })
      expect(json).not.toBe(ctx.data)
    })
  })
})
