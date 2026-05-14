'use strict';
// modules/stickerPackManager.js — Per-user Telegram sticker pack management

const fsp  = require('fs').promises;
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/sticker_packs.json');
const BOT_USERNAME = 'Pappyv2bot';
const MAX_PACK_SIZE = 120; // Telegram limit per pack

let _db = {}; // { userId: { packName, title, stickers: [file_id, ...] } }
let _writePending = false;

async function load() {
    try { _db = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); }
    catch { _db = {}; }
}

async function save() {
    if (_writePending) return;
    _writePending = true;
    try { await fsp.writeFile(DB_PATH, JSON.stringify(_db, null, 2), 'utf8'); }
    finally { _writePending = false; }
}

function getPackName(userId) {
    return `pappy_${userId}_by_${BOT_USERNAME}`;
}

function getPackTitle(userName) {
    return `${userName || 'User'}'s Pappy Pack`;
}

function getUserPack(userId) {
    return _db[String(userId)] || null;
}

async function registerPack(userId, userName) {
    const packName = getPackName(userId);
    _db[String(userId)] = {
        packName,
        title: getPackTitle(userName),
        stickers: [],
    };
    await save();
    return _db[String(userId)];
}

async function clearPack(userId) {
    delete _db[String(userId)];
    await save();
}

async function addStickerToRecord(userId, fileId) {
    const uid = String(userId);
    if (!_db[uid]) return;
    if (!_db[uid].stickers.includes(fileId)) {
        _db[uid].stickers.push(fileId);
        if (_db[uid].stickers.length > MAX_PACK_SIZE) {
            _db[uid].stickers.shift();
        }
        await save();
    }
}

async function removeStickerFromRecord(userId, fileId) {
    const uid = String(userId);
    if (!_db[uid]) return;
    _db[uid].stickers = _db[uid].stickers.filter(id => id !== fileId);
    await save();
}

load().catch(() => {});

module.exports = {
    getPackName,
    getPackTitle,
    getUserPack,
    registerPack,
    clearPack,
    addStickerToRecord,
    removeStickerFromRecord,
    BOT_USERNAME,
    MAX_PACK_SIZE,
};
