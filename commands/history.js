
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { db, getUser } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('See the transaction history')
    .addStringOption(opt =>
      opt.setName('user_id')
         .setDescription('User ID (default: YOU)')
         .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('page')
         .setDescription('History page (100 transactions each one)')
         .setRequired(false)
    ),

  async execute(interaction) {
    // Defer para extender tempo de resposta (ephemeral)
    await interaction.deferReply({ flags: 64 });

    // Parâmetros
    const requestedId = interaction.options.getString('user_id') || interaction.user.id;
    let page = interaction.options.getInteger('page') || 1;

    // Verifica existência do usuário no DB
    const userRow = getUser(requestedId);
    if (!userRow) {
      return interaction.editReply({ content: '❌Unknown User❌', flags: 64 });
    }

    // Conta total de transações (enviadas ou recebidas)
    const countStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = ? OR to_id = ?`
    );
    const { cnt: totalCount } = countStmt.get(requestedId, requestedId);

    // Define paginação
    const perPage = 100;
    const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
    if (page > maxPage) page = maxPage;

    // Busca username (ou 'unknown')
    let name;
    try {
      const userObj = await interaction.client.users.fetch(requestedId);
      name = userObj.username;
    } catch {
      name = 'unknown';
    }

    // Monta cabeçalho
    const header = [];
    if (interaction.options.getInteger('page') > maxPage) {
      header.push(`⚠️📖 Showing latest page: ${maxPage}`);
    }
    header.push(`🔄User: ${name} (${requestedId})`);
    header.push(`⏱️Transactions: ${totalCount}`);
    header.push(`💸Balance: ${userRow.coins.toFixed(8)} coins`);
    header.push(`📖Page: ${page}`);

    // Se não houver transações
    if (totalCount === 0) {
      return interaction.editReply({
        content: header.concat('⚠️No Transactions⚠️').join('\n'),
        flags: 64
      });
    }

    // Busca transações da página
    const offset = (page - 1) * perPage;
    const txStmt = db.prepare(
      `SELECT * FROM transactions
       WHERE from_id = ? OR to_id = ?
       ORDER BY date DESC
       LIMIT ? OFFSET ?`
    );
    const transactions = txStmt.all(requestedId, requestedId, perPage, offset);

    // Monta conteúdo do TXT
    const blocks = transactions.map(tx => [
      `UUID:    ${tx.id}`,
      `AMOUNT:  ${tx.amount.toFixed(8)} coins`,
      `FROM:    ${tx.from_id}`,
      `TO:      ${tx.to_id}`,
      `Date:    ${tx.date}`
    ].join(os.EOL));
    const content = blocks.join(os.EOL + os.EOL);

    // Grava arquivo temporário
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const fileName = `${requestedId}_history_${page}.txt`;
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, content);

    // Prepara attachment
    let files;
    try {
      const attachment = new AttachmentBuilder(filePath, { name: fileName });
      files = [attachment];
    } catch {
      files = null;
    }

    // Envia resposta final
    try {
      const replyPayload = { content: header.join('\n'), flags: 64 };
      if (files) replyPayload.files = files;
      else replyPayload.content += `\n⚠️Can't send the transaction history report. Try in my DM <@${interaction.client.user.id}>⚠️`;

      await interaction.editReply(replyPayload);
    } catch (err) {
      console.error(`❌Can't send messages in the channel: ${interaction.channelId} of ${interaction.guild?.name || 'DM'} (${interaction.guildId})`);
    } finally {
      // Remove o arquivo
      try { fs.unlinkSync(filePath); } catch {}
    }
  },
};
