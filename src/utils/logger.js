const winston = require('winston')

const { combine, timestamp, printf, colorize, json, errors } = winston.format

// Custom console format
const consoleFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`
})

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format: combine(errors({ stack: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), consoleFormat)
    })
  ],
  exitOnError: false
})

// In production, also write JSON logs to file
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    format: combine(json())
  }))
  logger.add(new winston.transports.File({
    filename: 'logs/combined.log',
    format: combine(json())
  }))
}

module.exports = logger
