0// core/whatsapp.js
// Ω ELITE CONNECTION MANAGER & EVENT-DRIVEN PROTOCOL

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    DisconnectReason,
    delay,
    Browsers
} = require('gifted-baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const { ownerTelegramId, ownerWhatsAppJids, globalPrefix } = require('../config');
const ownerManager = require('../modules/ownerManager');
const logger = require('./logger');
const engine = require('./engine'); 
const { rememberPreviewHint } = require('./linkPreview');
const { generateAnimatedSticker, generateTelegramSticker } = require('./stickerEngine');

const SESSIONS_PATH = path.join(__dirname, '../data/sessions');
const STATE_FILE = path.join(__dirname, '../data/botState.json');

// Per-node state file — scoped by phone number so each node has isolated state
function getNodeStateFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return STATE_FILE;
    return path.join(__dirname, `../data/botState-${digits}.json`);
}

function getNodeStickerCmdsFile(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return path.join(__dirname, '../data/stickerCmds.json');
    return path.join(__dirname, `../data/stickerCmds-${digits}.json`);
}

const activeSockets = new Map();
if (!global.waSockByBotId) global.waSockByBotId = new Map();
// ─── GROUP METADATA CACHE (prevents WA 429 rate-limit errors) ───────────────
const groupCache = require('./groupCache');
const MAX_PEER_SESSION_FILES = 500;

// Track decrypt failures per session — auto-prune signal files when they spike
const _decryptFailCount = new Map();
const _decryptPruneThrottle = new Map();

function trackDecryptFailure(sessionKey, sessionDir) {
    const count = (_decryptFailCount.get(sessionKey) || 0) + 1;
    _decryptFailCount.set(sessionKey, count);

    // After 10 failures, prune stale signal files — but throttle to once per 2 min
    if (count >= 10) {
        _decryptFailCount.set(sessionKey, 0);
        const lastPrune = _decryptPruneThrottle.get(sessionKey) || 0;
        if (Date.now() - lastPrune < 2 * 60 * 1000) return;
        _decryptPruneThrottle.set(sessionKey, Date.now());

        setImmediate(() => {
            try {
                if (!fs.existsSync(sessionDir)) return;
                const files = fs.readdirSync(sessionDir)
                    .filter(f => f.startsWith('session-') || f.startsWith('sender-key-'))
                    .map(f => ({ f, mt: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
                    .sort((a, b) => b.mt - a.mt);
                if (files.length <= 1500) return;
                files.slice(1500).forEach(({ f }) => { try { fs.unlinkSync(path.join(sessionDir, f)); } catch {} });
                logger.info(`[WA] Auto-pruned ${files.length - 1500} stale signal files for ${sessionKey} (decrypt spike)`);
            } catch {}
        });
    }
}

function prunePeerSessions(sessionDir, maxFiles = MAX_PEER_SESSION_FILES) {
    try {
        if (!fs.existsSync(sessionDir)) return;
        const sessionFiles = fs.readdirSync(sessionDir)
            .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
            .map((name) => {
                const fullPath = path.join(sessionDir, name);
                const stat = fs.statSync(fullPath);
                return { name, fullPath, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (sessionFiles.length <= maxFiles) return;
        const toDelete = sessionFiles.slice(maxFiles);
        toDelete.forEach((entry) => {
            try { fs.unlinkSync(entry.fullPath); } catch {}
        });

        logger.warn(`[WA] Pruned peer sessions in ${path.basename(sessionDir)}: ${sessionFiles.length} -> ${maxFiles}`);
    } catch (err) {
        logger.warn(`[WA] Failed to prune peer sessions: ${err.message}`);
    }
}

function getCachedAdminStatus(jid, sender) {
    return groupCache.isAdmin(jid, sender);
}

function refreshGroupMeta(sock, jid) {
    groupCache.getGroupMeta(sock, jid).catch(() => {});
}

async function getCachedGroupMeta(sock, jid) {
    return groupCache.getGroupMeta(sock, jid);
}

// 🧠 SaaS Fix: Expose this globally so bullEngine.js can find the sockets!
global.waSocks = activeSockets; 

// Per-node botState map: phone -> state object
const nodeStates = new Map();
// Global botState kept for backward compat (sleep, autoPair) — general owner only
let botState = { isSleeping: false, autoPairEnabled: false, pappyMode: {}, commandPrefix: globalPrefix };
if (!global.messageCache) global.messageCache = new Map();
if (!global._senderMsgIndex) global._senderMsgIndex = new Map();

if (!global._senderIndexCleanupStarted) {
    global._senderIndexCleanupStarted = true;
    // Clean stale sender index entries every 5 min
    setInterval(() => {
        if (!global._senderMsgIndex) return;
        for (const [key, ids] of global._senderMsgIndex.entries()) {
            for (const id of ids) {
                if (!global.messageCache?.has(id)) ids.delete(id);
            }
            if (ids.size === 0) global._senderMsgIndex.delete(key);
        }
    }, 5 * 60 * 1000).unref();

    // Scheduled signal file cleanup every 6 hours
    setInterval(() => {
        try {
            const sessionsPath = path.join(__dirname, '../data/sessions');
            if (!fs.existsSync(sessionsPath)) return;
            for (const d of fs.readdirSync(sessionsPath)) {
                const dir = path.join(sessionsPath, d);
                try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
                const files = fs.readdirSync(dir).filter(f => f.startsWith('session-') || f.startsWith('sender-key-'));
                if (files.length <= 3000) continue;
                const sorted = files
                    .map(f => { try { return { f, mt: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } })
                    .filter(Boolean).sort((a, b) => b.mt - a.mt);
                sorted.slice(3000).forEach(({ f }) => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
                logger.warn(`[WA] Scheduled prune: removed ${sorted.length - 3000} signal files from ${d}`);
            }
        } catch {}
    }, 6 * 60 * 60 * 1000).unref();
}
if (!global._aiReplyCache) global._aiReplyCache = new Map();
if (!global.stickerCache) global.stickerCache = new Map();
const MAX_MESSAGE_CACHE_SIZE = 20000;

// ─── AI QUEUE & DEDUP (prevents duplicate AI calls per message) ────────────────
const fastq = require('fastq');
// Per-message dedup — ignore same msgId within 5s
const _aiMsgDedup = new Set();
// Global AI worker queue — processes one AI request at a time per bot session
if (!global._aiQueues) global._aiQueues = new Map();

function getAiQueue(sessionKey) {
    if (!global._aiQueues.has(sessionKey)) {
        // concurrency=1 per node — AI calls are heavy, never run more than 1 at a time
        // This prevents AI from starving command processing
        const q = fastq.promise(async (task) => {
            try { await task(); } catch {}
        }, 1);
        global._aiQueues.set(sessionKey, q);
    }
    return global._aiQueues.get(sessionKey);
}

function canAiReply(msgId) {
    // Dedup only — skip if same message already queued within 5s
    if (_aiMsgDedup.has(msgId)) return false;
    _aiMsgDedup.add(msgId);
    setTimeout(() => _aiMsgDedup.delete(msgId), 5000);
    return true;
}

function getNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return botState;
    if (!nodeStates.has(digits)) {
        const stateFile = getNodeStateFile(digits);
        let state = { isSleeping: false, pappyMode: {}, commandPrefix: globalPrefix, nodeMode: 'public' };
        if (fs.existsSync(stateFile)) {
            try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf-8')) }; } catch {}
        }
        nodeStates.set(digits, state);
    }
    return nodeStates.get(digits);
}

function saveNodeState(phone) {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return;
    const state = nodeStates.get(digits);
    if (!state) return;
    try { fs.writeFileSync(getNodeStateFile(digits), JSON.stringify(state)); } catch {}
}

function bindSocketAliases(sock, aliases = []) {
    if (!sock || !global.waSockByBotId) return;
    for (const alias of aliases) {
        const key = String(alias || '').trim();
        if (key) global.waSockByBotId.set(key, sock);
    }
}

function unbindSocketAliases(sock) {
    if (!sock || !global.waSockByBotId) return;
    for (const [key, value] of global.waSockByBotId.entries()) {
        if (value === sock) global.waSockByBotId.delete(key);
    }
}

const STICKER_CACHE_DIR = path.join(__dirname, '../data/sticker_cache');
if (!fs.existsSync(STICKER_CACHE_DIR)) fs.mkdirSync(STICKER_CACHE_DIR, { recursive: true });

if (!fs.existsSync(SESSIONS_PATH)) fs.mkdirSync(SESSIONS_PATH, { recursive: true });
if (!fs.existsSync(path.join(__dirname, '../data'))) fs.mkdirSync(path.join(__dirname, '../data'));

const loadState = () => {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            botState = { pappyMode: {}, autoPairEnabled: false, commandPrefix: globalPrefix, ...parsed };
        } catch { botState = { isSleeping: false, autoPairEnabled: false, pappyMode: {}, commandPrefix: globalPrefix }; }
    }
};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(botState));
loadState();

const ownerWaSet = new Set((ownerWhatsAppJids || []).map((j) => String(j || '').trim()).filter(Boolean));
const ownerWaDigits = new Set(Array.from(ownerWaSet).map((j) => String(j || '').replace(/[^0-9]/g, '')).filter(Boolean));

// Global owner check — only the general owner JIDs from config
const isGlobalOwnerJid = (jid) => {
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    return ownerWaSet.has(raw) || ownerWaSet.has(norm) || ownerWaDigits.has(phone);
};

// Session-scoped owner check — general owner OR the specific phone that owns this session
// nodePhone = the phone number of this bot session (e.g. '2348164167112')
const isOwnerJidForSession = (jid, nodePhone) => {
    if (isGlobalOwnerJid(jid)) return true;
    if (!nodePhone) return false;
    const raw = String(jid || '').trim();
    const norm = raw.replace(/:\d+(?=@)/g, '');
    const phone = norm.replace(/[^0-9]/g, '');
    const nodeDigits = String(nodePhone || '').replace(/[^0-9]/g, '');
    return phone === nodeDigits;
};

// Legacy global isOwnerJid — kept for backward compat but only checks general owner
const isOwnerJid = isGlobalOwnerJid;

function getCommandPrefix(phone) {
    const state = phone ? getNodeState(phone) : botState;
    const prefix = String(state.commandPrefix || '').trim();
    return prefix || globalPrefix;
}

function setCommandPrefix(prefix, phone) {
    const clean = String(prefix || '').trim();
    if (!clean || clean.length > 3 || /\s/.test(clean)) return false;
    if (phone) {
        const state = getNodeState(phone);
        state.commandPrefix = clean;
        saveNodeState(phone);
    } else {
        botState.commandPrefix = clean;
        saveState();
    }
    return true;
}

// Node mode: 'public' = anyone can use cmds, 'private' = only node owner + general owner
function getNodeMode(phone) {
    return getNodeState(phone).nodeMode || 'public';
}

function setNodeMode(phone, mode) {
    const state = getNodeState(phone);
    state.nodeMode = mode === 'private' ? 'private' : 'public';
    saveNodeState(phone);
}

function normalizeCommandText(text, phone) {
    const raw = String(text || '');
    const activePrefix = getCommandPrefix(phone);
    // Always accept the global prefix '.' as well as the active prefix
    // This prevents a wrong prefix setting from silently breaking all commands
    if (raw.startsWith(activePrefix)) {
        if (activePrefix === globalPrefix) return raw;
        return `${globalPrefix}${raw.slice(activePrefix.length)}`;
    }
    if (activePrefix !== globalPrefix && raw.startsWith(globalPrefix)) {
        return raw; // accept '.' prefix even if active prefix is different
    }
    return null;
}

function resolveSenderJid(msg, fallbackBotJid) {
    if (!msg?.key) return fallbackBotJid;
    if (msg.key.fromMe) return fallbackBotJid;

    const fromKey = msg.key.participant
        || msg.key.participantPn
        || msg.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.imageMessage?.contextInfo?.participant
        || msg.message?.videoMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo?.participant
        || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo?.participant
        || msg.key.remoteJid;

    return String(fromKey || '').trim();
}

/**
 * Initializes and manages a WhatsApp connection node.
 */
async function startWhatsApp(chatId = ownerTelegramId, phoneNumber, slotId = '1', isRestart = false, retryCount = 0) {
    if (botState.isSleeping && !isRestart) return;

    const sessionKey = `${chatId}_${phoneNumber}_${slotId}`;
    if (activeSockets.has(sessionKey) && !isRestart) return;

    const sessionDir = path.join(SESSIONS_PATH, sessionKey);
    // Do NOT prune before socket creation — deleting session files before connect
    // destroys signal keys needed for decryption, causing Bad MAC on all messages.
    // Pruning is handled after connection.update 'open' fires.
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let { version } = await fetchLatestBaileysVersion();
    if (!version) version = [2, 3000, 1017531287];


    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        
        // ─── CONNECTION STABILITY ───────────────────────────────────────
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
        defaultQueryTimeoutMs: 30000,
        fireInitQueries: true,
        emitOwnEvents: true,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        
        // Return cached message for retry decryption — fixes BAD MAC on restart
        getMessage: async (key) => {
            if (global.messageCache && key?.id) {
                const cached = global.messageCache.get(key.id);
                if (cached?.message) return cached.message;
            }
            return { conversation: '' };
        },
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(message.buttonsMessage || message.templateMessage || message.listMessage);
            if (requiresPatch) { 
                message = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...message } } };
            }
            return message;
        }
    });

    // ─── PAIRING CODE GENERATION ───
    // Only request pairing on fresh sessions (not restarts) and only once
    if (!sock?.authState?.creds?.registered && !isRestart) {
        logger.system(`Initiating pairing sequence for +${phoneNumber}...`);

        let userLabel = 'papp-bot';
        if (global.tgBot && chatId) {
            try {
                const user = await global.tgBot.telegram.getChat(chatId);
                if (user && user.first_name) userLabel = user.first_name.replace(/[^a-zA-Z0-9_-]/g, '') || userLabel;
            } catch {}
        }

        // Wait for socket to be open before requesting pairing code
        const requestPairing = async () => {
            try {
                const cleanNumber = String(phoneNumber).replace(/[^0-9]/g, '');
                // Wait for WA connection to be fully open (not just started)
                await new Promise((resolve) => {
                    if (sock.ws?.readyState === 1) return resolve();
                    const check = setInterval(() => {
                        if (sock.ws?.readyState === 1) { clearInterval(check); resolve(); }
                    }, 500);
                    setTimeout(() => { clearInterval(check); resolve(); }, 15000);
                });
                await delay(2000); // extra settle time
                let code;
                // Retry up to 3 times on 428
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        code = await sock.requestPairingCode(cleanNumber);
                        break;
                    } catch (e) {
                        if (attempt < 3 && (e?.output?.statusCode === 428 || String(e.message).includes('428') || String(e.message).includes('Connection Closed'))) {
                            logger.warn(`[Pair] Attempt ${attempt} failed (${e.message}), retrying in 3s...`);
                            await delay(3000);
                        } else throw e;
                    }
                }
                logger.system(`PAIRING CODE FOR +${cleanNumber}: ${code}`);
                if (global.tgBot) {
                    await global.tgBot.telegram.sendMessage(
                        chatId,
                        `🔗 <b>PAIRING CODE for <u>${userLabel}</u> (+${cleanNumber})</b>\n\n<code>${code}</code>\n\n<i>Enter this code in WhatsApp > Linked Devices > Link with phone number.\nCustom label: <b>${userLabel}</b></i>\n\n⏳ <b>Code expires in 60 seconds. Enter it quickly!</b>`,
                        { parse_mode: 'HTML' }
                    ).catch(e => logger.error(`Failed to send pairing code: ${e.message}`));
                }
                // Mark code as sent so connection close doesn't trigger failure message
                sock._pairingCodeSent = true;
            } catch (err) {
                // Don't show error if code was already sent — connection close after code is normal
                if (sock._pairingCodeSent) {
                    logger.info(`[Pair] Socket closed after code sent for +${cleanNumber} — normal, waiting for user to enter code`);
                    return;
                }
                logger.error(`Pairing code error: ${err.message}`);
                if (global.tgBot) {
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `❌ <b>PAIRING FAILED</b>\nEnsure the number is correct and WhatsApp is installed.\nError: <code>${err.message}</code>\n\nTry /pair again.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
            }
        };
        // Small delay to let socket stabilize before requesting
        setTimeout(requestPairing, 1500);
    }

    activeSockets.set(sessionKey, sock);
    bindSocketAliases(sock, [String(phoneNumber).replace(/[^0-9]/g, '')]);
    // Fix: Only setMaxListeners if available (Baileys update compatibility)
    if (typeof sock.ev.setMaxListeners === 'function') {
        sock.ev.setMaxListeners(20);
    }
    sock.ev.on('creds.update', saveCreds);

    // ─── CONNECTION HANDLING ───
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errMsg = String(lastDisconnect?.error?.message || '').toLowerCase();
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isBadMac = errMsg.includes('bad mac') || errMsg.includes('conflict') || statusCode === 401;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired;
            const isForbidden = statusCode === 403;
            const isRateLimited = statusCode === 429;

            activeSockets.delete(sessionKey);
            unbindSocketAliases(sock);

            if (isLoggedOut) {
                logger.system(`🚨 LOGGED OUT — purging session ${sessionKey}`);
                const dir = path.join(SESSIONS_PATH, sessionKey);
                if (fs.existsSync(dir)) {
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
                }
                if (global.tgBot) {
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `🗑️ <b>SESSION PURGED</b>\nNode +${phoneNumber} was logged out and deleted. Re-pair to restore.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
                return;
            }

            // 403 = WhatsApp banned/blocked the session — stop retrying, notify owner
            if (isForbidden) {
                logger.system(`🚫 FORBIDDEN (403) — stopping reconnect for ${sessionKey}. Account may be banned.`);
                if (global.tgBot) {
                    global.tgBot.telegram.sendMessage(chatId,
                        `🚫 <b>CONNECTION FORBIDDEN (403)</b>\nNode +${phoneNumber} was rejected by WhatsApp.\nThe account may be temporarily or permanently banned.\nUse /pair to re-link if you believe this is a mistake.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
                return; // stop — no more retries
            }

            // 429 = rate limited — back off longer before retrying
            if (isRateLimited) {
                const rateLimitDelay = 5 * 60 * 1000; // 5 minutes
                logger.system(`⏳ RATE LIMITED (429) — waiting 5 min before reconnecting ${sessionKey}...`);
                setTimeout(() => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1), rateLimitDelay);
                return;
            }

            if (isBadMac) {
                // Track bad MAC count per session in memory
                if (!global._badMacCount) global._badMacCount = new Map();
                const badMacCount = (global._badMacCount.get(sessionKey) || 0) + 1;
                global._badMacCount.set(sessionKey, badMacCount);

                logger.system(`⚠️ BAD MAC (${badMacCount}) for ${sessionKey}`);
                const dir = path.join(SESSIONS_PATH, sessionKey);

                // After 5 consecutive bad MACs — full wipe + notify, stop the loop
                if (badMacCount >= 5) {
                    global._badMacCount.delete(sessionKey);
                    logger.system(`🚨 BAD MAC loop — full wipe for ${sessionKey}, re-pair required`);
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
                    if (global.tgBot) {
                        global.tgBot.telegram.sendMessage(chatId,
                            `⚠️ <b>SESSION RESET</b>\nNode +${phoneNumber} hit repeated BAD MAC errors and was wiped.\nUse /pair to re-link.`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }
                    return;
                }

                // First 2 bad MACs — just reconnect without wiping, might be a transient error
                if (badMacCount <= 2) {
                    const backoff = 10000 + Math.floor(Math.random() * 5000);
                    logger.system(`[WA] Soft reconnect for ${sessionKey} in ${Math.round(backoff/1000)}s (bad MAC ${badMacCount}/5)`);
                    setTimeout(() => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1), backoff);
                    return;
                }

                // 3rd-4th bad MAC — wipe signal files but keep creds + app-state
                try {
                    if (fs.existsSync(dir)) {
                        const files = fs.readdirSync(dir);
                        for (const f of files) {
                            if (f === 'creds.json' || f === 'connected.flag') continue;
                            if (f.startsWith('app-state')) continue;
                            try { fs.unlinkSync(path.join(dir, f)); } catch {}
                        }
                    }
                } catch {}

                if (global.messageCache) global.messageCache.clear();
                if (global._senderMsgIndex) global._senderMsgIndex.clear();

                const backoff = Math.min(20000 * Math.pow(2, badMacCount - 3), 60000) + Math.floor(Math.random() * 5000);
                logger.system(`[WA] Reconnecting ${sessionKey} in ${Math.round(backoff/1000)}s after signal wipe (bad MAC ${badMacCount}/5)`);
                setTimeout(() => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1), backoff);
                return;
            }

            // Exponential backoff with jitter: 3s → 6s → 12s → … capped at 60s
            const baseDelay = isRestartRequired ? 1500 : 3000;
            const jitter = Math.floor(Math.random() * 1500);
            const reconnectDelay = Math.min(baseDelay * Math.pow(2, Math.min(retryCount, 4)), 60000) + jitter;
            logger.system(`Connection closed (code ${statusCode}). Reconnecting ${sessionKey} in ${Math.round(reconnectDelay / 1000)}s (attempt ${retryCount + 1})...`);
            setTimeout(() => startWhatsApp(chatId, phoneNumber, slotId, true, retryCount + 1), reconnectDelay);
        }
        
        if (connection === 'open') {
            const connectedBotId = sock.user?.id?.split(':')[0];
            bindSocketAliases(sock, [connectedBotId, String(phoneNumber).replace(/[^0-9]/g, '')]);
            retryCount = 0;
            // Reset bad MAC counter on successful connect
            if (global._badMacCount) global._badMacCount.delete(sessionKey);
            logger.success(`🟩 WhatsApp Online → ${phoneNumber}`);

            // Auto-prune signal files — only on first connect per session, not on every reconnect
            if (!global._prunedSessions) global._prunedSessions = new Set();
            if (!global._prunedSessions.has(sessionKey)) {
                global._prunedSessions.add(sessionKey);
                setImmediate(async () => {
                    try {
                        const dir = path.join(SESSIONS_PATH, sessionKey);
                        if (!fs.existsSync(dir)) return;
                        const files = await fs.promises.readdir(dir);
                        const sessionFiles = files.filter(f => f.startsWith('session-') || f.startsWith('sender-key-'));
                        if (sessionFiles.length <= 3000) return;
                        const withMtime = await Promise.all(
                            sessionFiles.map(async f => ({ f, mt: (await fs.promises.stat(path.join(dir, f))).mtimeMs }))
                        );
                        withMtime.sort((a, b) => b.mt - a.mt);
                        await Promise.all(withMtime.slice(3000).map(({ f }) => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
                        logger.warn(`[WA] Pruned ${withMtime.length - 3000} stale signal files for ${sessionKey}`);
                    } catch {}
                });
            }
            engine.triggerBoot(sock);
            require('./eventBus').emit('socket.open', sock);

            // Pre-warm group metadata cache via shared groupCache module
            groupCache.warmUp(sock);

            // ── PRESENCE INDICATOR — tell WA the session is alive so it starts delivering messages
            setTimeout(async () => {
                try {
                    await sock.sendPresenceUpdate('available');
                    // Pulse available/unavailable every 4 min to keep WA delivering messages
                    if (!global._presenceIntervals) global._presenceIntervals = new Map();
                    if (global._presenceIntervals.has(sessionKey)) {
                        clearInterval(global._presenceIntervals.get(sessionKey));
                    }
                    const interval = setInterval(async () => {
                        try {
                            if (!activeSockets.has(sessionKey)) {
                                clearInterval(interval);
                                global._presenceIntervals.delete(sessionKey);
                                return;
                            }
                            await sock.sendPresenceUpdate('available');
                        } catch {}
                    }, 4 * 60 * 1000);
                    interval.unref();
                    global._presenceIntervals.set(sessionKey, interval);
                } catch {}
            }, 3000);

            // --- BEGIN: Send one-time CONNECTED message after pairing ---
            const stateFile = path.join(SESSIONS_PATH, sessionKey, 'connected.flag');
            if (!fs.existsSync(stateFile)) {
                fs.writeFileSync(stateFile, 'connected'); // write flag FIRST before any async ops
                if (global.tgBot) {
                    // Main connected message with node inline button + user guide
                    global.tgBot.telegram.sendMessage(
                        chatId,
                        `✅ <b>WHATSAPP CONNECTED!</b>\n\n📱 <code>+${phoneNumber}</code> is now live and paired.\n\n<b>What you can do now:</b>\n• Send <code>.menu</code> in any WhatsApp chat\n• Send <code>.pappy on</code> in a group to enable AI\n• Say <b>pappy</b> anywhere to trigger AI instantly\n• Use <code>.play</code>, <code>.sticker</code>, <code>.img</code> and more\n\n<pre>┏━━━━━━━━━━━━━━━━━━━━━━┓\n┃  🟢  CONNECTED!      ┃\n┗━━━━━━━━━━━━━━━━━━━━━━┛</pre>`,
                        {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `📱 Manage Node +${phoneNumber}`, callback_data: `node_${sessionKey}` }],
                                    [{ text: '📖 User Guide', callback_data: 'cmd_guide' }, { text: '🏠 Main Hub', callback_data: 'menu_main' }],
                                ]
                            }
                        }
                    ).catch(() => {});

                    // AI greeting message — sent separately so it feels natural
                    setTimeout(() => {
                        global.tgBot.telegram.sendMessage(
                            chatId,
                            `🤖 <b>Hey! I'm Pappy.</b>\n\nIf you're ever confused or need help, just call me — say <b>pappy</b> anywhere in your WhatsApp chat and I'll respond. No need to turn anything on.\n\n<i>You can also do <code>.pappy on</code> in a group to keep me active there all the time.</i>`,
                            { parse_mode: 'HTML' }
                        ).catch(() => {});
                    }, 1500);
                }
            }
            // --- END: CONNECTED message ---
        }
    });

    // ─── MESSAGE EVENT ROUTING ───
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Update last activity timestamp for self-healing
        if (!global._lastMsgActivity) global._lastMsgActivity = new Map();
        global._lastMsgActivity.set(sessionKey, Date.now());

        // ── POLL VOTE DETECTION for .song ──────────────────────────────────────
        for (const m of messages) {
            try {
                if (!m.message?.pollUpdateMessage) continue;
                const groupJid = m.key?.remoteJid;
                if (!groupJid) continue;

                // Get the poll creation message to read option names
                const pollCreationKey = m.message.pollUpdateMessage.pollCreationMessageKey?.id;
                const cachedPoll = global.messageCache?.get(pollCreationKey);
                const pollName = cachedPoll?.message?.pollCreationMessageV3?.name || cachedPoll?.message?.pollCreationMessage?.name || '';
                if (!pollName.includes('Pick a song')) continue;

                // Get voted option index from selectedOptions hash
                const selectedHashes = m.message.pollUpdateMessage.vote?.selectedOptions || [];
                if (!selectedHashes.length) continue;

                const opts = cachedPoll?.message?.pollCreationMessageV3?.options || cachedPoll?.message?.pollCreationMessage?.options || [];
                let votedName = '';
                let votedIdx = 0;
                if (opts.length) {
                    const crypto = require('crypto');
                    for (let i = 0; i < opts.length; i++) {
                        const optName = opts[i].optionName || '';
                        const hash = crypto.createHash('sha256').update(Buffer.from(optName)).digest();
                        if (selectedHashes.some(h => {
                            const hBuf = Buffer.isBuffer(h) ? h : Buffer.from(h);
                            return hBuf.equals(hash);
                        })) {
                            votedName = optName;
                            votedIdx = i;
                            break;
                        }
                    }
                }

                // Extract song title from option (format: "Title [duration]")
                const songTitle = (votedName || opts[votedIdx]?.optionName || '').replace(/\s*\[.*?\]\s*$/, '').trim();
                if (!songTitle) continue;

                // Find the cached result by matching title so we use the exact URL
                let cachedResult = null;
                if (global._songSearchCache?.size) {
                    for (const [token, entry] of global._songSearchCache.entries()) {
                        if (entry.jid !== groupJid) continue;
                        const match = entry.results.find(r => songTitle.includes(r.title.slice(0, 20)) || r.title.slice(0, 20).includes(songTitle.slice(0, 20)));
                        if (match) { cachedResult = match; global._songSearchCache.delete(token); break; }
                    }
                }

                logger.info(`[Poll] Song selected: ${songTitle}`);
                const statusMsg = await sock.sendMessage(groupJid, { text: `⏳ Got it! Downloading *${songTitle}*...` });

                (async () => {
                    try {
                        let result = cachedResult;
                        if (!result) {
                            const { searchYoutube } = require('../core/youtube');
                            const results = await searchYoutube(songTitle, 1);
                            if (!results?.length) throw new Error('Not found');
                            result = results[0];
                        }
                        const execAsync = require('util').promisify(require('child_process').exec);
                        const fsp = require('fs').promises;
                        const tmpDir = path.join(__dirname, '../data/temp_media');
                        fs.mkdirSync(tmpDir, { recursive: true });
                        const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                        const ytDlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
                        const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
                        const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
                        await execAsync(`${ytDlp} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`, { timeout: 120000 });
                        if (fs.existsSync(outPath)) {
                            const buf = await fsp.readFile(outPath);
                            await sock.sendMessage(groupJid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${result.title}.mp3` });
                            fsp.unlink(outPath).catch(() => {});
                            await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
                        }
                    } catch (e) {
                        await sock.sendMessage(groupJid, { text: `❌ Download failed: ${e.message.slice(0, 100)}` });
                        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
                    }
                })();
            } catch (e) {
                logger.warn(`[Poll] Error: ${e.message}`);
            }
        }

                try {
        if (botState.isSleeping || (type !== 'notify' && type !== 'append')) return;
        
        const msg = messages[0];
        if (!msg?.message) return;
        const _rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        // Only log messages that have actual text content
        if (_rawText) logger.info(`[MSG] type=${type} fromMe=${msg.key?.fromMe} text=${_rawText.slice(0,40)}`);

        // Cache ALL messages in the batch (not just index 0) so deleteall can find bot-sent audio/songs
        for (const m of messages) {
            if (m?.key?.id && m?.message) {
                global.messageCache.set(m.key.id, m);
                while (global.messageCache.size > MAX_MESSAGE_CACHE_SIZE) {
                    const oldest = global.messageCache.keys().next().value;
                    if (!oldest) break;
                    global.messageCache.delete(oldest);
                }
                // Index by sender for fast deleteall lookup
                const groupJid = m.key?.remoteJid;
                if (groupJid) {
                    let senderDigits;
                    if (m.key?.fromMe) {
                        senderDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');
                    } else {
                        senderDigits = String(m.key?.participant || '').replace(/[^0-9]/g, '');
                    }
                    if (senderDigits) {
                        const indexKey = `${groupJid}:${senderDigits}`;
                        if (!global._senderMsgIndex.has(indexKey)) global._senderMsgIndex.set(indexKey, new Set());
                        global._senderMsgIndex.get(indexKey).add(m.key.id);
                    }
                }
            }
        }

        const jid = msg.key.remoteJid;
        if (!jid) return; // guard null JID — prevents jidDecode crash
        const isGroup = jid.endsWith('@g.us');
        
        const botId = sock.user?.id?.split(':')[0] || phoneNumber;
        const fullBotJid = `${botId}@s.whatsapp.net`;
        const nodeState = getNodeState(phoneNumber);
        const nodeMode = nodeState.nodeMode || 'public';
        
        let text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            msg.message?.buttonsResponseMessage?.selectedDisplayText ||
            msg.message?.listResponseMessage?.title ||
            msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
            msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            msg.message?.ephemeralMessage?.message?.conversation ||
            msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            msg.message?.ephemeralMessage?.message?.imageMessage?.caption ||
            msg.message?.ephemeralMessage?.message?.videoMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.imageMessage?.caption ||
            msg.message?.viewOnceMessage?.message?.videoMessage?.caption ||
            ''
        ).trim();

        // Learn rich preview cards users send so later status/godcast can reuse them.
        const directCtx = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo;
        const ephCtx = msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.videoMessage?.contextInfo;
        const observedCtx = directCtx || ephCtx;
        if (observedCtx?.externalAdReply) {
            rememberPreviewHint(text, observedCtx);
        }

        // Cache full extendedTextMessage when it has a link preview
        // so .updategstatus / .godcast / .gcast can relay it exactly
        const extMsg = msg.message?.extendedTextMessage;
        if (extMsg?.matchedText && msg.key?.id) {
            try {
                const { connection: redis } = require('../services/redis');
                const cacheKey = `ext:${extMsg.matchedText.slice(0, 200)}`;
                redis.set(cacheKey, JSON.stringify(extMsg), 'EX', 3600).catch(() => {});
            } catch {}
        }
        
        // Check if this is actually a sticker message (not text)
        const isActualSticker = !!(msg.message?.stickerMessage);
        
        // If it's a sticker, don't treat it as text
        if (isActualSticker) {
            text = ''; // Clear text so it doesn't trigger text responses
        }

        const sender = msg.key.fromMe ? fullBotJid : resolveSenderJid(msg, fullBotJid);
        let isGroupAdmin = isGroup ? getCachedAdminStatus(jid, sender) : false;
        let botIsGroupAdmin = isGroup ? getCachedAdminStatus(jid, fullBotJid) : false;

        // Private mode: only node owner + general owner can interact at all
        if (nodeMode === 'private' && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber)) {
            return;
        }

        // Hard DM policy: only the general owner OR this session's own number can interact in DM
        if (!isGroup && !msg.key.fromMe && !isOwnerJidForSession(sender, phoneNumber)) {
            return;
        }

        // ── STICKER TRIGGER HANDLER ──────────────────────────────────────────
        let isStickerTriggered = false;
        if (msg.message?.stickerMessage && !text) {
            try {
                const sticker = msg.message.stickerMessage;
                // Handle all fileSha256 formats (Buffer, {type,data}, base64 string)
                let stickerId = null;
                const sha = sticker.fileSha256;
                if (sha) {
                    if (Buffer.isBuffer(sha)) stickerId = sha.toString('base64');
                    else if (sha?.type === 'Buffer' && Array.isArray(sha?.data)) stickerId = Buffer.from(sha.data).toString('base64');
                    else if (typeof sha === 'string') stickerId = sha;
                    else stickerId = Buffer.from(sha).toString('base64');
                }
                if (stickerId) {
                    const bindDbPath = path.join(__dirname, '../data/stickerCmds.json');
                    // Always reload to pick up new binds
                    try { global._stickerCmdsCache = fs.existsSync(bindDbPath) ? JSON.parse(fs.readFileSync(bindDbPath, 'utf-8')) : {}; } catch { global._stickerCmdsCache = {}; }
                    const boundCmd = global._stickerCmdsCache[stickerId];
                    if (boundCmd) {
                        text = boundCmd;
                        isStickerTriggered = true;
                        // Preserve original message structure so commands like .tag work with context
                        // Only replace conversation, keep contextInfo intact
                        const origCtxInfo = msg.message?.stickerMessage?.contextInfo || null;
                        msg.message = {
                            extendedTextMessage: {
                                text: boundCmd,
                                contextInfo: origCtxInfo || {}
                            }
                        };
                        logger.info(`[Sticker Trigger] Fired: ${boundCmd}`);
                    }
                }
            } catch (e) {
                logger.error(`[Sticker Trigger] Error: ${e.message}`);
            }
        }

        // Only refresh group meta if cache is stale — don't block on every message
        if (isGroup) refreshGroupMeta(sock, jid);

        // ── SONG PICK HANDLER — user replies with number after .song search ────────────────
        if (text && /^[1-5]$/.test(text.trim()) && global._songSearchCache?.size > 0) {
            const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            for (const [token, entry] of global._songSearchCache.entries()) {
                if (entry.jid === jid) {
                    const pick = parseInt(text.trim()) - 1;
                    const result = entry.results?.[pick];
                    if (result) {
                        global._songSearchCache.delete(token);
                        const statusMsg = await sock.sendMessage(jid, { text: `🎵 *${result.title}*\n⏳ Downloading...` }, { quoted: msg });
                        try {
                            const { exec } = require('child_process');
                            const util = require('util');
                            const execAsync = util.promisify(exec);
                            const fsp = require('fs').promises;
                            const tmpDir = path.join(__dirname, '../data/temp_media');
                            fs.mkdirSync(tmpDir, { recursive: true });
                            const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                            const ytDlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
                            const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
                            const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
                            await execAsync(`${ytDlp} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`, { timeout: 120000 });
                            if (fs.existsSync(outPath)) {
                                const buf = await fsp.readFile(outPath);
                                await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${result.title}.mp3` }, { quoted: msg });
                                fsp.unlink(outPath).catch(() => {});
                                await sock.sendMessage(jid, { delete: statusMsg.key }).catch(() => {});
                            }
                        } catch (e) {
                            await sock.sendMessage(jid, { text: `❌ Download failed: ${e.message}` }, { quoted: msg });
                        }
                    }
                    break;
                }
            }
        }

        const normalizedCommandText = normalizeCommandText(text, phoneNumber);
        // Handle "next" reply to song info message
        const quotedMsgText = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || '';
        const isNextReply = text?.trim().toLowerCase() === 'next' && quotedMsgText.includes('Tap your choice above');
        const isCommandMessage = !!normalizedCommandText || isNextReply;
        if (isNextReply && !normalizedCommandText) {
            // Treat as .song next [query]
            const songQuery = quotedMsgText.match(/Pick a song: (.+)/)?.[1] || '';
            if (songQuery) {
                engine.triggerMessage({ sock, msg, text: `.song next ${songQuery}`, isGroup, sender, botId, isGroupAdmin, botIsGroupAdmin });
                return;
            }
        }
        if (isCommandMessage) {
            engine.triggerMessage({
                sock,
                msg,
            text: normalizedCommandText,
                isGroup,
                sender,
                botId,
                isGroupAdmin,
                botIsGroupAdmin,
                resolveIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    const senderNorm = String(sender || '').replace(/:\d+(?=@)/g, '');
                    const participant = meta.participants.find((p) => {
                        const pid = String(p?.id || '');
                        return pid === sender || pid === senderNorm || pid.replace(/:\d+(?=@)/g, '') === senderNorm;
                    });
                    return participant?.admin?.includes('admin') || false;
                },
                resolveBotIsGroupAdmin: async () => {
                    if (!isGroup) return false;
                    const meta = await getCachedGroupMeta(sock, jid);
                    const fullNorm = String(fullBotJid || '').replace(/:\d+(?=@)/g, '');
                    const botParticipant = meta.participants.find((p) => {
                        const pid = String(p?.id || '');
                        return pid === fullBotJid || pid === fullNorm || pid.replace(/:\d+(?=@)/g, '') === fullNorm;
                    });
                    return botParticipant?.admin?.includes('admin') || false;
                }
            });
            return;
        }

        // ─── AI context — check all message types for reply context ────────
        // WA puts contextInfo in different places depending on message type
        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || msg.message?.audioMessage?.contextInfo
            || msg.message?.documentMessage?.contextInfo
            || msg.message?.stickerMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo
            || msg.message?.ephemeralMessage?.message?.imageMessage?.contextInfo
            || null;
        const mentionedJids     = ctxInfo?.mentionedJid || [];
        const isMentioned       = mentionedJids.some(j => j.startsWith(botId));
        const quotedParticipant = ctxInfo?.participant;
        const quotedStanzaId    = ctxInfo?.stanzaId;
        const cachedMsg         = quotedStanzaId ? global.messageCache.get(quotedStanzaId) : null;
        const botDigits         = String(botId).replace(/[^0-9]/g, '');
        const quotedDigits      = String(quotedParticipant || '').replace(/[^0-9]/g, '');
        const isReplyToBot = !!(
            quotedParticipant?.startsWith(botId) ||
            (quotedDigits && quotedDigits === botDigits) ||
            cachedMsg?.key?.fromMe ||
            ctxInfo?.quotedMessage?.key?.fromMe
        );
        const hasImage          = !!(msg.message?.imageMessage);
        const hasVoice          = !!(msg.message?.audioMessage?.ptt);
        const hasSticker        = !!(msg.message?.stickerMessage);
        // Quoted image — user replied to an image with text like "make sticker" or "describe"
        const quotedImageMsg    = ctxInfo?.quotedMessage?.imageMessage || ctxInfo?.quotedMessage?.ephemeralMessage?.message?.imageMessage;
        const hasQuotedImage    = !!(quotedImageMsg) && !hasImage;
        const pappyOn           = nodeState.pappyMode?.[jid] === true;
        
        // Debug: log when sticker is detected
        if (hasSticker && pappyOn && isGroup) {
            logger.info(`[STICKER] Detected sticker message from ${sender}`);
        }

        // Sticker reply-to-bot detection
        const stickerCtxInfo = msg.message?.stickerMessage?.contextInfo;
        const stickerCachedMsg = stickerCtxInfo?.stanzaId ? global.messageCache.get(stickerCtxInfo.stanzaId) : null;
        const isStickerReplyToBot = !!(stickerCtxInfo?.participant?.startsWith(botId)) || !!(stickerCachedMsg?.key?.fromMe);

        // AI responds in groups when mentioned/replied; stickers can also trigger AI flow.
        // In DM, pappy mode (if enabled for that chat) can respond naturally.
        // "pappy" keyword trigger — works in any chat even without .pappy on
        // hasPappyTrigger only works when pappy mode is ON or in DM
        const hasPappyTrigger = !msg.key.fromMe && /\bpappy\b/i.test(text) && (pappyOn || !isGroup);

        const shouldRespond = !msg.key.fromMe && (
            // In groups: respond to mentions and replies always, pappy keyword only if mode ON
            (isGroup && (isMentioned || isReplyToBot || isStickerReplyToBot || hasPappyTrigger)) ||
            // Pappy mode ON: respond to everything in the group
            (pappyOn && isGroup) ||
            // DM: only owner/node owner
            (!isGroup && isOwnerJidForSession(sender, phoneNumber))
        );
        
        if (shouldRespond && !text.startsWith(globalPrefix)) {
            const msgId = msg.key.id || '';
            // Dedup check — skip if same message already queued
            if (!canAiReply(msgId)) return;

            const { downloadMediaMessage } = require('gifted-baileys');
            const ai = require('./ai');
            sock.sendPresenceUpdate('composing', jid).catch(() => {});
            logger.info(`[AI] Queued - Sticker: ${hasSticker}, Mentioned: ${isMentioned}, Reply: ${isReplyToBot}`);

            // Push into per-session queue — 1 AI call at a time per node
            // If queue is backed up (>3 tasks), drop oldest to stay responsive
            const aiQ = getAiQueue(sessionKey);
            if (aiQ.length() > 3) {
                logger.warn(`[AI] Queue backed up for ${sessionKey}, dropping oldest task`);
                aiQ.kill();
            }
            aiQ.push(async () => {
                try {
                    let response = '';

                if (hasSticker) {
                    // User sent sticker - reply with STICKER ONLY (no text)
                    
                    const stickerPrompts = [
                        'cool anime guy character with glowing aura aesthetic',
                        'powerful anime male warrior energy aura',
                        'aesthetic anime boy character epic vibe',
                        'anime male character legendary pose glowing',
                        'sigma anime guy energy aesthetic',
                        'anime male protagonist power up aura glowing',
                        'epic anime guy power up scene glowing energy',
                        'legendary anime male character aesthetic pose',
                        'anime guy with cosmic aura background',
                        'cool anime girl character with glowing aura aesthetic',
                        'powerful anime female warrior energy aura',
                        'aesthetic anime girl character epic vibe',
                        'anime female character legendary pose glowing',
                        'anime girl protagonist power up aura glowing'
                    ];
                    
                    const randomPrompt = stickerPrompts[Math.floor(Math.random() * stickerPrompts.length)];
                    const cacheKey = Buffer.from(randomPrompt).toString('base64').slice(0, 20);
                    
                    // Send sticker only (no text)
                    try {
                        let stickerBuffer;
                        
                        if (global.stickerCache.has(cacheKey)) {
                            stickerBuffer = global.stickerCache.get(cacheKey);
                        } else {
                            const imgBuffer = await Promise.race([
                                ai.generateImage(randomPrompt),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                            ]);

                            const generated = await generateAnimatedSticker(imgBuffer);
                            stickerBuffer = generated.buffer;
                            
                            if (global.stickerCache.size >= 50) {
                                const firstKey = global.stickerCache.keys().next().value;
                                global.stickerCache.delete(firstKey);
                            }
                            global.stickerCache.set(cacheKey, stickerBuffer);
                        }
                        
                        await sock.sendMessage(jid, { sticker: stickerBuffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg });
                        logger.success('[AI] Sticker sent');
                    } catch (err) {
                        logger.error(`[AI] Sticker failed: ${err.message}`);
                    }
                    
                    return;
                } else if (hasImage || hasQuotedImage) {
                    let imgBuffer;
                    if (hasImage) {
                        imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    } else {
                        // Download the quoted image
                        const quotedMsg = { key: { remoteJid: jid, id: ctxInfo.stanzaId, fromMe: false }, message: ctxInfo.quotedMessage };
                        imgBuffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    }
                    const cleanText = text.replace(/@\d+/g, '').trim().toLowerCase();
                    // If user wants a sticker from the image, convert directly
                    const wantsSticker = /sticker|stickify|convert|make.*sticker|turn.*sticker/i.test(cleanText);
                    if (wantsSticker) {
                        try {
                            const { generateAnimatedSticker } = require('./stickerEngine');
                            const result = await generateAnimatedSticker(imgBuffer);
                            await sock.sendMessage(jid, { sticker: result.buffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } }, { quoted: msg });
                            return;
                        } catch (err) {
                            logger.error('[AI] Image-to-sticker failed: ' + err.message);
                        }
                    }
                    const prompt = cleanText || 'Describe this image';
                    response = await ai.analyzeImage(imgBuffer, prompt, sender);
                } else if (hasVoice) {
                    const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: null, reuploadRequest: sock.updateMediaMessage });
                    response = await ai.analyzeVoice(audioBuffer, sender);
                    
                    // Reply with voice note instead of text
                    try {
                        const voiceReply = await ai.textToSpeech(response);
                        await sock.sendMessage(jid, { audio: voiceReply, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
                        return;
                    } catch (ttsErr) {
                        logger.warn(`[AI] TTS failed, sending text: ${ttsErr.message}`);
                        // Fall through to send text response
                    }
                } else if (text) {
                    const cleanPrompt = text.replace(/@\d+/g, '').trim();
                    if (!cleanPrompt) return;
                    response = await ai.generateText(cleanPrompt, sender);
                } else return;

                if (response.startsWith('EXECUTE_COMMAND:')) {
                    try {
                        const { exec } = require('child_process');
                        const util = require('util');
                        const execAsync = util.promisify(exec);
                        const command = response.slice(16).trim();
                        
                        // SECURITY: Block destructive commands and protect bot infrastructure
                        const destructivePatterns = [
                            /rm\s+-rf\s+\//, // rm -rf / or any root deletion
                            /rm\s+-rf\s+~/, // rm -rf home directory
                            /rm\s+-rf\s+\*/, // rm -rf * mass deletion
                            /rm.*\/home\/ubuntu/, // any rm targeting /home/ubuntu
                            /rmdir.*\/home\/ubuntu/, // any rmdir targeting /home/ubuntu
                            /mv.*\/home\/ubuntu.*\/dev\/null/, // moving bot files to /dev/null
                            /rm.*omega-v5-final/, // protect main bot
                            /rm.*kord-ai/, // protect kord ai
                            /rm.*pappy/, // protect pappy bots
                            /reboot/, /shutdown/, /poweroff/, /halt/,
                            /mkfs/, /fdisk.*w/, /dd.*of=\/dev/,
                            /pm2\s+(delete|kill)\s+all/, // don't kill all pm2 processes
                            /pm2\s+delete\s+(omega|kord|pappy)/, // don't delete specific bots
                            /systemctl\s+stop\s+(pm2|nginx|mysql|postgres)/ // don't stop critical services
                        ];
                        
                        const isDestructive = destructivePatterns.some(pattern => 
                            pattern.test(command.toLowerCase())
                        );
                        
                        if (isDestructive) {
                            await sock.sendMessage(jid, { text: 'nah i\'m not deleting my own infrastructure or the bot files. that\'s self-destruction. i can do everything else tho' }, { quoted: msg });
                            logger.warn(`[AI] Blocked destructive command: ${command}`);
                            return;
                        }
                        
                        logger.info(`[AI CMD] WA:${sender} → ${command}`);
                        
                        const { stdout, stderr } = await execAsync(command, { 
                            timeout: 30000,
                            maxBuffer: 1024 * 1024
                        });
                        
                        const output = (stdout + stderr).trim();
                        const result = output.length > 0 ? output : 'command executed successfully';
                        logger.success(`[AI CMD] Output:\n${result.slice(0, 500)}`);
                        const finalOutput = result.length > 2000 ? result.slice(0, 2000) + '\n\n... (output truncated)' : result;
                        
                        await sock.sendMessage(jid, { text: `\`\`\`\n${finalOutput}\n\`\`\`` }, { quoted: msg });
                        logger.success('[AI] Command executed');
                    } catch (err) {
                        logger.error(`[AI] Command failed: ${err.message}`);
                        await sock.sendMessage(jid, { text: `error: ${err.message}` }, { quoted: msg });
                    }
                    return;
                }
                if (response.startsWith('PLAY:')) {
                    const musicModule = require('../plugins/pappy-music');
                    await musicModule.execute({ sock, msg, args: response.slice(5).trim().split(' '), text: `.play ${response.slice(5).trim()}`, user: { name: 'AI' }, botId });
                    return;
                }
                if (response.startsWith('GENERATE_IMAGE:')) {
                    try { await sock.sendMessage(jid, { image: await ai.generateImage(response.slice(15).trim()), caption: '' }, { quoted: msg }); }
                    catch { await sock.sendMessage(jid, { text: "couldn't generate that image" }, { quoted: msg }); }
                    return;
                }
                if (response.startsWith('SPEAK:')) {
                    try { await sock.sendMessage(jid, { audio: await ai.textToSpeech(response.slice(6).trim()), mimetype: 'audio/mpeg', ptt: true }, { quoted: msg }); }
                    catch { await sock.sendMessage(jid, { text: response.slice(6).trim() }, { quoted: msg }); }
                    return;
                }
                if (response.startsWith('SEARCH_VIDEO:')) {
                    try {
                        const { buffer, title } = await ai.searchVideo(response.slice(13).trim());
                        await sock.sendMessage(jid, { video: buffer, caption: title, mimetype: 'video/mp4' }, { quoted: msg });
                    } catch { await sock.sendMessage(jid, { text: "couldn't find that video" }, { quoted: msg }); }
                    return;
                }
                if (response.startsWith('SEND_STICKER:')) {
                    try {
                        const description = response.slice(13).trim();
                        const cacheKey = Buffer.from(description).toString('base64').slice(0, 20);
                        
                        let stickerBuffer;
                        
                        // Check cache first
                        if (global.stickerCache.has(cacheKey)) {
                            logger.info('[AI] Using cached sticker');
                            stickerBuffer = global.stickerCache.get(cacheKey);
                        } else {
                            logger.info(`[AI] Generating sticker: ${description}`);
                            const imgBuffer = await Promise.race([
                                ai.generateImage(description),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000))
                            ]);

                            const generated = await generateAnimatedSticker(imgBuffer);
                            stickerBuffer = generated.buffer;
                            
                            // Cache it
                            if (global.stickerCache.size >= 50) {
                                const firstKey = global.stickerCache.keys().next().value;
                                global.stickerCache.delete(firstKey);
                            }
                            global.stickerCache.set(cacheKey, stickerBuffer);
                        }
                        
                        // Send without quoting to avoid old message issues
                        await sock.sendMessage(jid, { sticker: stickerBuffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } });
                        logger.success('[AI] Sticker sent & cached');
                    } catch (err) {
                        logger.error(`[AI] Sticker failed: ${err.message}`);
                        await sock.sendMessage(jid, { text: "couldn't make that sticker rn" }, { quoted: msg });
                    }
                    return;
                }

                // Check if response contains a link and generate preview
                const { buildLinkPreview, extractUrls } = require('./linkPreview');
                const urls = extractUrls(response);

                if (urls.length > 0) {
                    try {
                        const preview = await buildLinkPreview(response, false).catch(() => null);
                        if (preview?.externalAdReply) {
                            // Ensure Open button shows with renderLargerThumbnail
                            preview.externalAdReply.renderLargerThumbnail = true;
                            await sock.sendMessage(jid, {
                                text: response,
                                contextInfo: preview
                            }, { quoted: msg });
                        } else {
                            await sock.sendMessage(jid, { text: response }, { quoted: msg });
                        }
                    } catch {
                        await sock.sendMessage(jid, { text: response }, { quoted: msg });
                    }
                } else {
                    await sock.sendMessage(jid, { text: response }, { quoted: msg });
                }
                
                // Send ONE sticker after text for aura farming (no spam)
                try {
                    const stickerPrompts = [
                        'cool anime guy character with glowing aura aesthetic',
                        'powerful anime male warrior energy aura',
                        'aesthetic anime boy character epic vibe',
                        'anime male character legendary pose glowing',
                        'sigma anime guy energy aesthetic',
                        'anime male protagonist power up aura glowing',
                        'cool anime girl character with glowing aura aesthetic',
                        'aesthetic anime girl character epic vibe'
                    ];
                    
                    const randomPrompt = stickerPrompts[Math.floor(Math.random() * stickerPrompts.length)];
                    const cacheKey = Buffer.from(randomPrompt).toString('base64').slice(0, 20);
                    
                    let stickerBuffer;
                    if (global.stickerCache.has(cacheKey)) {
                        stickerBuffer = global.stickerCache.get(cacheKey);
                    } else {
                        const imgBuffer = await Promise.race([
                            ai.generateImage(randomPrompt),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                        ]);
                        
                        const generated = await generateAnimatedSticker(imgBuffer);
                        stickerBuffer = generated.buffer;
                        
                        if (global.stickerCache.size >= 50) {
                            const firstKey = global.stickerCache.keys().next().value;
                            global.stickerCache.delete(firstKey);
                        }
                        global.stickerCache.set(cacheKey, stickerBuffer);
                    }
                    
                    await sock.sendMessage(jid, { sticker: stickerBuffer, stickerMetadata: { packName: 'Ω Pappy Ultimate', packPublish: 'pappylung', packId: 'pappy-ultimate-v5', categories: ['🔥'], isAvatar: false, isAiSticker: true } });
                } catch (err) {
                    logger.error(`[AI] Sticker after text failed: ${err.message}`);
                }

            } catch (err) {
                logger.warn(`[AI] Failed: ${err.message}`);
                await sock.sendMessage(jid, { text: 'something went wrong, try again' }, { quoted: msg }).catch(() => {});
            }
            }); // End AI queue task
            return;
        }

        engine.triggerMessage({ sock, msg, text, isGroup, sender, botId, isGroupAdmin });
        } catch (err) {
            logger.error(`[WA] messages.upsert crash prevented: ${err.message}`);
        }
    });

    // ─── KEEP GROUP CACHE FRESH ON PARTICIPANT / METADATA CHANGES ────────────────
    // ── POLL VOTE HANDLER — for .song poll selection ────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            try {
                if (!update.update?.pollUpdates) continue;
                const pollVote = update.update.pollUpdates[0];
                if (!pollVote) continue;
                const votedOption = pollVote.vote?.selectedOptions?.[0];
                if (!votedOption) continue;

                const voter = update.key?.participant || update.key?.remoteJid;
                const groupJid = update.key?.remoteJid;

                // Find matching song search cache
                if (!global._songSearchCache?.size) continue;
                for (const [token, entry] of global._songSearchCache.entries()) {
                    if (entry.jid !== groupJid) continue;
                    // Match voted option to result
                    const idx = entry.results.findIndex(r =>
                        votedOption.includes(r.title.slice(0, 30))
                    );
                    if (idx === -1) continue;
                    const result = entry.results[idx];
                    global._songSearchCache.delete(token);

                    const statusMsg = await sock.sendMessage(groupJid, {
                        text: `🎵 *${result.title}*\n⏳ Downloading...`
                    });
                    try {
                        const { exec } = require('child_process');
                        const util = require('util');
                        const execAsync = util.promisify(exec);
                        const fsp = require('fs').promises;
                        const tmpDir = path.join(__dirname, '../data/temp_media');
                        fs.mkdirSync(tmpDir, { recursive: true });
                        const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                        const ytDlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
                        const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
                        const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
                        await execAsync(
                            `${ytDlp} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`,
                            { timeout: 120000 }
                        );
                        if (fs.existsSync(outPath)) {
                            const buf = await fsp.readFile(outPath);
                            await sock.sendMessage(groupJid, {
                                audio: buf, mimetype: 'audio/mpeg', ptt: false,
                                fileName: `${result.title}.mp3`
                            });
                            fsp.unlink(outPath).catch(() => {});
                            await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
                        }
                    } catch (e) {
                        await sock.sendMessage(groupJid, { text: `❌ Download failed: ${e.message.slice(0, 100)}` });
                    }
                    break;
                }
            } catch {}
        }
    });

    // ── POLL VOTE HANDLER — poll votes come as pollUpdateMessage in messages.upsert ──
    sock.ev.on('messages.upsert', async ({ messages: pollMsgs, type: pollType }) => {
        if (pollType !== 'notify') return;
        if (pollType !== 'notify') return;
        for (const pollMsg of pollMsgs) {
            try {
                const pollUpdate = pollMsg.message?.pollUpdateMessage;
                if (!pollUpdate) continue;
                if (!global._songSearchCache?.size) continue;
                const groupJid = pollMsg.key?.remoteJid;
                const voter = pollMsg.key?.participant || pollMsg.key?.remoteJid;

                // Decrypt voted options
                const { getAggregateVotesInPollMessage } = require('gifted-baileys');
                let votedOptions = [];
                try {
                    const pollCreationMsgKey = pollUpdate.pollCreationMessageKey;
                    // Find the original poll message to get encKey
                    const cachedPoll = global.messageCache?.get(pollCreationMsgKey?.id);
                    if (cachedPoll?.message?.pollCreationMessage) {
                        const encKey = cachedPoll.message.pollCreationMessage.encKey;
                        const votes = await getAggregateVotesInPollMessage({
                            message: cachedPoll.message,
                            pollUpdates: [pollMsg.message.pollUpdateMessage],
                        }, encKey);
                        votedOptions = votes.filter(v => v.voters?.length > 0).map(v => v.name);
                    }
                } catch {
                    // Fallback: try to get option from raw selectedOptions hash
                    votedOptions = pollUpdate.vote?.selectedOptions?.map(o => Buffer.from(o).toString('utf8').replace(/[^\x20-\x7E]/g, '')) || [];
                }

                if (!votedOptions.length) continue;

                for (const [token, entry] of global._songSearchCache.entries()) {
                    if (entry.jid !== groupJid) continue;
                    const votedText = votedOptions[0] || '';
                    const idx = entry.results.findIndex(r => votedText.includes(r.title.slice(0, 20)) || r.title.slice(0, 20).includes(votedText.slice(0, 20)));
                    if (idx === -1) continue;
                    const result = entry.results[idx];
                    global._songSearchCache.delete(token);

                    // Heads up message
                    const statusMsg = await sock.sendMessage(groupJid, {
                        text: `⏳ Got it! Downloading *${result.title}*...\n🎵 Sending shortly`
                    });
                    try {
                        const execAsync = require('util').promisify(require('child_process').exec);
                        const fsp = require('fs').promises;
                        const tmpDir = path.join(__dirname, '../data/temp_media');
                        fs.mkdirSync(tmpDir, { recursive: true });
                        const outPath = path.join(tmpDir, `song_${Date.now()}.mp3`);
                        const ytDlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
                        const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
                        const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';
                        await execAsync(`${ytDlp} ${cookieArg} -x --audio-format mp3 --audio-quality 2 --max-filesize 48m --no-playlist --no-warnings -o "${outPath}" "${result.url}"`, { timeout: 120000 });
                        if (fs.existsSync(outPath)) {
                            const buf = await fsp.readFile(outPath);
                            await sock.sendMessage(groupJid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${result.title}.mp3` });
                            fsp.unlink(outPath).catch(() => {});
                            await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
                        }
                    } catch (e) {
                        await sock.sendMessage(groupJid, { text: `❌ Download failed: ${e.message.slice(0, 100)}` });
                        await sock.sendMessage(groupJid, { delete: statusMsg.key }).catch(() => {});
                    }
                    break;
                }
            } catch {}
        }
    });

    sock.ev.on('groups.update', (updates) => {
        for (const update of updates) {
            if (update.id) groupCache.invalidate(update.id);
        }
    });
    sock.ev.on('group-participants.update', ({ id }) => {
        if (id) groupCache.invalidate(id);
    });

    return sock;
}

function setPappyMode(jid, value, phone) {
    if (phone) {
        const state = getNodeState(phone);
        if (!state.pappyMode) state.pappyMode = {};
        state.pappyMode[jid] = value;
        saveNodeState(phone);
    } else {
        if (!botState.pappyMode) botState.pappyMode = {};
        botState.pappyMode[jid] = value;
        saveState();
    }
}

module.exports = { startWhatsApp, activeSockets, loadState, saveState, botState, setPappyMode, getCommandPrefix, setCommandPrefix, getNodeMode, setNodeMode, getNodeState };
