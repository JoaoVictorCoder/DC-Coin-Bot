// commands/check.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { getTransaction } = require('../database');

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
    // Defer para ganhar tempo extra (resposta será epheral)
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

    // Prepara pasta temporária
    const tempDir = path.join(__dirname, '..', 'temp');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      console.warn('⚠️ [/check] Failed to create temp folder:', err);
    }

    // Escreve detalhes da transação em arquivo
    const filePath      = path.join(tempDir, `${txId}.txt`);
    const displayAmount = tx.coins;  // valor já formatado em “coins”
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.fromId}`,
      `To           : ${tx.toId}`,
      `Amount       : ${displayAmount} coins`
    ].join(os.EOL);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.warn('⚠️ [/check] Failed to write transaction file:', err);
    }

    // Cria o attachment, se o arquivo existir
    let attachment;
    if (fs.existsSync(filePath)) {
      try {
        attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      } catch (err) {
        console.warn('⚠️ [/check] Could not create attachment:', err);
      }
    }

    // Monta payload da resposta
    const replyOptions = {
      content: `✅ Transaction (${tx.date}) from \`${tx.fromId}\` to \`${tx.toId}\` for \`${displayAmount}\` coins.`
    };
    if (attachment) replyOptions.files = [attachment];

    // Envia resposta
    try {
      await interaction.editReply(replyOptions);
    } catch (err) {
      console.error('❌ [/check] Failed to send reply:', err);
    }

    // Limpa arquivo temporário
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('⚠️ [/check] Failed to delete temp file:', err);
    }
  },
};
