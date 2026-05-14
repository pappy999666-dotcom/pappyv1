// index.js
// Ω ELITE MULTI-SESSION OPERATOR (ADVANCED CORE)

const fs = require('fs');
const path = require('path');
const { startWhatsApp, activeSockets } = require('./core/whatsapp');
const { startTelegram } = require('./core/telegram');
const logger = require('./core/logger');
const { ownerTelegramId } = require('./config');
const watchdog = require('./core/watchdog');
const { connectDB } = require('./core/database'); // 👈 NEW: Importing our database connector
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🛡️ ZERO-CRASH TOLERANCE
process.on('uncaughtException', (err) => {
    logger.error(`[CRASH PREVENTED] Uncaught Exception: ${err?.message || err}`);
    if (err?.stack) logger.error(err.stack.split('\n').slice(0, 4).join(' | '));
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason || 'unknown');
    logger.error(`[CRASH PREVENTED] Unhandled Rejection: ${msg}`);
    if (reason?.stack) logger.error(reason.stack.split('\n').slice(0, 4).join(' | '));
});

// Suppress gifted-baileys internal signal session console.log spam
// Only suppress to file — never intercept console.log as it breaks Baileys event processing
const _origLog = console.log.bind(console);
// Do NOT override console.log — it breaks Baileys internal event handling


process.on('SIGINT', async () => {
    logger.warn('Shutting down safely... clearing queues.');
    process.exit(0);
});

// 🧹 GHOST SWEEPER PROTOCOL
function sweepGhostSessions(sessionsDir) {
    if (!fs.existsSync(sessionsDir)) return;
    const sessions = fs.readdirSync(sessionsDir);
    let nukedCount = 0;

    for (const folder of sessions) {
        const folderPath = path.join(sessionsDir, folder);
        if (!fs.statSync(folderPath).isDirectory()) continue;

        const credsPath = path.join(folderPath, 'creds.json');
        let isCorrupted = false;

        if (!fs.existsSync(credsPath)) {
            isCorrupted = true;
        } else {
            try {
                const fileData = fs.readFileSync(credsPath, 'utf-8');
                if (!fileData || fileData.trim() === '') isCorrupted = true;
                else JSON.parse(fileData);
            } catch (e) { isCorrupted = true; }
        }

        if (isCorrupted) {
            try {
                fs.rmSync(folderPath, { recursive: true, force: true });
                logger.warn(`🗑️ Swept corrupted ghost session: ${folder}`);
                nukedCount++;
            } catch (err) { logger.error(`Failed to delete ghost session ${folder}:`, err); }
        }
    }
    if (nukedCount > 0) logger.success(`🧹 Ghost Sweeper destroyed ${nukedCount} dead session(s).`);
}

async function bootEliteOperator() {
    try {
        console.clear();
        logger.info('🚀 IGNITING PAPPY ULTIMATE ENGINE...');

        // 👈 NEW: Connect to our new MongoDB fortress first!
        await connectDB();

        let tgBot;
        try {
            tgBot = await startTelegram();
            global.tgBot = tgBot;
            logger.success('✅ Telegram Command Center Online');
        } catch (e) { logger.error(`Telegram Dashboard failed to boot: ${e.message}`); }

        global.waSocks = activeSockets || new Map();
        const sessionsDir = path.join(__dirname, 'data/sessions');

        if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
        
        logger.info('🔍 Running pre-flight diagnostics...');
        sweepGhostSessions(sessionsDir);

        const validSessions = fs.readdirSync(sessionsDir).filter(file => fs.statSync(path.join(sessionsDir, file)).isDirectory());

        if (validSessions.length === 0) {
            logger.info('⚠️ No saved sessions found. Use /pair in Telegram to link a bot.');
        } else {
            logger.info(`📁 Found ${validSessions.length} active session(s). Initiating parallel boot lanes...`);

            await Promise.allSettled(validSessions.map(async (sessionFolder, idx) => {
                logger.info(`Booting instance: ${sessionFolder}...`);
                const parts = sessionFolder.split('_');
                const chatId = parts.length >= 2 ? parts[0] : ownerTelegramId;
                const phoneNumber = parts.length >= 2 ? parts[1] : sessionFolder;
                const slotId = parts[2] || '1';

                try {
                    // Small stagger avoids thundering herd while keeping lanes independent.
                    await delay(idx * 250);
                    const waSock = await startWhatsApp(chatId, phoneNumber, slotId, true);

                    if (waSock) {
                        global.waSocks.set(sessionFolder, waSock);
                        // Attach watchdog after connection is open so waSock.user is populated
                        waSock.ev.on('connection.update', ({ connection }) => {
                            if (connection !== 'open') return;
                            const botId = waSock.user?.id?.split(':')[0];
                            if (!botId) return;
                            try {
                                watchdog.attach(botId, waSock, async () => {
                                    logger.error(`[WATCHDOG] Restarting frozen session: ${sessionFolder}`);
                                    try { waSock.ws.close(); } catch(e){}
                                    activeSockets.delete(sessionFolder);
                                    await delay(1500);
                                    await startWhatsApp(chatId, phoneNumber, slotId, true);
                                });
                            } catch(e) { logger.warn(`[WATCHDOG] Attach failed: ${e.message}`); }
                        });
                    }
                } catch (e) {
                    logger.error(`❌ Failed to boot session ${sessionFolder}: ${e.message}`);
                }
            }));
        }
        
        logger.system('✅ SYSTEM FULLY ONLINE AND AWAITING COMMANDS.');

        // Warm up AI model — eliminates cold start lag on first group message
        setTimeout(async () => {
            try {
                const ai = require('./core/ai');
                await ai.generateText('hi', 'warmup', { platform: 'whatsapp' });
                logger.info('[AI] Model warmed up and ready');
            } catch {}
        }, 3000);

    } catch (error) { logger.error(`Critical Boot Failure: ${error.message}`); }
}

bootEliteOperator();
