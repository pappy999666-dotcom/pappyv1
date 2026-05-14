// plugins/pappy-intel.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { ownerTelegramId } = require('../config');
const logger  = require('../core/logger');
const eventBus = require('../core/eventBus');

const dbPath = path.join(__dirname, '../data/intel.json');

const LIMITS = {
    MAX_JOINS_PER_DAY: 500,
    MIN_COOLDOWN_MS:   8000,
    MAX_COOLDOWN_MS:   20000,
};

let intelCache = {
    knownLinks:        [],
    pendingQueue:      [],
    dailyJoins:        0,
    lastJoinDate:      new Date().toISOString().split('T')[0],
    lastJoinTimestamp: 0,
    autoJoinEnabled:   false,
    autoJoinBotId:     null,
};

let _processing = false;

function normalizeEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return { code: entry.trim(), botId: null };
    const code = String(entry.code || entry.inviteCode || '').trim();
    return code ? { code, botId: entry.botId ? String(entry.botId).trim() : null } : null;
}

function hasCode(code) {
    return intelCache.knownLinks.includes(code) ||
           intelCache.pendingQueue.some(e => normalizeEntry(e)?.code === code);
}

function resolveSock(botId) {
    const id = String(botId || '').trim();
    if (id && global.waSockByBotId?.has(id)) return global.waSockByBotId.get(id);
    if (id && global.waSocks) {
        for (const [k, s] of global.waSocks.entries()) {
            if (k.includes(id) && s?.user) return s;
        }
    }
    // fallback — any connected socket
    if (global.waSocks) {
        for (const s of global.waSocks.values()) {
            if (s?.user) return s;
        }
    }
    return null;
}

async function saveState() {
    try { await fs.promises.writeFile(dbPath, JSON.stringify(intelCache, null, 2)); } catch {}
}

async function initDb() {
    try {
        if (fs.existsSync(dbPath)) {
            const d = JSON.parse(await fs.promises.readFile(dbPath, 'utf8'));
            intelCache = { ...intelCache, ...d };
            intelCache.pendingQueue = (intelCache.pendingQueue || []).map(normalizeEntry).filter(Boolean);
            intelCache.knownLinks   = intelCache.knownLinks || [];
        }
    } catch {}
}
initDb();

function checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (intelCache.lastJoinDate !== today) {
        intelCache.lastJoinDate = today;
        intelCache.dailyJoins   = 0;
        saveState();
    }
}

// ── Scraper: intercept invite links from any message ─────────────────────────
eventBus.on('message.upsert', async ({ text, botId }) => {
    if (!text?.includes('chat.whatsapp.com')) return;
    const matches = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/ig) || [];
    let added = 0;
    for (const m of matches) {
        const code = m.split('chat.whatsapp.com/')[1];
        if (!hasCode(code)) {
            intelCache.pendingQueue.push({ code, botId: String(botId || '').trim() || null });
            added++;
        }
    }
    if (added > 0) {
        saveState();
        logger.info(`[INTEL] Queued ${added} new link(s). Queue: ${intelCache.pendingQueue.length}`);
    }
});

// ── Auto-joiner daemon ────────────────────────────────────────────────────────
async function processQueue() {
    if (_processing || !intelCache.autoJoinEnabled || !intelCache.pendingQueue.length) return;
    checkDailyReset();
    if (intelCache.dailyJoins >= LIMITS.MAX_JOINS_PER_DAY) return;

    const now = Date.now();
    const cooldown = LIMITS.MIN_COOLDOWN_MS + Math.random() * (LIMITS.MAX_COOLDOWN_MS - LIMITS.MIN_COOLDOWN_MS);
    if (now - intelCache.lastJoinTimestamp < cooldown) return;

    const entry = normalizeEntry(intelCache.pendingQueue[0]);
    if (!entry) { intelCache.pendingQueue.shift(); return; }

    const sock = resolveSock(entry.botId || intelCache.autoJoinBotId);
    if (!sock) return;

    _processing = true;
    intelCache.pendingQueue.shift();
    intelCache.knownLinks.push(entry.code);

    try {
        // Small human-like delay
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

        let joined = false;
        let groupJid = null;

        try {
            // Try direct join first
            groupJid = await sock.groupAcceptInvite(entry.code);
            joined = true;
        } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            // Group requires approval — send join request
            if (msg.includes('approval') || msg.includes('request') || msg.includes('admin') || msg.includes('not-acceptable')) {
                try {
                    const info = await sock.groupGetInviteInfo(entry.code).catch(() => null);
                    if (info?.id) {
                        await sock.groupAcceptInviteV4(sock.user.id, {
                            groupJid: info.id,
                            inviteCode: entry.code,
                            inviteExpiration: info.inviteExpiration || 0
                        });
                        groupJid = info.id;
                        joined = true;
                        logger.info(`[INTEL] Join request sent to ${info.subject || info.id}`);
                    }
                } catch {}
            }
            if (!joined) throw e;
        }

        intelCache.dailyJoins++;
        intelCache.lastJoinTimestamp = Date.now();
        saveState();

        const display = groupJid || entry.code;
        logger.success(`[INTEL] Joined: ${display} (${intelCache.dailyJoins}/${LIMITS.MAX_JOINS_PER_DAY})`);

        if (global.tgBot) {
            global.tgBot.telegram.sendMessage(ownerTelegramId,
                `✅ <b>AUTO-JOIN</b>\n\n🔗 <code>${entry.code}</code>\n📊 Today: ${intelCache.dailyJoins}/${LIMITS.MAX_JOINS_PER_DAY}\n📋 Queue: ${intelCache.pendingQueue.length} remaining`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
    } catch (err) {
        logger.warn(`[INTEL] Failed ${entry.code}: ${err.message}`);
        intelCache.lastJoinTimestamp = Date.now() - (LIMITS.MAX_COOLDOWN_MS - 5000);
        saveState();
    } finally {
        _processing = false;
    }
}

// Run every 5s — faster than before (was 10s)
setInterval(processQueue, 5000).unref();

// ── Commands ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'INTEL',
    commands: [
        { cmd: '.autojoin',  role: 'owner' },
        { cmd: '.joinqueue', role: 'owner' },
    ],

    execute: async ({ sock, msg, args, text, botId }) => {
        const jid = msg.key.remoteJid;
        const cmd = text.split(' ')[0].toLowerCase();

        if (cmd === '.autojoin') {
            const action = args[0]?.toLowerCase();
            if (action === 'on' || action === 'off') {
                intelCache.autoJoinEnabled = action === 'on';
                intelCache.autoJoinBotId   = intelCache.autoJoinEnabled
                    ? String(botId || sock?.user?.id?.split(':')[0] || '').trim() || null
                    : null;
                saveState();
                return sock.sendMessage(jid, {
                    text: `📡 *AUTO-JOIN:* ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🔴'}\n📋 Queue: ${intelCache.pendingQueue.length} links`
                }, { quoted: msg });
            }
            return sock.sendMessage(jid, {
                text: `⚙️ Auto-Join: ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🛑'}\nUsage: .autojoin on/off`
            }, { quoted: msg });
        }

        if (cmd === '.joinqueue') {
            checkDailyReset();
            // Show first 5 queued codes
            const preview = intelCache.pendingQueue.slice(0, 5)
                .map((e, i) => `${i + 1}. ${normalizeEntry(e)?.code || '?'}`)
                .join('\n') || '_Empty_';

            return sock.sendMessage(jid, {
                text: `📡 *INTEL QUEUE*\n\n` +
                      `⏳ Pending: *${intelCache.pendingQueue.length}*\n` +
                      `✅ Joined today: *${intelCache.dailyJoins}/${LIMITS.MAX_JOINS_PER_DAY}*\n` +
                      `⚙️ Status: ${intelCache.autoJoinEnabled ? 'ENGAGED 🟢' : 'OFFLINE 🔴'}\n\n` +
                      `*Next up:*\n${preview}`
            }, { quoted: msg });
        }
    }
};
