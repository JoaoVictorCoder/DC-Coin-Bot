// billprocessor.js

const {
  createBill,   // importa a função de criar bill
  getBill,
  getUser,
  setCoins,
  addCoins,
  db,
  deleteBill,
  enqueueDM
} = require('./database'); // caminho relativo à raiz do projeto

module.exports = function setupBillProcessor(client) {
  client.on('interactionCreate', async interaction => {
    // processa apenas submits do modal /bill
    if (!interaction.isModalSubmit() || interaction.customId !== 'bill_modal') return;

    // 1) Ack imediato
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Lê e normaliza inputs
    const toIdRaw      = interaction.fields.getTextInputValue('toId').trim();
    const fromIdRaw    = interaction.fields.getTextInputValue('fromId').trim();
    const amountStr    = interaction.fields.getTextInputValue('amount').trim();
    const timeStr      = interaction.fields.getTextInputValue('time').trim();
    const toId   = toIdRaw || interaction.user.id;
    const fromId = fromIdRaw || '';

    // 3) Valida amount
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
      return interaction.editReply('❌ Invalid amount.');
    }

    // 4) Calcula timestamp (mesma lógica do /bill)
    const MS_IN_HOUR = 3600 * 1000;
    const MS_IN_DAY    = 24 * MS_IN_HOUR;
    const NINETY_DAYS  = 90 * MS_IN_DAY;
    const SIX_MONTHS   = 182 * MS_IN_DAY;
    let timestamp = Date.now();
    if (timeStr) {
      const m = timeStr.match(/^(\d+)([dhms])$/);
      if (!m) {
        return interaction.editReply('❌ Invalid time. Use 1d, 2h, 30m or 45s.');
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
      timestamp = (delta <= NINETY_DAYS)
        ? Date.now() - (NINETY_DAYS - delta)
        : Date.now() + (delta - NINETY_DAYS);
    }

    // 5) Cria a bill no DB
    let billId;
    try {
      billId = createBill(fromId, toId, amountStr, timestamp);
    } catch (err) {
      console.warn('⚠️ Error creating bill:', err);
      return interaction.editReply('❌ Could not create bill.');
    }

    // 6) Resposta final
    return interaction.editReply(
      `✅ Bill created: \`\`\`${billId}\`\`\`\nReceiver: \`${toId}\`\nTo charge: \`${fromId}\`\nUse \`!paybill ${billId}\`\nOr use \`/bill\` to pay it.`
    );
  });
};
