// commands/bills.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
// agora usamos apenas database.js para acessar dados
const { getBillsTo, getBillsFrom } = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bills')
    .setDescription('List your bills (ephemeral)')
    .addIntegerOption(opt =>
      opt
        .setName('page')
        .setDescription('Page number (default: 1)')
        .setRequired(false)
    ),

  async execute(interaction) {
    // Defer to avoid timeout (ephemeral)
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    const userId = interaction.user.id;
    const page   = interaction.options.getInteger('page') || 1;

    // Fetch bills to pay and to receive from database.js
    let bills = [];
    try {
      const toPay     = Array.isArray(await getBillsTo(userId, page)) ? await getBillsTo(userId, page) : [];
      const toReceive = Array.isArray(await getBillsFrom(userId, page)) ? await getBillsFrom(userId, page) : [];
      bills = [...toPay, ...toReceive];
    } catch (err) {
      console.error('⚠️ [/bills] Failed to load bills from database.js:', err);
      return interaction.editReply('❌ Bills loading error.').catch(() => null);
    }

    if (!bills || bills.length === 0) {
      return interaction.editReply('ℹ️ You do not have pending bills.').catch(() => null);
    }

    // Prepare temp directory and file
    const tempDir = path.join(__dirname, '..', 'temp');
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (err) { /* ignore */ }

    // Ensure numeric formatting: keep 8 decimal places as original
    const lines = bills.map(b => {
      // normalize fields in case DB returns numbers/strings
      const id     = b.id ?? b.bill_id ?? b.uuid ?? 'unknown';
      const from   = b.from_id ?? b.from ?? 'unknown';
      const to     = b.to_id ?? b.to ?? 'unknown';
      const amount = (typeof b.amount !== 'undefined' && b.amount !== null)
        ? Number(b.amount).toFixed(8)
        : '0.00000000';
      // date fallback
      const date   = b.date ? new Date(b.date).toISOString() : new Date().toISOString();

      return [
        `BILL ID : ${id}`,
        `FROM    : ${from}`,
        `TO      : ${to}`,
        `AMOUNT  : ${amount} coins`,
        `DATE    : ${date}`
      ].join(os.EOL);
    });

    const content  = lines.join(os.EOL + os.EOL);
    const fileName = `${userId}_bills_${page}.txt`;
    const filePath = path.join(tempDir, fileName);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.error('⚠️ [/bills] Failed to create bills file:', err);
    }

    // Build reply with attachment
    const reply = {
      content: `📋 **Your bills (${bills.length}):**\n` +
               bills.map((b, i) => `**${i + 1}.** \`${b.id ?? b.bill_id ?? 'unknown'}\``).join('\n'),
      files: []
    };

    try {
      if (fs.existsSync(filePath)) {
        reply.files.push(new AttachmentBuilder(filePath, { name: fileName }));
      }
    } catch (err) {
      console.warn('⚠️ [/bills] AttachmentBuilder failure:', err);
    }

    await interaction.editReply(reply).catch(() => null);

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch {}
  }
};
