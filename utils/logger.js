'use strict'

const pino = require('pino')
const { NODE_ENV } = require('../config')

const logger = pino(
  NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level: 'info' }
)

module.exports = logger
