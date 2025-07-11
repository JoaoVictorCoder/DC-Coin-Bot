// paybillprocessor.js

const {
  getBill,
  getUser,
  createUser,
  setCoins,
  db,
  deleteBill,
  enqueueDM
} = require('./database');

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

    let bill;
    try {
      bill = getBill(billId);
    } catch (err) {
      console.warn('⚠️ Error fetching bill:', err);
    }
    if (!bill) {
      return interaction.editReply('❌ Bill not found.');
    }

    const executorId = interaction.user.id;
    const toId       = bill.to_id;
    const fromId     = bill.from_id;

    // 3) Parse and truncate amount to 8 decimal places
    let amount = parseFloat(bill.amount);
    amount = Math.floor(amount * 1e8) / 1e8;
    if (isNaN(amount) || amount <= 0) {
      return interaction.editReply('❌ Invalid bill amount.');
    }

    const selfPay = executorId === toId;

    // 4) If not self-pay, verify balance & perform transfer
    if (!selfPay) {
      let payer;
      try {
        payer = getUser(executorId);
      } catch {
        payer = null;
      }
      if (!payer) {
        return interaction.editReply('❌ Your account not found.');
      }
      if (payer.coins < amount) {
        return interaction.editReply(`💸 Low balance. You need **${amount.toFixed(8)}** coins.`);
      }

      let payee;
      try {
        payee = getUser(toId);
      } catch {
        payee = null;
      }
      if (!payee) {
        try {
          createUser(toId);
          payee = getUser(toId);
        } catch (err) {
          console.warn('⚠️ Error creating payee:', err);
          return interaction.editReply('❌ Could not create recipient account.');
        }
      }

      // compute new balances and truncate
      const newPayerBalance = Math.floor((payer.coins - amount) * 1e8) / 1e8;
      const newPayeeBalance = Math.floor((payee.coins + amount) * 1e8) / 1e8;

      try {
        setCoins(executorId, newPayerBalance);
        setCoins(toId,        newPayeeBalance);
      } catch (err) {
        console.warn('⚠️ Error performing transfer:', err);
        return interaction.editReply('❌ Transfer failed.');
      }
    }

    // 5) Log transaction with truncated amount
    const paidAt = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?,?,?,?,?)
      `).run(billId, paidAt, executorId, toId, amount);
    } catch (err) {
      console.warn('⚠️ Error logging transaction:', err);
    }

    // 6) Delete the bill
    try {
      deleteBill(billId);
    } catch (err) {
      console.warn('⚠️ Error deleting bill:', err);
    }

    // 7) Enqueue DM for recipient (toId)
    try {
      enqueueDM(toId, {
        title: '🏦 Bill Paid 🏦',
        description: [
          `Received **${amount.toFixed(8)}** coins`,
          `From: \`${executorId}\``,
          `Bill ID: \`${billId}\``,
          '*Received ✅*'
        ].join('\n'),
        type: 'rich'
      }, { components: [] });
    } catch (err) {
      console.warn('⚠️ Error enqueueing recipient DM:', err);
    }

    // 8) Enqueue DM for bill creator (fromId) if exists and different
    if (fromId && fromId !== executorId) {
      try {
        enqueueDM(fromId, {
          title: '🏦 Your Bill Was Paid 🏦',
          description: [
            `Your bill \`${billId}\` for **${amount.toFixed(8)}** coins`,
            `was paid by: \`${executorId}\``,
            '*Thank you!*'
          ].join('\n'),
          type: 'rich'
        }, { components: [] });
      } catch (err) {
        console.warn('⚠️ Error enqueueing creator DM:', err);
      }
    }

    // 9) Process DM queue
    if (typeof interaction.client.processDMQueue === 'function') {
      interaction.client.processDMQueue();
    }

    // 10) Final reply
    let toTag = 'yourself';
    try {
      toTag = selfPay
        ? 'yourself'
        : (await interaction.client.users.fetch(toId)).tag;
    } catch {}
    return interaction.editReply(
      selfPay
        ? `✅ You canceled your own bill \`${billId}\`.`
        : `✅ Paid **${amount.toFixed(8)}** coins to **${toTag}** (\`${toId}\`).`
    );
  });
};
