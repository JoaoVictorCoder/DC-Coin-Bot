// commands/check.js
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
    // 1) Adia para dar tempo extra (resposta será ephemeral)
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const txId = interaction.options.getString('txid');
    let tx;
    try {
      tx = getTransaction(txId);
    } catch (err) {
      console.error('❌ [/check] Erro ao buscar transação:', err);
      return interaction.editReply('❌ Erro interno ao recuperar a transação.').catch(() => null);
    }

    if (!tx) {
      return interaction.editReply('❌ Transação desconhecida.').catch(() => null);
    }

    // 2) Prepara diretório temporário
    const tempDir = path.join(__dirname, '..', 'temp');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (err) {
      console.warn('⚠️ [/check] Falha ao criar pasta temp:', err);
    }

    // 3) Escreve conteúdo no arquivo
    const filePath = path.join(tempDir, `${txId}.txt`);
    const content = [
      `Transaction ID: ${txId}`,
      `Date         : ${tx.date}`,
      `From         : ${tx.from_id}`,
      `To           : ${tx.to_id}`,
      `Amount       : ${tx.amount.toFixed(8)} coins`
    ].join(os.EOL);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.warn('⚠️ [/check] Falha ao escrever arquivo de transação:', err);
    }

    // 4) Cria attachment, se possível
    let attachment;
    if (fs.existsSync(filePath)) {
      try {
        attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      } catch (err) {
        console.warn('⚠️ [/check] Não foi possível criar o attachment:', err);
      }
    }

    // 5) Prepara payload de resposta
    const replyOptions = {
      content: `✅ Transação: (${tx.date}) de \`${tx.from_id}\` para \`${tx.to_id}\` de \`${tx.amount.toFixed(8)}\` coins.`
    };
    if (attachment) {
      replyOptions.files = [attachment];
    }

    // 6) Envia a resposta
    try {
      await interaction.editReply(replyOptions);
    } catch (err) {
      console.error('❌ [/check] Falha ao enviar resposta:', err);
    }

    // 7) Limpa o arquivo temporário
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('⚠️ [/check] Falha ao remover arquivo temporário:', err);
    }
  },
};
