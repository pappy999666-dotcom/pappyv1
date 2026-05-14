"use strict";
// commands/admin/sudo.command.js — WhatsApp sudo/owner management panel

module.exports = {
    name: "sudo",
    requiredRole: "SUDO",

    async handler({ ctx, args, deps }) {
        const { ownerManager, rbac } = deps;
        const sub = (args[0] || "").toLowerCase();
        const actorId = String(ctx.from?.id || '');
        const actorRole = rbac.getUserRole(actorId);

        if (sub === "add" || sub === "remove") {
            if (actorRole !== 'OWNER') {
                return ctx.reply('⚠️ Only OWNER can modify sudo users.', { parse_mode: 'HTML' });
            }
        }

        if (sub === "add") {
            const jid = args[1]?.replace(/[^0-9]/g, "");
            if (!jid) return ctx.reply("❌ Usage: /sudo add 2348012345678");
            const num = `${jid}@s.whatsapp.net`;
            await ownerManager.addSudo(num);
            return ctx.reply(`✅ <b>Added sudo:</b> <code>${num}</code>`, { parse_mode: "HTML" });
        }

        if (sub === "remove") {
            const jid = args[1]?.replace(/[^0-9]/g, "");
            if (!jid) return ctx.reply("❌ Usage: /sudo remove 2348012345678");
            const num = `${jid}@s.whatsapp.net`;
            await ownerManager.removeSudo(num);
            return ctx.reply(`✅ <b>Removed sudo:</b> <code>${num}</code>`, { parse_mode: "HTML" });
        }

        // Default: list
        const owners = ownerManager.getOwners();
        const sudos  = ownerManager.getSudos();
        const ownerList = owners.length ? owners.map(j => `<code>${j}</code>`).join("\n") : "None";
        const sudoList  = sudos.length  ? sudos.map(j  => `<code>${j}</code>`).join("\n") : "None";
        return ctx.reply(
            `👑 <b>OWNER & SUDO LIST</b>\n\n🔑 <b>Owners:</b>\n${ownerList}\n\n🛡️ <b>Sudo Users:</b>\n${sudoList}`,
            { parse_mode: "HTML" }
        );
    },

    register(bot, deps) {
        const { ownerManager, rbac } = deps;

        function renderSudoPanel(owners, sudos, canManage) {
            const ownerList = owners.length ? owners.map(j => `<code>${j}</code>`).join("\n") : "None";
            const sudoList  = sudos.length  ? sudos.map(j  => `<code>${j}</code>`).join("\n") : "None";
            const inline_keyboard = [];
            if (canManage) {
                inline_keyboard.push([{ text: "➕ Add Sudo", callback_data: "sudo_add" }, { text: "➖ Remove Sudo", callback_data: "sudo_remove" }]);
            }
            inline_keyboard.push([{ text: "🔙 Back to Hub", callback_data: "menu_main" }]);

            return {
                text: `👑 <b>OWNER & SUDO MANAGEMENT</b>\n\n🔑 <b>Owners:</b>\n${ownerList}\n\n🛡️ <b>Sudo Users:</b>\n${sudoList}${canManage ? '' : '\n\n<i>Read-only view for SUDO users.</i>'}`,
                reply_markup: { inline_keyboard }
            };
        }

        bot.action("menu_sudo", async (ctx) => {
            ctx.answerCbQuery();
            const role = rbac.getUserRole(String(ctx.from?.id || ''));
            const { text, reply_markup } = renderSudoPanel(ownerManager.getOwners(), ownerManager.getSudos(), role === 'OWNER');
            ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
        });

        bot.action("sudo_add", (ctx) => {
            ctx.answerCbQuery();
            ctx.session = ctx.session || {};
            ctx.session.sudoAction = "add";
            ctx.editMessageText(
                "🛡️ <b>ADD SUDO</b>\n\nSend the WhatsApp number to add as sudo:\n<i>Example: 2348012345678</i>",
                { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "menu_sudo" }]] } }
            ).catch(() => {});
        });

        bot.action("sudo_remove", async (ctx) => {
            ctx.answerCbQuery();
            const sudos = ownerManager.getSudos();
            if (sudos.length === 0) return ctx.editMessageText("⚠️ No sudo users to remove.", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "menu_sudo" }]] }
            }).catch(() => {});
            const buttons = sudos.map(j => [{ text: `🗑️ ${j}`, callback_data: `sudo_rm_${j}` }]);
            buttons.push([{ text: "🔙 Cancel", callback_data: "menu_sudo" }]);
            ctx.editMessageText("🛡️ <b>REMOVE SUDO</b>\n\nSelect a user to remove:", {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: buttons }
            }).catch(() => {});
        });

        bot.action(/^sudo_rm_(.+)$/, async (ctx) => {
            const jid = ctx.match[1];
            await ownerManager.removeSudo(jid);
            ctx.answerCbQuery(`Removed ${jid}`);
            const { text, reply_markup } = renderSudoPanel(ownerManager.getOwners(), ownerManager.getSudos(), true);
            ctx.editMessageText(`✅ Removed.\n\n${text.split("\n\n").slice(1).join("\n\n")}`, {
                parse_mode: "HTML", reply_markup
            }).catch(() => {});
        });
    },
};
