
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { getTransaction } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check')
    .setDescription('Consulta uma transação pelo ID')
    .addStringOption(opt =>
      opt.setName('txid')
         .setDescription('ID da transação (UUID)')
         .setRequired(true)
    ),

  async execute(interaction) {
    const txId = interaction.options.getString('txid');
    const tx   = getTransaction(txId);

    if (!tx) {
      return interaction.reply({ content: '❌ Unknown transaction.', ephemeral: true });
    }

    // Recria o arquivo de comprovante temporário
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, `${txId}.txt`);

    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.from_id}`,
      `To           : ${tx.to_id}`,
      `Amount       : ${tx.amount.toFixed(8)} coins`
    ].join(os.EOL);

    fs.writeFileSync(filePath, content);

    // Prepara o attachment
    let attachment;
    try {
      attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
    } catch (err) {
      console.warn('⚠️ Sem permissão para anexar comprovante de verificação:', err.message);
    }

    // Envia resposta ephemeral com arquivo
    const replyPayload = {
      content: `✅ Transaction: (${tx.date}) from \`${tx.from_id}\` to \`${tx.to_id}\` of \`${tx.amount.toFixed(8)}\` coins.`,
      ephemeral: true
    };
    if (attachment) replyPayload.files = [attachment];

    await interaction.reply(replyPayload);

    // Remove o arquivo temporário
    try { fs.unlinkSync(filePath); } catch {}
  },
};
