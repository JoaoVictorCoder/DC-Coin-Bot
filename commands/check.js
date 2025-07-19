// commands/check.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { getTransaction, fromSats } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check a transaction by ID')
    .addStringOption(opt =>
      opt.setName('txid')
         .setDescription('Transaction ID (UUID)')
         .setRequired(true)
    ),

  async execute(interaction) {
    // Defer to gain extra time (response will be ephemeral)
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const txId = interaction.options.getString('txid');
    let tx;
    try {
      tx = getTransaction(txId);
    } catch (err) {
      console.error('❌ [/check] Error fetching transaction:', err);
      return interaction.editReply('❌ Internal error retrieving the transaction.').catch(() => null);
    }

    if (!tx) {
      return interaction.editReply('❌ Unknown transaction.').catch(() => null);
    }

    // Prepare temp directory
    const tempDir = path.join(__dirname, '..', 'temp');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      console.warn('⚠️ [/check] Failed to create temp folder:', err);
    }

    // Write transaction details to file
    const filePath = path.join(tempDir, `${txId}.txt`);
    const displayAmount = fromSats(tx.amount);
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.from_id}`,
      `To           : ${tx.to_id}`,
      `Amount       : ${displayAmount} coins`
    ].join(os.EOL);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.warn('⚠️ [/check] Failed to write transaction file:', err);
    }

    // Create attachment if file exists
    let attachment;
    if (fs.existsSync(filePath)) {
      try {
        attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      } catch (err) {
        console.warn('⚠️ [/check] Could not create attachment:', err);
      }
    }

    // Prepare reply payload
    const replyOptions = {
      content: `✅ Transaction (${tx.date}) from \`${tx.from_id}\` to \`${tx.to_id}\` for \`${displayAmount}\` coins.`
    };
    if (attachment) {
      replyOptions.files = [attachment];
    }

    // Send the response
    try {
      await interaction.editReply(replyOptions);
    } catch (err) {
      console.error('❌ [/check] Failed to send reply:', err);
    }

    // Clean up temp file
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('⚠️ [/check] Failed to delete temp file:', err);
    }
  },
};
