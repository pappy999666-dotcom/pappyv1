'use strict';
// plugins/pappy-music.js — YouTube music downloader
// Primary: youtubei.js (no yt-dlp, no bot detection issues)
// Fallback: yt-dlp

const fs     = require('fs');
const path   = require('path');
const logger = require('../core/logger');
const { searchYoutube, downloadAudio, getVideoInfo } = require('../core/youtube');

const TEMP_DIR = path.join(__dirname, '../data/temp_media');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── yt-dlp fallback ────────────────────────────────────────────────────────
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

function getYtDlpBase() {
    const envBin = String(process.env.YTDLP_BIN || '').trim();
    if (envBin) return envBin;
    if (fs.existsSync('/usr/local/bin/yt-dlp')) return '/usr/local/bin/yt-dlp';
    return 'yt-dlp';
}

async function ytdlpFallback(query) {
    const safeQuery = String(query || '').replace(/\s+/g, ' ').trim();
    const outPath   = path.join(TEMP_DIR, `music_${Date.now()}.mp3`);
    const cookiesPath = path.join(__dirname, '../data/youtube_cookies.txt');
    const ytDlpBase = getYtDlpBase();
    const cookieArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';

    const cmd = `${ytDlpBase} ${cookieArg} --js-runtimes "node:/usr/bin/node" -x --audio-format mp3 --audio-quality 3 --max-filesize 20m --no-playlist --no-warnings -o "${outPath}" "ytsearch1:${safeQuery}"`;
    await execAsync(cmd, { timeout: 65000 });
    if (!fs.existsSync(outPath)) throw new Error('yt-dlp fallback produced no file');
    return outPath;
}

// ─── Exposed for AI + Telegram bridge ───────────────────────────────────────
async function searchAndDownload(query) {
    // Try youtubei.js first
    try {
        const results = await searchYoutube(query, 1);
        if (!results.length) throw new Error('No results');
        const { buffer } = await downloadAudio(results[0].videoId);
        const outPath = path.join(TEMP_DIR, `music_${Date.now()}.mp3`);
        await fs.promises.writeFile(outPath, buffer);
        return outPath;
    } catch (err) {
        logger.warn(`[Music] youtubei failed (${err.message}), falling back to yt-dlp`);
        return ytdlpFallback(query);
    }
}

async function getTrackInfo(query) {
    try {
        const results = await searchYoutube(query, 1);
        if (!results.length) throw new Error('No results');
        const r = results[0];
        return { title: r.title, uploader: r.uploader, duration: r.duration, thumb: r.thumbnail };
    } catch {
        return { title: query, uploader: 'Unknown', duration: '?', thumb: null };
    }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────
module.exports = {
    category: 'MUSIC',
    commands: [
        { cmd: '.play',   role: 'public' },
        { cmd: '.search', role: 'public' },
    ],

    searchAndDownload,
    getTrackInfo,

    execute: async ({ sock, msg, args, text, user }) => {
        const jid = msg.key.remoteJid;
        const query = args.join(' ');

        if (!query) return sock.sendMessage(jid, { text: '🎵 Usage: .play <song name>' }, { quoted: msg });

        await sock.sendMessage(jid, { text: `🔍 *Searching for:* ${query}\n⏳ Please wait...` }, { quoted: msg });

        try {
            // Search
            const results = await searchYoutube(query, 1);
            if (!results.length) throw new Error('No results found');
            const track = results[0];

            // Download
            let buffer;
            try {
                const dl = await downloadAudio(track.videoId);
                buffer = dl.buffer;
            } catch (err) {
                logger.warn(`[Music] youtubei download failed (${err.message}), using yt-dlp`);
                const outPath = await ytdlpFallback(query);
                buffer = await fs.promises.readFile(outPath);
                fs.unlink(outPath, () => {});
            }

            const isTgBridge = String(msg?.key?.id || '').startsWith('TG_CMD_') || msg?.pushName === 'Telegram';

            await sock.sendMessage(jid, {
                audio:    buffer,
                mimetype: 'audio/mpeg',
                ptt:      false,
                fileName: `${track.title}.mp3`,
                contextInfo: {
                    externalAdReply: {
                        title:                 track.title,
                        body:                  `🎤 ${track.uploader} • ⏱ ${track.duration}`,
                        mediaType:             1,
                        sourceUrl:             'https://t.me/pappylung',
                        thumbnailUrl:          track.thumbnail,
                        renderLargerThumbnail: true,
                        showAdAttribution:     false,
                    }
                }
            }, { quoted: msg });

            if (!isTgBridge && global.tgBot) {
                const { ownerTelegramId } = require('../config');
                global.tgBot.telegram.sendAudio(ownerTelegramId, { source: buffer, filename: `${track.title}.mp3` }, {
                    title:      track.title,
                    performer:  track.uploader,
                    caption:    `🎵 *${track.title}*\n🎤 ${track.uploader}\n⏱ ${track.duration}`,
                    parse_mode: 'Markdown',
                }).catch(() => {});
            }

        } catch (err) {
            logger.error(`[Music] Failed: ${err.message}`);
            await sock.sendMessage(jid, {
                text: `❌ *Could not find or download:* ${query}\n\nTry a more specific search.`
            }, { quoted: msg });
        }
    }
};
