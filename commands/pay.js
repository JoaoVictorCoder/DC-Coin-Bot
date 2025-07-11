// commands/pay.js
'use strict';

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');
const {
  getUser,
  setCoins,
  db
} = require('../database');

// helper para gerar UUID único
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
    .setDescription('Sends coins to another user')
    .addUserOption(opt =>
      opt.setName('usuário')
         .setDescription('Destination')
         .setRequired(true)
    )
    .addNumberOption(opt =>
      opt.setName('quantia')
         .setDescription('Amount')
         .setRequired(true)
    ),

  async execute(interaction) {
    // 0) ack to avoid timeout
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      const target = interaction.options.getUser('usuário');
      // 1) parse & truncate amount to max 8 decimal places
      let amount = interaction.options.getNumber('quantia');
      amount = Math.floor(amount * 1e8) / 1e8;

      // 2) validate
      if (target.id === interaction.user.id) {
        return interaction.editReply('🚫 Impossible to send to yourself.');
      }
      if (isNaN(amount) || amount <= 0) {
        return interaction.editReply('❌ Invalid amount specified.');
      }

      // 3) fetch balances
      const sender   = getUser(interaction.user.id);
      const receiver = getUser(target.id);

      if (!sender || sender.coins < amount) {
        return interaction.editReply('💸 Insufficient funds.');
      }

      // 4) compute new balances with truncation
      const newSenderBalance   = Math.floor((sender.coins - amount) * 1e8) / 1e8;
      const currentReceiver    = receiver ? receiver.coins : 0;
      const newReceiverBalance = Math.floor((currentReceiver + amount) * 1e8) / 1e8;

      // 5) update balances
      setCoins(interaction.user.id, newSenderBalance);
      setCoins(target.id,          newReceiverBalance);

      // 6) record transactions
      const date       = new Date().toISOString();
      const txIdSender   = genUniqueTxId();
      const txIdReceiver = genUniqueTxId();
      const insertStmt = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        insertStmt.run(txIdSender,   date, interaction.user.id, target.id, amount);
        insertStmt.run(txIdReceiver, date, interaction.user.id, target.id, amount);
      } catch (e) {
        console.warn('⚠️ Failed to log transactions:', e);
      }

      // 7) prepare receipt file
      const tempDir      = path.join(__dirname, '..', 'temp');
      const receiptPath  = path.join(tempDir, `${interaction.user.id}-${txIdSender}.txt`);
      const receiptLines = [
        `Transaction ID: ${txIdSender}`,
        `Date         : ${date}`,
        `From         : ${interaction.user.id}`,
        `To           : ${target.id}`,
        `Amount       : ${amount.toFixed(8)} coins`
      ].join(os.EOL);

      try {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(receiptPath, receiptLines, 'utf8');
      } catch (e) {
        console.warn('⚠️ Could not write receipt file:', e);
      }

      // 8) attempt to attach receipt
      let files = [];
      try {
        if (fs.existsSync(receiptPath)) {
          files.push(new AttachmentBuilder(receiptPath, { name: `${interaction.user.id}-${txIdSender}.txt` }));
        }
      } catch (e) {
        console.warn('⚠️ Cannot attach receipt:', e);
      }

      // 9) send final reply
      await interaction.editReply({
        content: `✅ Transferred **${amount.toFixed(8)} coins** to **${target.tag}**.`,
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
      // 10) cleanup temp files
      try {
        const tempDir = path.join(__dirname, '..', 'temp');
        fs.readdirSync(tempDir).forEach(file => {
          if (file.startsWith(`${interaction.user.id}-`) && file.endsWith('.txt')) {
            fs.unlinkSync(path.join(tempDir, file));
          }
        });
      } catch {}
    }
  }
};
