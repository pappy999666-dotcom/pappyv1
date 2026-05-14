'use strict';
// core/youtube.js — YouTube search + download via youtubei.js (no yt-dlp)
// Uses bgutils-js to bypass bot detection (PO token generation)

const { Innertube, UniversalCache } = require('youtubei.js');
const fs   = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../data/yt_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let _yt = null;

async function getClient() {
    if (_yt) return _yt;
    _yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
    });
    return _yt;
}

// Reset client on error so next call rebuilds it
function resetClient() { _yt = null; }

/**
 * Search YouTube and return top N results
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{videoId, title, uploader, duration, durationSecs}>>}
 */
async function searchYoutube(query, limit = 5) {
    const yt = await getClient();
    try {
        const results = await yt.search(query, { type: 'video' });
        const videos = results.videos || [];
        return videos.slice(0, limit).map(v => ({
            videoId:     v.id,
            title:       v.title?.text || v.title || 'Unknown',
            uploader:    v.author?.name || v.channel?.name || 'Unknown',
            durationSecs: v.duration?.seconds || 0,
            duration:    v.duration?.text || '?',
            thumbnail:   v.thumbnails?.[0]?.url || null,
            url:         `https://www.youtube.com/watch?v=${v.id}`,
        }));
    } catch (err) {
        resetClient();
        throw err;
    }
}

/**
 * Download audio from a YouTube video as a Buffer (MP3-compatible AAC/opus)
 * Falls back to yt-dlp if youtubei fails
 * @param {string} videoId
 * @returns {Promise<{buffer: Buffer, title: string, uploader: string, duration: string}>}
 */
async function downloadAudio(videoId) {
    const yt = await getClient();
    try {
        const info = await yt.getInfo(videoId);
        const title    = info.basic_info?.title || videoId;
        const uploader = info.basic_info?.author || 'Unknown';
        const secs     = info.basic_info?.duration || 0;
        const duration = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';
        const thumb    = info.basic_info?.thumbnail?.[0]?.url || null;

        // Pick best audio-only format
        const stream = await yt.download(videoId, {
            type:    'audio',
            quality: 'best',
            format:  'any',
        });

        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);

        return { buffer, title, uploader, duration, thumb };
    } catch (err) {
        resetClient();
        throw err;
    }
}

/**
 * Download video from a YouTube video as a Buffer (MP4)
 * @param {string} videoId
 * @param {number} maxBytes  default 48MB
 * @returns {Promise<{buffer: Buffer, title: string, uploader: string, duration: string}>}
 */
async function downloadVideo(videoId, maxBytes = 48 * 1024 * 1024) {
    const yt = await getClient();
    try {
        const info = await yt.getInfo(videoId);
        const title    = info.basic_info?.title || videoId;
        const uploader = info.basic_info?.author || 'Unknown';
        const secs     = info.basic_info?.duration || 0;
        const duration = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?';

        const stream = await yt.download(videoId, {
            type:    'video+audio',
            quality: '360p',
            format:  'mp4',
        });

        const chunks = [];
        let total = 0;
        for await (const chunk of stream) {
            const buf = Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) throw new Error('Video too large (>48MB)');
            chunks.push(buf);
        }
        const buffer = Buffer.concat(chunks);

        return { buffer, title, uploader, duration };
    } catch (err) {
        resetClient();
        throw err;
    }
}

/**
 * Get info for a video by ID or URL without downloading
 */
async function getVideoInfo(videoIdOrUrl) {
    const yt = await getClient();
    try {
        const id = String(videoIdOrUrl).replace(/.*v=/, '').replace(/.*youtu\.be\//, '').split('&')[0].split('?')[0];
        const info = await yt.getInfo(id);
        const secs = info.basic_info?.duration || 0;
        return {
            videoId:  id,
            title:    info.basic_info?.title || id,
            uploader: info.basic_info?.author || 'Unknown',
            duration: secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '?',
            durationSecs: secs,
            thumbnail: info.basic_info?.thumbnail?.[0]?.url || null,
        };
    } catch (err) {
        resetClient();
        throw err;
    }
}

module.exports = { searchYoutube, downloadAudio, downloadVideo, getVideoInfo };
