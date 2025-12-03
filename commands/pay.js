'use strict';

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getUser,
  toSats,
  fromSats,
  createUser,
  transferAtomic
} = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Sends coins to another user or ID')
    .addNumberOption(opt =>
      opt
        .setName('quantia')
        .setDescription('Amount in coins (decimal)')
        .setRequired(true)
    )
    .addUserOption(opt =>
      opt
        .setName('usuário')
        .setDescription('Destination Discord user')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('userid')
        .setDescription('Destination DB user ID')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      // 1) determine target
      const discordTarget = interaction.options.getUser('usuário');
      const dbTargetId = interaction.options.getString('userid');
      let targetId, targetTag;

      if (discordTarget) {
        targetId = discordTarget.id;
        targetTag = discordTarget.tag;
      } else if (dbTargetId) {
        targetId = dbTargetId;
        const rec = getUser(targetId);
        if (!rec) {
          return interaction.editReply('❌ Unknown user ID.').catch(() => null);
        }
        targetTag = `User(${targetId})`;
      } else {
        return interaction.editReply('❌ You must specify a Discord user or a user ID.').catch(() => null);
      }

      // 2) parse & convert amount to satoshis
      const amountDecimal = interaction.options.getNumber('quantia');
      if (typeof amountDecimal !== 'number' || isNaN(amountDecimal)) {
        return interaction.editReply('❌ Invalid amount specified.').catch(() => null);
      }
      const amountSats = toSats(amountDecimal.toString());
      if (!Number.isInteger(amountSats) || amountSats <= 0) {
        return interaction.editReply('❌ Invalid amount specified.').catch(() => null);
      }

      // 3) prevent self-pay
      if (targetId === interaction.user.id) {
        return interaction.editReply('🚫 Impossible to send to yourself.').catch(() => null);
      }

      // 4) fetch balances (getUser cria se não existir)
      const sender = getUser(interaction.user.id);
      if (!sender) {
        return interaction.editReply('❌ Sender account not found.').catch(() => null);
      }

      // create receiver if not exists
      const receiver = getUser(targetId) || (createUser(targetId), getUser(targetId));

      // 5) quick balance check (helpful UX) — detailed check happens inside transferAtomic
      if (sender.coins < amountSats) {
        return interaction.editReply('💸 Insufficient funds.').catch(() => null);
      }

      // 6) perform atomic transfer via database.js
      let txInfo;
      try {
        txInfo = transferAtomic(interaction.user.id, targetId, amountSats);
        // txInfo = { txId, date }
      } catch (err) {
        console.error('⚠️ transferAtomic error:', err);
        if (/Insufficient funds/i.test(err.message)) {
          return interaction.editReply('💸 Insufficient funds.').catch(() => null);
        }
        return interaction.editReply('❌ Could not complete transfer. Try again later.').catch(() => null);
      }

      // 7) prepare receipt
      const date = txInfo?.date || new Date().toISOString();
      const txId = txInfo?.txId || '(unknown)';
      const tempDir = path.join(__dirname, '..', 'temp');
      const receiptPath = path.join(tempDir, `${interaction.user.id}-${txId}.txt`);
      const displayAmount = fromSats(amountSats);
      const receipt = [
        `Transaction ID: ${txId}`,
        `Date         : ${date}`,
        `From         : ${interaction.user.id}`,
        `To           : ${targetId}`,
        `Amount       : ${displayAmount} coins`
      ].join(os.EOL);

      try {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(receiptPath, receipt, 'utf8');
      } catch (e) {
        console.warn('⚠️ Could not write receipt file:', e);
      }

      // 8) attach receipt if available
      const files = [];
      if (fs.existsSync(receiptPath)) {
        files.push(new AttachmentBuilder(receiptPath, {
          name: `${interaction.user.id}-${txId}.txt`
        }));
      }

      // 9) final reply
      await interaction.editReply({
        content: `✅ Transferred **${displayAmount} coins** to **${targetTag}**. (tx: ${txId})`,
        files
      }).catch(() => null);
    } catch (err) {
      console.error('❌ Error in /pay command:', err);
      try {
        if (!interaction.replied) {
          await interaction.reply({ content: '❌ Internal error processing /pay.', ephemeral: true });
        } else {
          await interaction.editReply('❌ Internal error processing /pay.');
        }
      } catch {}
    } finally {
      // 10) cleanup temp files
      try {
        const tempDir = path.join(__dirname, '..', 'temp');
        fs.readdirSync(tempDir)
          .filter(f => f.startsWith(`${interaction.user.id}-`) && f.endsWith('.txt'))
          .forEach(f => fs.unlinkSync(path.join(tempDir, f)));
      } catch {}
    }
  }
};
