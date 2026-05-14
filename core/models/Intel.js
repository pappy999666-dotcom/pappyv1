// core/models/Intel.js
const mongoose = require('mongoose');

// This is our blueprint for the WhatsApp links we scrape
const intelSchema = new mongoose.Schema({
    linkCode: { type: String, required: true, unique: true }, // The unique part of the group link
    status: { type: String, default: 'pending' }, // Can be 'pending', 'joined', or 'failed'
    dateAdded: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Intel', intelSchema);
