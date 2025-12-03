// billprocessor.js
const {
  createBill
} = require('./database'); // path relative to project root
const { toSats, fromSats } = require('./database');

module.exports = function setupBillProcessor(client) {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit() || interaction.customId !== 'bill_modal') return;

    // 1) Acknowledge immediately
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Read and normalize inputs
    const toIdRaw   = interaction.fields.getTextInputValue('toId').trim();
    const fromIdRaw = interaction.fields.getTextInputValue('fromId').trim();
    const amountStr = interaction.fields.getTextInputValue('amount').trim();
    const timeStr   = interaction.fields.getTextInputValue('time').trim();

    // default receiver is the user who opened the modal
    const toId   = toIdRaw || interaction.user.id;
    // IMPORTANT: default payer is also the user who opened the modal (prevents FK errors)
    const fromId = fromIdRaw || interaction.user.id;

    // 3) Validate amount format
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
      return interaction.editReply('❌ Invalid amount format.');
    }
    const amountDecimal = parseFloat(amountStr);
    if (isNaN(amountDecimal) || amountDecimal <= 0) {
      return interaction.editReply('❌ Invalid amount value.');
    }

    // 4) Convert decimal to integer satoshis
    const amountSats = toSats(amountStr);

    // 5) Calculate expiration timestamp
    const MS_IN_HOUR   = 3600 * 1000;
    const MS_IN_DAY    = 24 * MS_IN_HOUR;
    const NINETY_DAYS  = 90 * MS_IN_DAY;
    const SIX_MONTHS   = 182 * MS_IN_DAY;
    let timestamp = Date.now();
    if (timeStr) {
      const m = timeStr.match(/^(\d+)([dhms])$/);
      if (!m) {
        return interaction.editReply('❌ Invalid time. Use e.g. 1d, 2h, 30m, or 45s.');
      }
      const val = parseInt(m[1], 10);
      let delta;
      switch (m[2]) {
        case 'd': delta = val * MS_IN_DAY;  break;
        case 'h': delta = val * MS_IN_HOUR; break;
        case 'm': delta = val * 60 * 1000;  break;
        case 's': delta = val * 1000;       break;
      }
      if (delta < MS_IN_HOUR) delta = MS_IN_HOUR;
      if (delta > SIX_MONTHS) delta = SIX_MONTHS;
      timestamp = delta <= NINETY_DAYS
        ? Date.now() - (NINETY_DAYS - delta)
        : Date.now() + (delta - NINETY_DAYS);
    }

    // 6) Create the bill in DB using integer satoshis
    let billId;
    try {
      // await here is safe whether createBill is sync or async
      billId = await createBill(fromId, toId, amountSats, timestamp);
    } catch (err) {
      console.warn('⚠️ Error creating bill:', err);
      return interaction.editReply('❌ Could not create bill.');
    }

    // 7) Final response with human-readable amount
    return interaction.editReply(
      `✅ Bill created: \`\`\`${billId}\`\`\`\n` +
      `• Amount: **${fromSats(amountSats)}** coins\n` +
      `• Receiver: \`${toId}\`\n` +
      `• Payer:    \`${fromId}\`\n\n` +
      `Use \`/paybill ${billId}\` to pay it.`
    );
  });
};
