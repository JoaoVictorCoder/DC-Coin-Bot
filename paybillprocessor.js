// paybillprocessor.js
const {
  getBill,
  getUser,
  createUser,
  setCoins,
  deleteBill,
  enqueueDM,
  fromSats,
  logTransaction // <-- nova função que deve existir em database.js
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

    // 3) Fetch the bill (await in case DB functions are async)
    let bill;
    try {
      bill = await getBill(billId);
    } catch (err) {
      console.warn('⚠️ [/paybill] getBill error:', err);
      return interaction.editReply('❌ Bill lookup failed.');
    }

    if (!bill) {
      return interaction.editReply('❌ Bill not found.');
    }

    const executorId = interaction.user.id;
    const toId       = bill.to_id;
    const fromId     = bill.from_id;

    // 4) Read stored satoshis (normalize)
    const amountSats = Number(bill.amount);
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return interaction.editReply('❌ Invalid bill amount.');
    }

    const selfPay = executorId === toId;

    // 5) If not self-pay, verify balance & perform transfer
    if (!selfPay) {
      let payer;
      try {
        payer = await getUser(executorId);
      } catch (err) {
        console.warn('⚠️ [/paybill] getUser(payer) error:', err);
        return interaction.editReply('❌ Error checking your account.');
      }

      if (!payer) {
        return interaction.editReply('❌ Your account not found.');
      }

      if (payer.coins < amountSats) {
        return interaction.editReply(
          `💸 Low balance. You need **${fromSats(amountSats)}** coins.`
        );
      }

      let payee;
      try {
        payee = await getUser(toId);
        if (!payee) {
          // createUser should insert a user with 0 coins; then we re-fetch
          await createUser(toId);
          payee = await getUser(toId);
        }
      } catch (err) {
        console.warn('⚠️ [/paybill] getUser/createUser(payee) error:', err);
        return interaction.editReply('❌ Error preparing recipient account.');
      }

      const newPayerBalance = payer.coins - amountSats;
      const newPayeeBalance = (payee?.coins || 0) + amountSats;

      try {
        // Use database.js to persist balances
        await setCoins(executorId, newPayerBalance);
        await setCoins(toId, newPayeeBalance);
      } catch (err) {
        console.warn('⚠️ [/paybill] Error performing transfer (setCoins):', err);
        return interaction.editReply('❌ Transfer failed.');
      }
    }

    // 6) Log transaction via database.js (no direct SQL here)
    const paidAt = new Date().toISOString();
    try {
      // logTransaction should insert into transactions table
      await logTransaction(billId, paidAt, executorId, toId, amountSats);
    } catch (err) {
      console.warn('⚠️ [/paybill] Error logging transaction via database.js:', err);
      // continue — this is best-effort
    }

    // 7) Delete the bill (via database.js)
    try {
      await deleteBill(billId);
    } catch (err) {
      console.warn('⚠️ [/paybill] Error deleting bill:', err);
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
      console.warn('⚠️ [/paybill] Error enqueueing recipient DM:', err);
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
        console.warn('⚠️ [/paybill] Error enqueueing creator DM:', err);
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
