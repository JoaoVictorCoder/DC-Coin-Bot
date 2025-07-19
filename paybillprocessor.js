// paybillprocessor.js
const {
  getBill,
  getUser,
  createUser,
  setCoins,
  db,
  deleteBill,
  enqueueDM,
  fromSats
} = require('./database');
const { processDMQueue } = require('./dmQueue');

/**
 * Registers a handler to process /paybill modal submissions.
 * @param {import('discord.js').Client} client
 */
module.exports = function setupPaybillProcessor(client) {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isModalSubmit() || interaction.customId !== 'paybill_modal') return;

    // 1) Acknowledge the modal
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    // 2) Read inputs
    const billId = interaction.fields.getTextInputValue('billId').trim();

    // 3) Fetch the bill
    const bill = getBill(billId);
    if (!bill) {
      return interaction.editReply('❌ Bill not found.');
    }

    const executorId = interaction.user.id;
    const toId       = bill.to_id;
    const fromId     = bill.from_id;

    // 4) Read stored satoshis directly
    const amountSats = Number(bill.amount);
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return interaction.editReply('❌ Invalid bill amount.');
    }

    const selfPay = executorId === toId;

    // 5) If not self-pay, verify balance & perform transfer
    if (!selfPay) {
      const payer = getUser(executorId);
      if (!payer) {
        return interaction.editReply('❌ Your account not found.');
      }
      if (payer.coins < amountSats) {
        return interaction.editReply(
          `💸 Low balance. You need **${fromSats(amountSats)}** coins.`
        );
      }

      let payee = getUser(toId);
      if (!payee) {
        createUser(toId);
        payee = getUser(toId);
      }

      const newPayerBalance = payer.coins - amountSats;
      const newPayeeBalance = payee.coins + amountSats;

      try {
        setCoins(executorId, newPayerBalance);
        setCoins(toId,        newPayeeBalance);
      } catch (err) {
        console.warn('⚠️ Error performing transfer:', err);
        return interaction.editReply('❌ Transfer failed.');
      }
    }

    // 6) Log transaction (best effort)
    const paidAt = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(billId, paidAt, executorId, toId, amountSats);
    } catch (err) {
      console.warn('⚠️ Error logging transaction:', err);
    }

    // 7) Delete the bill
    try {
      deleteBill(billId);
    } catch (err) {
      console.warn('⚠️ Error deleting bill:', err);
    }

    // 8) Notify the recipient
    try {
      enqueueDM(toId, {
        title: '🏦 Bill Paid 🏦',
        description: [
          `Received **${fromSats(amountSats)}** coins`,
          `From: \`${executorId}\``,
          `Bill ID: \`${billId}\``,
          '*Received ✅*'
        ].join('\n'),
        type: 'rich'
      }, { components: [] });
      processDMQueue();
    } catch (err) {
      console.warn('⚠️ Error enqueueing recipient DM:', err);
    }

    // 9) Notify the bill creator if different
    if (fromId && fromId !== executorId) {
      try {
        enqueueDM(fromId, {
          title: '🏦 Your Bill Was Paid 🏦',
          description: [
            `Your bill \`${billId}\` for **${fromSats(amountSats)}** coins`,
            `was paid by: \`${executorId}\``,
            '*Thank you!*'
          ].join('\n'),
          type: 'rich'
        }, { components: [] });
      } catch (err) {
        console.warn('⚠️ Error enqueueing creator DM:', err);
      }
    }

    // 10) Process any remaining DMs
    if (typeof interaction.client.processDMQueue === 'function') {
      interaction.client.processDMQueue();
    }

    // 11) Final reply to executor
    let toTag = 'yourself';
    try {
      toTag = selfPay
        ? 'yourself'
        : (await interaction.client.users.fetch(toId)).tag;
    } catch {}

    return interaction.editReply(
      selfPay
        ? `✅ You canceled your own bill \`${billId}\`.`
        : `✅ Paid **${fromSats(amountSats)}** coins to **${toTag}** (\`${toId}\`).`
    );
  });
};
