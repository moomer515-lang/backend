const mongoose = require('mongoose')
const logger   = require('../utils/logger')

const connectDB = async () => {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/nimir'

  mongoose.set('strictQuery', true)

  try {
    const conn = await mongoose.connect(uri, {
      // Connection pool
      maxPoolSize:       10,
      minPoolSize:       2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS:          45000,
      connectTimeoutMS:         10000,
      // Heartbeat
      heartbeatFrequencyMS: 10000,
    })

    logger.info(`MongoDB connected: ${conn.connection.host} — DB: "${conn.connection.name}"`)

    mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected — attempting reconnect...'))
    mongoose.connection.on('reconnected',  () => logger.info('MongoDB reconnected'))
    mongoose.connection.on('error',  (err) => logger.error('MongoDB connection error:', err))

  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`)
    process.exit(1)
  }
}

const disconnectDB = async () => {
  await mongoose.connection.close()
  logger.info('MongoDB connection closed.')
}

module.exports = { connectDB, disconnectDB }
