'use strict';

const logger = require('./logger');
const runtimeFlags = require('./runtimeFlags');
const { buildLinkPreview, extractUrls } = require('./linkPreview');

function normalizeOutgoingText(text) {
    return String(text || '').replace(/\u0000/g, '').trim();
}

async function sendPremiumText(sock, jid, text, opts = {}) {
    const safeText = normalizeOutgoingText(text);
    if (!safeText) return null;

    const sendOptions = opts.sendOptions || {};
    const quoted = opts.quoted;
    const hasLink = extractUrls(safeText).length > 0;

    if (runtimeFlags.premiumResponseEngine && runtimeFlags.preserveLinkMetadata && hasLink) {
        try {
            const preview = await buildLinkPreview(safeText, false).catch(() => null);
            if (preview?.externalAdReply) {
                preview.externalAdReply.renderLargerThumbnail = true;
            }

            if (preview) {
                return await sock.sendMessage(
                    jid,
                    { text: safeText, contextInfo: preview },
                    quoted ? { ...sendOptions, quoted } : sendOptions
                );
            }
        } catch (err) {
            logger.warn('[ResponseEngine] Link-preview route failed, using plain send', { error: err.message });
        }
    }

    return await sock.sendMessage(
        jid,
        { text: safeText },
        quoted ? { ...sendOptions, quoted } : sendOptions
    );
}

module.exports = {
    sendPremiumText,
    normalizeOutgoingText,
};
