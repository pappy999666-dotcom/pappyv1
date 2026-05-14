// services/redis.js
const { Redis } = require('ioredis');
const { redis } = require('../config'); // 👈 This links to your central config.js
const logger = require('../core/logger');

const redisConfig = {
    host: redis.host,
    port: redis.port,
    password: redis.password, // 👈 This now correctly grabs your .env password!
    maxRetriesPerRequest: null, // Required by BullMQ
};

const connection = new Redis(redisConfig);

let lastRedisErrorLogAt = 0;
connection.on('error', (error) => {
    const now = Date.now();
    if (now - lastRedisErrorLogAt < 15000) return;
    lastRedisErrorLogAt = now;
    logger.warn(`[Redis] Connection issue: ${error.message}`);
});

module.exports = { connection };
