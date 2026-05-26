'use strict';
// core/telegram/forwardedLinkExtractor.js
// Captures WhatsApp group links from Telegram forwarded messages and
// routes them through the validator pipeline correctly.
//
// FLOW:
//   Forwarded text → extract codes → addNewCode (INTAKE) → validator promotes to ACTIVE_JOINABLE
//
// RULES:
//   - Every code goes through addNewCode — enforces global dedup
//   - No direct validateAndAssign calls — that bypasses the pipeline
//   - No saving to Intel cache directly — validator DB is the single source of truth

const logger = require('../logger');
const { addNewCode, getValidatorEntry, STATUS } = require('../linkValidator');

const INVITE_CODE_RE = /^[0-9A-Za-z]{20,24}$/;

// Extract all WhatsApp invite codes from any text
function extractWhatsAppCodes(text) {
    const str = String(text || '');
    const codes = new Set();

    // Full URLs: https://chat.whatsapp.com/CODE
    const urlRe = /chat\.whatsapp\.com\/([A-Za-z0-9]{20,24})/gi;
    let m;
    while ((m = urlRe.exec(str)) !== null) codes.add(m[1]);

    // wa.me invite links
    const waRe = /wa\.me\/invite\/([A-Za-z0-9]{20,24})/gi;
    while ((m = waRe.exec(str)) !== null) codes.add(m[1]);

    // Bare codes on their own line or after whitespace
    const bareRe = /(?:^|[\s,|])([A-Za-z0-9]{20,24})(?:$|[\s,|])/gm;
    while ((m = bareRe.exec(str)) !== null) {
        if (INVITE_CODE_RE.test(m[1])) codes.add(m[1]);
    }

    return Array.from(codes);
}

/**
 * Process forwarded message links — routes through the INTAKE pipeline.
 * Returns { extracted, added, duplicate, invalid }
 */
async function processForwardedLinks(text, meta = {}) {
    const codes = extractWhatsAppCodes(text);
    const result = { extracted: codes.length, added: 0, duplicate: 0, invalid: 0 };

    for (const code of codes.slice(0, 50)) { // safety cap
        const outcome = addNewCode(code, {
            source: meta.source || 'telegram_forward',
            addedAt: Date.now(),
            addedBy: meta.userId || null,
        });
        if (outcome === 'added')     result.added++;
        else if (outcome === 'duplicate') result.duplicate++;
        else                              result.invalid++;
    }

    if (result.added > 0) {
        logger.info(`[ForwardedLinks] +${result.added} new codes → INTAKE (${result.duplicate} dupes, ${result.invalid} invalid)`);
    }

    return result;
}

/**
 * Format the result message for Telegram reply
 */
function formatResultMessage(result) {
    if (result.extracted === 0) {
        return '🔍 <b>No WhatsApp links found</b> in that message.';
    }

    const lines = [
        `📥 <b>LINKS CAPTURED</b>`,
        ``,
        `🔍 Found: <b>${result.extracted}</b>`,
        `✅ Added to intake: <b>${result.added}</b>`,
        `♻️ Already known: <b>${result.duplicate}</b>`,
        `❌ Invalid format: <b>${result.invalid}</b>`,
    ];

    if (result.added > 0) {
        lines.push(``);
        lines.push(`<i>Links are queued for validation. Once confirmed alive they enter the join pool.</i>`);
    } else if (result.duplicate === result.extracted) {
        lines.push(``);
        lines.push(`<i>All links already in the system.</i>`);
    }

    return lines.join('\n');
}

module.exports = { extractWhatsAppCodes, processForwardedLinks, formatResultMessage };
