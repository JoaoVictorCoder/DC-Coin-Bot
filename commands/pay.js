'use strict';

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const {
  getUser,
  setCoins,
  db,
  toSats,
  fromSats
} = require('../database');

// helper to generate a unique transaction ID
function genUniqueTxId() {
  let id;
  do {
    id = uuidv4();
  } while (db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id));
  return id;
}

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
          return interaction.editReply('❌ Unknown user ID.');
        }
        targetTag = `User(${targetId})`;
      } else {
        return interaction.editReply('❌ You must specify a Discord user or a user ID.');
      }

      // 2) parse & convert amount to satoshis
      const amountDecimal = interaction.options.getNumber('quantia');
      const amountSats = toSats(amountDecimal.toString());
      if (isNaN(amountSats) || amountSats <= 0) {
        return interaction.editReply('❌ Invalid amount specified.');
      }

      // 3) prevent self-pay
      if (targetId === interaction.user.id) {
        return interaction.editReply('🚫 Impossible to send to yourself.');
      }

      // 4) fetch balances
      const sender = getUser(interaction.user.id);
      const receiver = getUser(targetId) || { coins: 0 };
      if (!sender || sender.coins < amountSats) {
        return interaction.editReply('💸 Insufficient funds.');
      }

      // 5) compute new balances
      const newSenderBalance = sender.coins - amountSats;
      const newReceiverBalance = receiver.coins + amountSats;

      // 6) apply updates
      setCoins(interaction.user.id, newSenderBalance);
      setCoins(targetId, newReceiverBalance);

      // 7) log transactions
      const date = new Date().toISOString();
      const txSender = genUniqueTxId();
      const txReceiver = genUniqueTxId();
      const insert = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        insert.run(txSender, date, interaction.user.id, targetId, amountSats);
        insert.run(txReceiver, date, interaction.user.id, targetId, amountSats);
      } catch (e) {
        console.warn('⚠️ Failed to log transactions:', e);
      }

      // 8) prepare receipt
      const tempDir = path.join(__dirname, '..', 'temp');
      const receiptPath = path.join(tempDir, `${interaction.user.id}-${txSender}.txt`);
      const displayAmount = fromSats(amountSats);
      const receipt = [
        `Transaction ID: ${txSender}`,
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

      // 9) attach receipt if available
      const files = [];
      if (fs.existsSync(receiptPath)) {
        files.push(new AttachmentBuilder(receiptPath, {
          name: `${interaction.user.id}-${txSender}.txt`
        }));
      }

      // 10) final reply
      await interaction.editReply({
        content: `✅ Transferred **${displayAmount} coins** to **${targetTag}**.`,
        files
      });
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
      // 11) cleanup temp files
      try {
        const tempDir = path.join(__dirname, '..', 'temp');
        fs.readdirSync(tempDir)
          .filter(f => f.startsWith(`${interaction.user.id}-`) && f.endsWith('.txt'))
          .forEach(f => fs.unlinkSync(path.join(tempDir, f)));
      } catch {}
    }
  }
};
