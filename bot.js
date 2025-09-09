
process.on('uncaughtException', err => {
  console.error('❌ Uncaught Exception:', err);
  // opcional: reiniciar o processo ou notificar admin
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // opcional: logar em serviço externo
});


const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, AttachmentBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logic = require('./logic');
const database = require('./database.js');
const {
  getUser, setCoins, addCoins, db, getBill, deleteBill, createUser,
  setCooldown, getCooldown, setNotified, wasNotified, toSats, fromSats,
  getAllUsers, getServerApiChannel, getCardOwner, genUniqueBillId,
  getCardOwnerByHash, createTransaction, getTransaction,
  genUniqueTxId, enqueueDM, getNextDM, deleteDM, createBill
} = require('./database');

require('dotenv').config();

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN, !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});


const { setupCommands } = require('./commands');

setupCommands(client, TOKEN, CLIENT_ID);

const setupBillProcessor = require('./billprocessor');
const setupPaybillProcessor = require('./paybillprocessor');
const dmQueue = require('./dmQueue');
dmQueue.init(client);

setupBillProcessor(client);
setupPaybillProcessor(client);

const MS_IN_HOUR    = 3600 * 1000;
const MS_IN_DAY     = 24 * MS_IN_HOUR;
const NINETY_DAYS   = 90 * MS_IN_DAY;
const SIX_MONTHS    = 182 * MS_IN_DAY; // aprox. 6 meses


async function safeReply(ctx, options) {
  try {
    if (ctx.reply) {
      // Message or Interaction
      return await ctx.reply(options);
    } else if (ctx.channel && ctx.channel.send) {
      return await ctx.channel.send(options);
    }
  } catch (err) {
    console.error(`❌ No permission to reply:`, err);
    // only user feedback on non‐DMs (interactions & messages)
    if (ctx.reply || ctx.channel) {
      try { 
        if (ctx.reply) await ctx.reply({ content: '❌ No permission to do that.', ephemeral: true }); 
        else await ctx.channel.send('❌ No permission.');
      } catch {} 
    }
  }
}

async function safeShowModal(interaction, modalData) {
  try {
    return await interaction.showModal(modalData);
  } catch (err) {
    console.error('❌ No permission to open modal:', err);
    await safeReply(interaction, { content: '❌ No permission to open modal.', ephemeral: true });
  }
}

async function safeDefer(interaction, options) {
  try {
    return await interaction.deferReply(options);
  } catch (err) {
    console.warn(`⚠️ Impossible interaction:`, err);
  }
}

client.on('interactionCreate', async interaction => {
  // 1️⃣ só pros slash-commands (/)
  if (!interaction.isChatInputCommand()) return;

  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;          // comando não existe na Collection
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`Execution error /${interaction.commandName}`, err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Command execution error.', ephemeral: true });
    }
  }
});

const configFilePath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configFilePath)) {
  fs.writeFileSync(configFilePath, JSON.stringify({}, null, 2), 'utf8');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFilePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('⚠️ Falha ao ler config.json:', err);
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('⚠️ Failure while writing config.json:', err);
    return false;
  }
}

function parseTempo(str) {
  const match = str.match(/(\d+)([dhm])/);
  if (!match) return 86400000;
  const valor = parseInt(match[1]);
  switch (match[2]) {
    case 'd': return valor * 86400000;
    case 'h': return valor * 3600000;
    case 'm': return valor * 60000;
    default: return 86400000;
  }
}



client.once('ready', () => {
  console.log(`✅ Bot started as ${client.user.tag}`);

  // Re-registrar membros a cada 30 minutos
  setInterval(registerAllMembers, 30 * 60 * 1000);
});

client.on('error', error => {
  console.error('⚠️ Discord client error:', error);
});
client.on('shardError', error => {
  console.error('⚠️ WebSocket connection error:', error);
});

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });


client.on('guildCreate', async (guild) => {
  try {
    const owner = await guild.fetchOwner();

    const mensagem = `
> # **Thanks for contributing with this bot!**
> 
> ⚠️ Be sure that the bot has the right permission to view the channel and send messages & embeds.
> 
> All the commands is better with /commands (but !command works)
> 
> 📘 **List of avaliable commands:**
> 
> - \`!global\` - shows the economy information.
> - \`!help\` - shows you the help menu.
> - \`/ajuda\` - shows you the help menu in portuguese.
> - \`!user\` - changes your account info.
> - \`!rank\` — shows the rank of the 25 most rich people.
> - \`!pay @user ammount\` — example: \`!pay @user 0.01\` to send money.
> - \`!bal\` — checks your current balance.
> - \`!bill\` - creates a bill ID to be charged.
> - \`!bills\` - shows a list of all your bills.
> - \`!paybill\` - pays a bill ID to send money.
> - \`!active\` - API usage only.
> - \`!check\` — checks the ID of a transaction.
> - \`!history\` — checks your or others transaction history.
> - \`!card\` — generates a debit card to use in the payment api in other bots.
> - \`!cardreset\` — resets and gives you another card to keep it safe.
> - \`!restore\` — restores your wallet backup.
> - \`!backup\` — creates a wallet backup to restores your coins even if this account got deleted.
> - \`!view @user\` — example: \`!view @user\` to see another user's balance.
> - \`!api channel_ID\` — example: \`!api 1324535042843869300\` to create an API channel for the bot.
> - \`!set channel_ID\` — example: \`!set 1387471903832281219\` to create a ATM and rewards channel.
> 
> 💛 Help this project with bitcoins donation. Any help is welcome:
> \`\`\` bc1qs9fd9fnngn9svkw8vv5npd7fn504tqx40kuh00 \`\`\`
> 
> 🌌 [> COIN BANK WEBSITE <](http://coin.foxsrv.net:1033/site/index.html)
> 
> 💬 [> Oficial Support <](https://discord.gg/C5cAfhcdRp)
> 
> 🏦 [> Add the bot in more servers <](https://discord.com/oauth2/authorize?client_id=1391067775077978214&permissions=1126864127511616&integration_type=0&scope=bot)
> 
> Bot Creators: MinyBaby e FoxOficial.
  `;

    // Enfileira a mensagem para o dono do servidor via DM
    try {
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setDescription(mensagem);

      enqueueDM(owner.id, embed.toJSON(), { components: [] });
    } catch {
      console.log(`❌ Could not enqueue DM for the server owner of ${guild.name}`);
    }
  } catch (err) {
    console.error(`Error while handling guildCreate for ${guild.id}:`, err);
  }
});

client.on('messageCreate', async (message) => {
  const args = message.content.trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

if (cmd === '!bal') {
  try {
    // importa helpers no handler
    const { getUser, fromSats } = require('./database');
    const user = getUser(message.author.id);

    // formata coins (INTEGER satoshis → string "66.00000000")
    const balance = fromSats(user.coins);

    return await message.reply(`> 💰 Balance: ${balance} coins.`);
  } catch (err) {
    console.error('❌ Error in !bal handler:', err);
    // fallback silencioso
    try {
      await message.reply('❌ Falha ao carregar o saldo.');
    } catch {
      // nada a fazer se nem isso funcionar
    }
  }
}



if (cmd === '!view') {
  try {
    // importa helper de formatação
    const { fromSats } = require('./database');

    // 1) Tenta obter o usuário por menção ou ID
    let target = message.mentions.users.first();
    if (!target && args[0]) {
      try {
        target = await client.users.fetch(args[0]);
      } catch (err) {
        console.error('❌ Error fetching user in !view:', err);
        return await message.reply('❌ Unknown User.');
      }
    }
    if (!target) {
      return await message.reply('❌ Correct usage: `!view @user` or `!view user_id`');
    }

    // 2) Busca os dados no banco com tratamento de erro
    let record;
    try {
      record = getUser(target.id);
    } catch (err) {
      console.error('⚠️ Error fetching user record in !view:', err);
      return await message.reply('❌ Failed to retrieve user data.');
    }

    // 3) Prepara e envia o embed
    const embed = new EmbedBuilder()
      .setColor('Green')
      .setTitle(`💼 Saldo de ${target.tag}`)
      .setDescription(`💰 **${fromSats(record.coins)} coins**`);

    await message.reply({ embeds: [embed] });

  } catch (err) {
    console.error('❌ Unexpected error in !view command:', err);
    // já tentou responder, não faz mais nada
  }
}


 // api de transações
  const guildId = message.guild?.id;

  // === bloco API ===
  // só roda se for dentro de um servidor que já tenha definido um canal “API”
if (cmd === '!active' && args.length >= 3) {
  const [ hash, targetId, valorStr ] = args;
  const guild      = message.guild;
  const apiChannel = message.channel;
  const botMember  = guild?.members.cache.get(client.user.id);
  const { toSats, getUser, createUser } = require('./database');
  const { getCardOwnerByHash } = require('./logic');

  // 0) Checa permissão de envio
  if (guild && !apiChannel.permissionsFor(botMember).has('SendMessages')) {
    console.warn(`❌ No permission to use API channel at: ${guild.name} (${guild.id})`);
    return;
  }

  // 1) valida hash
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    try {
      await apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.error('⚠️ Error sending failure response:', err);
    }
    return;
  }

  // 2) valida valor (até 8 casas) e converte para satoshis
  if (!/^\d+(\.\d{1,8})?$/.test(valorStr)) {
    try {
      await apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.error('⚠️ Error sending failure response:', err);
    }
    return;
  }
  const amountSats = toSats(valorStr);
  if (amountSats <= 0) {
    try {
      await apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.error('⚠️ Error sending failure response:', err);
    }
    return;
  }

  // 3) busca o dono via hash
  const ownerId = getCardOwnerByHash(hash);
  if (!ownerId) {
    try {
      await apiChannel.send({
        content: `000000000000:false`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.error('⚠️ Error sending failure response:', err);
    }
    return;
  }

  // 4) garante que o destinatário exista no banco
  try {
    getUser(targetId);
  } catch {
    createUser(targetId);
  }

  const owner = getUser(ownerId);
  // saldo insuficiente?
  if (owner.coins < amountSats) {
    try {
      await apiChannel.send({
        content: `${ownerId}:false`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.error('⚠️ Error sending insufficient balance response:', err);
    }
    return;
  }

  // 5) faz a transferência em satoshis
  try {
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
      .run(amountSats, ownerId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
      .run(amountSats, targetId);
  } catch (err) {
    console.error('⚠️ Error updating balances:', err);
    return;
  }

  // 6) registra a transação para owner e receiver
  const date           = new Date().toISOString();
  const txIdOwner      = genUniqueTxId();
  const txIdReceiver   = genUniqueTxId();
  try {
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?,?,?,?,?)
    `).run(txIdOwner, date, ownerId, targetId, amountSats);
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?,?,?,?,?)
    `).run(txIdReceiver, date, ownerId, targetId, amountSats);
  } catch (err) {
    console.error('⚠️ Error logging transactions:', err);
  }

  // 7) responde com sucesso
  try {
    await apiChannel.send({
      content: `${ownerId}:true`,
      reply: { messageReference: message.id }
    });
  } catch (err) {
    console.error('⚠️ Error sending success response:', err);
  }
}



// --- Handler para !bill ---
if (cmd === '!bill' && args.length >= 3) {
  const [ fromId, toId, amountStr, timeStr ] = args;
  const apiChannel = message.channel;
  const { toSats } = require('./database');

  // 1) Validação dos IDs
  if (!/^\d{17,}$/.test(fromId) || !/^\d{17,}$/.test(toId)) {
    try {
      await apiChannel.send({
        content: '❌ Uso correto: !bill <fromId> <toId> <amount> [time]',
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.warn('⚠️ Não foi possível enviar mensagem de uso incorreto:', err);
    }
    return;
  }

  // 2) Validação do amount (até 8 casas decimais)
  const amount = amountStr.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    try {
      await apiChannel.send({
        content: '❌ Formato de valor inválido. Até 8 casas decimais.',
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.warn('⚠️ Não foi possível enviar mensagem de valor inválido:', err);
    }
    return;
  }
  const satAmount = toSats(amount);

  // 3) Cálculo do timestamp
  const now = Date.now();
  let timestamp = now;
  if (timeStr) {
    const m = timeStr.match(/^(\d+)([dhms])$/);
    if (!m) {
      try {
        await apiChannel.send({
          content: '❌ Formato de tempo inválido. Use 1d, 2h, 30m ou 45s.',
          reply: { messageReference: message.id }
        });
      } catch (err) {
        console.warn('⚠️ Não foi possível enviar mensagem de tempo inválido:', err);
      }
      return;
    }
    const val  = parseInt(m[1], 10);
    const unit = m[2];
    let delta;
    switch (unit) {
      case 'd': delta = val * MS_IN_DAY;    break;
      case 'h': delta = val * MS_IN_HOUR;   break;
      case 'm': delta = val *   MS_IN_MIN;  break;
      case 's': delta = val *   MS_IN_SEC;  break;
    }
    if (delta < MS_IN_HOUR) delta = MS_IN_HOUR;
    if (delta > SIX_MONTHS) delta = SIX_MONTHS;
    timestamp = (delta <= NINETY_DAYS)
      ? now - (NINETY_DAYS - delta)
      : now + (delta - NINETY_DAYS);
  }

  // 4) Criação da bill em DB (amount agora em satoshis)
  let billId;
  try {
    billId = createBill(fromId, toId, satAmount, timestamp);
  } catch (err) {
    console.warn('⚠️ Bill creation failure:', err);
    return;
  }

  // 5) Resposta de confirmação
  try {
    await apiChannel.send({
      content: `${fromId}:${billId}`,
      reply: { messageReference: message.id }
    });
  } catch (err) {
    console.warn('⚠️ Confirmation message sending error:', err);
  }
}


// … dentro do seu client.on('messageCreate', async message => { … } )…

// dentro do seu handler de mensagem
if (cmd === '!paybill' && args.length >= 1) {
  const billId     = args[0];
  const apiChannel = message.channel;
  const executorId = message.author.id;
  const { getUser } = require('./database');
  const { toSats, fromSats } = require('./database');

  // helper para responder sem crashar
  const reply = async ok => {
    try {
      await apiChannel.send({
        content: `${billId}:${ok ? 'true' : 'false'}`,
        reply: { messageReference: message.id }
      });
    } catch (err) {
      console.warn(`⚠️ Falha ao enviar resposta ${ok} em !paybill:`, err);
    }
  };

  // 1) carrega a bill
  let bill;
  try {
    bill = getBill(billId);
  } catch (err) {
    console.warn('⚠️ Erro ao buscar bill:', err);
  }
  if (!bill) return reply(false);

  // 2) obtém amount em satoshis (INTEGER)
  const amountSats = Number(bill.amount);
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    return reply(false);
  }

  // 3) confere saldo do pagador (user.coins é satoshis)
  let payer;
  try {
    payer = getUser(executorId);
  } catch (err) {
    console.warn('⚠️ Erro ao buscar executor:', err);
    return reply(false);
  }
  if (!payer || payer.coins < amountSats) {
    return reply(false);
  }

  // 4) registra a transação
  const paidAt = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?,?,?,?,?)
    `).run(billId, paidAt, executorId, bill.to_id, amountSats);
  } catch (err) {
    console.warn('⚠️ Erro ao registrar transação:', err);
  }

  // 5) deleta a bill
  try {
    deleteBill(billId);
  } catch (err) {
    console.warn('⚠️ Erro ao deletar bill:', err);
  }

  // 6) atualiza saldos se não for self-pay
  if (executorId !== bill.to_id) {
    try {
      db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
        .run(amountSats, executorId);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
        .run(amountSats, bill.to_id);
    } catch (err) {
      console.warn('⚠️ Erro ao atualizar saldos:', err);
      return reply(false);
    }

    // 7) enqueue DM de notificação para o destinatário
    const embedObj = {
      type: 'rich',
      title: '🏦 Bill Paid 🏦',
      description: [
        `**${fromSats(amountSats)}** coins`,
        `From: \`${executorId}\``,
        `Bill ID: \`${billId}\``,
        '*Received ✅*'
      ].join('\n')
    };
    try {
      enqueueDM(bill.to_id, embedObj, { components: [] });
    } catch (err) {
      console.warn('⚠️ Erro ao enfileirar DM:', err);
    }
  }

  // 8) confirma no canal
  return reply(true);
}



if (cmd === '!help') {
  const embed = new EmbedBuilder()
    .setColor('#00BFFF')
    .setTitle('🤖 Comandos disponíveis')
    .addFields(
      { name: '💰 Economy',    value: '!bal, !rank, !pay, !paybill, !restore' },
      { name: '🎁 Rewards',    value: '!set, !claim' },
      { name: '💸 Commands',   value: '!view, !check, !history, !bills' },
      { name: '🎓 User',   value: '!user, !backup, !global, !card, !cardreset' },
      { name: '🆘 Help',       value: '!help' }
    );

  try {
    return await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Failed to send !help message:', err);
  }
}


if (cmd === '!remind') {
  // só o usuário autorizado pode usar
  if (message.author.id !== '1378457877085290628') {
    return message.reply('🚫 No permission.');
  }

  // Tenta obter o usuário por menção ou ID
  let target = message.mentions.users.first();
  if (!target && args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('❌ UUnknown user.');
    }
  }
  if (!target) {
    return message.reply('❌ Use: `!remind @user` or `!remind user_id`');
  }

  // Monta o embed e botão igual ao checkReminders()
  const embed = new EmbedBuilder()
    .setColor('Gold')
    .setTitle('🎁 You have a daily reward avaliable!')
    .setDescription('Click in the button bellow to receive it.')
    .setFooter({ text: 'You can claim each 24h.' });

  const button = new ButtonBuilder()
    .setCustomId('resgatar')
    .setLabel('Claim ✅')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  // Envia a DM manualmente
  try {
    await target.send({ embeds: [embed], components: [row] });
    message.reply(`✅ Sent to ${target.tag}.`);
  } catch (err) {
    console.error(`❌ Dm failure to ${target.id}:`, err);
    message.reply('⚠️ I could not send messages to that user.');
  }
}

if (cmd === '!set') {
  const canalId = args[0];

  // Uso correto
  if (!canalId) {
    try {
      return await message.reply('❌ Correct usage: !set channelId');
    } catch (err) {
      console.error('❌ Failed to send usage reply in !set:', err);
      return;
    }
  }

  // Somente dono do servidor
  const donoId = message.guild?.ownerId;
  if (message.author.id !== donoId) {
    try {
      return await message.reply('❌ Only server owner.');
    } catch (err) {
      console.error('❌ Failed to send owner-only reply in !set:', err);
      return;
    }
  }

  // Configurações padrão
  const tempoStr = '1h';
  const coins = 0.00138889;

  // Atualiza config.json usando as funções centralizadas
  const config = loadConfig();
  config[message.guild.id] = { canalId, tempo: tempoStr, coins };
  if (!saveConfig(config)) {
    console.warn('⚠️ Impossible to save config.json');
  }

  // Busca o canal
  const canal = await client.channels.fetch(canalId).catch(() => null);
  if (!canal) {
    try {
      return await message.reply('❌ Invalid channel ID.');
    } catch (err) {
      console.error('❌ Failed to send invalid-channel reply in !set:', err);
      return;
    }
  }

  // Monta botões e embed
  const botao = new ButtonBuilder()
    .setCustomId('resgatar')
    .setLabel('Claim ✅')
    .setStyle(ButtonStyle.Success);
  const botaoTransfer = new ButtonBuilder()
    .setCustomId('atm_transfer')
    .setLabel('🏦 Transfer')
    .setStyle(ButtonStyle.Success);
  const botaoBalance = new ButtonBuilder()
    .setCustomId('atm_balance')
    .setLabel('💵 Balance')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(botao, botaoTransfer, botaoBalance);
  const embed = new EmbedBuilder()
    .setColor('Gold')
    .setTitle('🏧 ATM')
    .setDescription(`Press the claim button below to get **${coins} coin**.\n⏱ Waiting time: **${tempoStr}**`);

  // Tenta enviar no canal sem crashar
  try {
    await canal.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('❌ Failed to send ATM embed in !set:', err);
    // não crasha o bot
  }
}


// dentro de client.on('messageCreate', async message => { … })
if (cmd === '!api') {
  const channelId = args[0];

  // Uso correto
  if (!channelId) {
    try {
      await message.reply('❌ Correct usage: !api <channelId>');
    } catch (err) {
      console.warn('⚠️ No permission to send API usage message:', err);
    }
    return;
  }

  // Só dono do servidor
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    try {
      await message.reply('❌ Only the server owner can config this.');
    } catch (err) {
      console.warn('⚠️ No permission to send owner-only message:', err);
    }
    return;
  }

  // Tenta salvar no banco usando o método do database.js
  try {
    await database.setServerApiChannel(message.guild.id, channelId);
  } catch (err) {
    console.error('⚠️ API setup error:', err);
    return;
  }

  // Confirmação de sucesso
  try {
    await message.reply('✅ API channel setup done.');
  } catch (err) {
    console.warn('⚠️ No permission to send API channel setup message:', err);
  }
}


if (cmd === '!pay') {
  try {
    const { toSats, fromSats, getUser, createUser } = require('./database');

    // 1) parse & validate target
    let targetId, targetTag;
    const mention = message.mentions.users.first();
    if (mention) {
      targetId  = mention.id;
      targetTag = mention.tag;
    } else if (args[0]) {
      targetId = args[0];
      try {
        const fetched = await client.users.fetch(targetId);
        targetTag = fetched.tag;
      } catch {
        // fallback: exist in DB?
        const dbUser = getUser(targetId);
        if (dbUser) {
          targetTag = `User(${targetId})`;
        } else {
          return await message.reply('❌ Usuário desconhecido.');
        }
      }
    } else {
      return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
    }

    // 2) parse & validate amount, convert to satoshis
    const amountStr = args[1]?.trim();
    if (!amountStr || !/^\d+(\.\d{1,8})?$/.test(amountStr) || targetId === message.author.id) {
      return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
    }
    const amountSats = toSats(amountStr);
    if (amountSats <= 0) {
      return await message.reply('❌ Use: `!pay @user <amount>` (até 8 casas decimais).');
    }

    // 3) fetch sender and receiver
    let sender = getUser(message.author.id);
    let receiver;
    try {
      receiver = getUser(targetId);
    } catch {
      createUser(targetId);
      receiver = getUser(targetId);
    }

    if (sender.coins < amountSats) {
      return await message.reply('💸 Saldo insuficiente.');
    }

    // 4) update balances (integer satoshis)
    try {
      db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
        .run(amountSats, message.author.id);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
        .run(amountSats, targetId);
    } catch (err) {
      console.error('⚠️ Error updating balances in !pay:', err);
      return await message.reply('❌ Não foi possível completar a transação. Tente mais tarde.');
    }

    // 5) log transactions
    const date        = new Date().toISOString();
    const txIdSender   = genUniqueTxId();
    const txIdReceiver = genUniqueTxId();
    try {
      const stmt = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(txIdSender, date, message.author.id, targetId, amountSats);
      stmt.run(txIdReceiver, date, message.author.id, targetId, amountSats);
    } catch (err) {
      console.error('⚠️ Error logging transactions in !pay:', err);
    }

    // 6) confirmation
    const sentCoins = fromSats(amountSats);
    return await message.reply(`✅ Sent **${sentCoins} coins** to **${targetTag}**.`);
  } catch (err) {
    console.error('❌ Unexpected error in !pay command:', err);
    try {
      await message.reply('❌ Erro interno ao processar !pay. Tente novamente mais tarde.');
    } catch {}
  }
}





if (cmd === '!check') {
  const { getTransaction } = require('./database');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { AttachmentBuilder } = require('discord.js');

  const txId = args[0];
  if (!txId) {
    return message.reply('❌ Use: !check <transaction_ID>');
  }

  // busca no banco
  const tx = getTransaction(txId);
  if (!tx) {
    return message.reply('❌ Unknown transaction.');
  }

  // prepara diretório temporário
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // cria arquivo de comprovante
  const filePath = path.join(tempDir, `${txId}.txt`);
  const content = [
    `Transaction ID: ${tx.id}`,
    `Date         : ${tx.date}`,
    `From         : ${tx.fromId}`,
    `To           : ${tx.toId}`,
    `Amount       : ${tx.coins} coins`
  ].join(os.EOL);
  fs.writeFileSync(filePath, content, 'utf8');

  // monta texto de resposta
  const replyText = `✅ Transaction: (${tx.date}) from \`${tx.fromId}\` to \`${tx.toId}\` of \`${tx.coins}\` coins.`;

  // tenta enviar com anexo
  try {
    const attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
    await message.reply({ content: replyText, files: [attachment] });
  } catch (err) {
    if (err.code === 50013) {
      console.warn('⚠️ No permission to send the verification ID:', err);
      await message.reply(`${replyText}\n❌ No permission to send the ID.`);
    } else {
      console.error('Unexpected error while sending confirmation txt:', err);
      await message.reply(`${replyText}\n❌ ID sending failure.`);
    }
  } finally {
    // limpa arquivo temporário
    try { fs.unlinkSync(filePath); } catch {}
  }
}



  // dentro do seu handler de messageCreate, adicione:
if (cmd === '!backup') {
  const userId = message.author.id;

  // 1) verifica saldo
  let user;
  try {
    user = getUser(userId);
  } catch (err) {
    console.error('⚠️ Backup failed at getUser:', err);
    return message.reply('❌ Backup failed. Try `!backup`.');
  }
  if (user.coins <= 0) {
    return message.reply('❌ Empty wallet. No codes generated.');
  }

  // 2) gera até 12 códigos
  let codes;
  try {
    const rows = db.prepare('SELECT code FROM backups WHERE userId = ?').all(userId);
    codes = rows.map(r => r.code);
    while (codes.length < 12) {
      const c = crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT OR IGNORE INTO backups(code, userId) VALUES(?,?)').run(c, userId);
      codes.push(c);
    }
  } catch (err) {
    console.error('⚠️ Backup failed at code generation:', err);
    return message.reply('❌ Backup failed. Try `!backup`.');
  }

  // 3) formata as linhas para o embed da DM
  const codeLines = codes.map(c => `> \`\`\`${c}\`\`\``).join('\n');

  // 4) monta embed para DM
  const dmEmbed = new EmbedBuilder()
    .setColor('Purple')
    .setTitle('🔒 Your Wallet Backup Codes')
    .setDescription([
      'Your balance **was not** reset.',
      'Use one of the codes below in another account to restore your wallet:',
      codeLines,
      '',
      'Use `/restore <CODE>` to restore.'
    ].join('\n'));

  // 5) enfileira a DM sem anexos
  try {
    enqueueDM(userId, dmEmbed.toJSON(), { components: [] });
    if (typeof client.processDMQueue === 'function') {
    }
  } catch (err) {
    console.error('⚠️ I can’t enqueue DM:', err);
    return message.reply('⚠️ I can’t send you DM. Try `!backup`.');
  }

  // 6) confirma no canal apenas informando que a DM foi enfileirada
  try {
    await message.reply('✅ Backup codes generated and sent to your DMs!');
  } catch (err) {
    console.error('⚠️ No permission to reply in channel:', err);
    // sem crashar
  }
}



// dentro do seu handler de messageCreate, adicione:
if (cmd === '!restore' && args.length >= 1) {
  const code  = args[0].trim();
  const { getUser } = require('./database');
  const { fromSats } = require('./database');

  // 1) Busca backup
  let row;
  try {
    row = db.prepare('SELECT userId FROM backups WHERE code = ?').get(code);
  } catch (err) {
    console.error('⚠️ Restore failed at DB lookup:', err);
    return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
  }
  if (!row) {
    return message.reply('❌ Unknown Code.');
  }

  const oldId = row.userId;
  const newId = message.author.id;

  // 2) Mesma conta?
  if (oldId === newId) {
    try {
      db.prepare('DELETE FROM backups WHERE code = ?').run(code);
    } catch (err) {
      console.error('⚠️ Failed to delete self‐restore backup:', err);
    }
    return message.reply(
      '❌ You cannot restore backup to the same account.\nUse `/backup` again if you need a fresh code.'
    );
  }

  // 3) Pega saldo antigo (em satoshis)
  let origin;
  try {
    origin = getUser(oldId);
  } catch (err) {
    console.error('⚠️ Restore failed at getUser(oldId):', err);
    return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
  }
  const oldBalSats = origin.coins;  // já é INTEGER

  // 4) Carteira vazia?
  if (oldBalSats <= 0) {
    try {
      db.prepare('DELETE FROM backups WHERE code = ?').run(code);
    } catch (err) {
      console.error('⚠️ Failed to delete empty backup:', err);
    }
    return message.reply('❌ Empty wallet—nothing to restore.');
  }

  // 5) Transfere saldo
  try {
    // adiciona ao novo usuário
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
      .run(oldBalSats, newId);
    // zera a carteira antiga
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
      .run(oldBalSats, oldId);
  } catch (err) {
    console.error('⚠️ Restore failed at balance transfer:', err);
    return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
  }

  // 6) Registra transação(s)
  const date = new Date().toISOString();
  try {
    const txId1 = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(txId1, date, oldId, newId, oldBalSats);

    const txId2 = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(txId2, date, oldId, newId, oldBalSats);
  } catch (err) {
    console.error('⚠️ Failed to log restore transactions:', err);
    // não aborta: o saldo já foi movido
  }

  // 7) Remove o código de backup
  try {
    db.prepare('DELETE FROM backups WHERE code = ?').run(code);
  } catch (err) {
    console.error('⚠️ Failed to delete used backup code:', err);
  }

  // 8) Confirmação final
  return message.reply(
    `🎉 Backup restored: **${fromSats(oldBalSats)}** coins transferred to your wallet!`
  );
}


  // no seu index.js ou commands.js, onde você trata comandos de texto:
if (cmd === '!history') {
  try {
    const { getUser, fromSats } = require('./database');
    const guild     = message.guild;
    const channel   = message.channel;
    const botMember = guild?.members.cache.get(client.user.id);

    // ⇢ Permissões
    const canSend   = !guild || channel.permissionsFor(botMember).has('SendMessages');
    const canAttach = !guild || channel.permissionsFor(botMember).has('AttachFiles');
    if (!canSend && !canAttach) {
      console.warn(`❌ Unable to send messages or attach files in ${channel.id} of ${guild?.name || 'DM'} (${guild?.id || 'no-guild'})!`);
      return;
    }
    if (!canSend) {
      console.warn('❌ No permission to send messages.');
      return;
    }

    // ⇢ Parâmetros: !history [userOrPage] [pageIfUser]
    const argsLen = args.length;
    let requestedId = message.author.id;
    let page        = 1;

    if (argsLen >= 1) {
      const arg0 = args[0];
      const mentionMatch = arg0.match(/^<@!?(?<id>\d+)>$/);
      if (mentionMatch) {
        requestedId = mentionMatch.groups.id;
        if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
      } else if (/^\d{16,}$/.test(arg0)) {
        requestedId = arg0;
        if (argsLen >= 2 && /^\d+$/.test(args[1])) page = parseInt(args[1], 10);
      } else if (/^\d+$/.test(arg0)) {
        page = parseInt(arg0, 10);
      }
    }

    // busca usuário no DB
    let userRow;
    try {
      userRow = getUser(requestedId);
    } catch (err) {
      console.error('⚠️ Error fetching user record in !history:', err);
      return await channel.send('❌ Unknown User.');
    }
    if (!userRow) {
      return await channel.send('❌ Unknown User.');
    }

    // —— remover duplicatas
    try {
      db.prepare(`
        DELETE FROM transactions
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM transactions
          WHERE from_id = ? OR to_id = ?
          GROUP BY date, amount, from_id, to_id
        )
        AND (from_id = ? OR to_id = ?)
      `).run(requestedId, requestedId, requestedId, requestedId);
    } catch (err) {
      console.error('⚠️ Failed to remove duplicate transactions:', err);
    }

    // conta total de transações
    let totalCount;
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = ? OR to_id = ?`
      ).get(requestedId, requestedId);
      totalCount = row.cnt;
    } catch (err) {
      console.error('⚠️ Failed to count transactions:', err);
      return await channel.send('❌ Could not retrieve history.');
    }

    const perPage = 100;
    const maxPage = Math.max(1, Math.ceil(totalCount / perPage));
    if (page > maxPage) page = maxPage;

    // prepara cabeçalho
    let name = 'unknown';
    try {
      name = (await client.users.fetch(requestedId)).username;
    } catch {}
    const header = [];
    if (page > maxPage) header.push(`⚠️📖 Showing latest page: ${maxPage}`);
    header.push(`🔄 User: ${name} (${requestedId})`);
    header.push(`⏱️ Transactions: ${totalCount}`);
    header.push(`💸 Balance: ${fromSats(userRow.coins)} coins`);
    header.push(`📖 Page: ${page}`);

    if (totalCount === 0) {
      return await channel.send(header.concat('⚠️ No Transactions ⚠️').join('\n'));
    }

    // busca transações da página
    let transactions = [];
    try {
      transactions = db.prepare(`
        SELECT * FROM transactions
        WHERE from_id = ? OR to_id = ?
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `).all(requestedId, requestedId, perPage, (page - 1) * perPage);
    } catch (err) {
      console.error('⚠️ Failed to fetch transactions in !history:', err);
      return await channel.send('❌ Could not retrieve history.');
    }

    // monta conteúdo TXT
    const blocks = transactions.map(tx => [
      `UUID:   ${tx.id}`,
      `AMOUNT: ${fromSats(tx.amount)} coins`,
      `FROM:   ${tx.from_id}`,
      `TO:     ${tx.to_id}`,
      `DATE:   ${tx.date}`
    ].join(os.EOL));
    const content = blocks.join(os.EOL + os.EOL);

    // grava em temp e envia com attachment
    const tempDir  = path.join(__dirname, 'temp');
    const fileName = `${requestedId}_history_${page}.txt`;
    const filePath = path.join(tempDir, fileName);
    try {
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
      fs.writeFileSync(filePath, content);
    } catch (err) {
      console.error('⚠️ Failed to write history file:', err);
      // prossegue sem anexo
    }

    try {
      const sendOptions = { content: header.join('\n') };
      if (fs.existsSync(filePath)) {
        sendOptions.files = [ new AttachmentBuilder(filePath, { name: fileName }) ];
      }
      await channel.send(sendOptions);
    } catch (err) {
      if (err.code === 50013) {
        console.warn('⚠️ No permission to send history file in !history:', err);
        await channel.send(header.join('\n'));
      } else {
        console.error('❌ Error sending !history reply:', err);
      }
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }

  } catch (err) {
    console.error('❌ Unexpected error in !history command:', err);
    // não crashar
  }
}


if (cmd === '!verify') {
  const id      = args[0];
  const channel = message.channel;

  // helper para responder sem travar
  const safeReply = async content => {
    try {
      await message.reply({ content, messageReference: message.id });
    } catch (err) {
      console.error('⚠️ !verify reply failed:', err);
    }
  };

  // 1) valida sintaxe
  if (!id) {
    return safeReply('❌ Use: `!verify <ID>`');
  }

  // 2) ignora se for uma bill
  let isBill = false;
  try {
    isBill = !!getBill(id);
  } catch (err) {
    console.error('⚠️ Error checking bills in !verify:', err);
  }
  if (isBill) {
    return safeReply(`${id}:false`);
  }

  // 3) busca na tabela transactions
  let found = false;
  try {
    const row = db
      .prepare('SELECT 1 FROM transactions WHERE id = ?')
      .get(id);
    found = !!row;
  } catch (err) {
    console.error('⚠️ Error querying transactions in !verify:', err);
  }

  // 4) responde true ou false
  return safeReply(`${id}:${found ? 'true' : 'false'}`);
}

if (cmd === '!bills') {
  const { fromSats } = require('./database');
  const channel   = message.channel;
  const guild     = message.guild;
  const userId    = message.author.id;
  const botMember = guild?.members.cache.get(client.user.id);

  // 1) Verifica permissão de envio e anexar
  const canSend   = !guild || channel.permissionsFor(botMember).has('SendMessages');
  const canAttach = !guild || channel.permissionsFor(botMember).has('AttachFiles');
  if (!canSend) return;

  // 2) Busca todas as bills “de” e “para” o usuário
  let bills;
  try {
    const toPay     = await logic.getBillsTo(userId, 1);
    const toReceive = await logic.getBillsFrom(userId, 1);
    bills = [...toPay, ...toReceive];
  } catch (err) {
    console.error('⚠️ Bills listing failure:', err);
    return channel.send('❌ Cannot find your bills.');
  }

  if (bills.length === 0) {
    return channel.send('ℹ️ You do not have pending bills.');
  }

  // 3) Formata o conteúdo do arquivo
  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const { AttachmentBuilder } = require('discord.js');

  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const lines = bills.map(b =>
    [
      `BILL ID : ${b.id}`,
      `FROM    : ${b.from_id}`,
      `TO      : ${b.to_id}`,
      `AMOUNT  : ${Number(b.amount).toFixed(8)} coins`,
      `DATE    : ${new Date(b.date).toLocaleString()}`
    ].join(os.EOL)
  );
  const content = lines.join(os.EOL + os.EOL);

  const fileName = `${userId}_bills.txt`;
  const filePath = path.join(tempDir, fileName);

  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error('⚠️ Bills file creating failure:', err);
  }

  // 4) Envia a mensagem com anexo se possível
  try {
    const payload = {
      content: `📋 **Your bills (${bills.length}):**\n` +
        bills.map((b, i) => `**${i+1}.** \`${b.id}\``).join('\n')
    };
    if (canAttach && fs.existsSync(filePath)) {
      payload.files = [ new AttachmentBuilder(filePath, { name: fileName }) ];
    }
    await channel.send(payload);
  } catch (err) {
    console.warn('⚠️ Bills file attach failure:', err);
    await channel.send(
      `📋 **Your bills (${bills.length}):**\n` +
      bills.map((b, i) => `**${i+1}.** \`${b.id}\``).join('\n')
    );
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}



if (cmd === '!global') {
  const channel = message.channel;
  const { fromSats } = require('./database');

  // 1) Deduplicate all transactions globally
  try {
    db.prepare(`
      DELETE FROM transactions
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM transactions
        GROUP BY date, amount, from_id, to_id
      )
    `).run();
  } catch (err) {
    console.error('⚠️ Failed to remove duplicate transactions globally:', err);
  }

  // 2) Gather stats
  let totalCoins   = 0;
  let totalTx      = 0;
  let totalClaims  = 0;
  let totalUsers   = 0;
  let yourBalance  = 0;
  let totalBills   = 0;
  try {
    totalCoins   = db.prepare('SELECT COALESCE(SUM(coins),0) AS sum FROM users').get().sum;
    totalTx      = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
    totalClaims  = db.prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = '000000000000'").get().cnt;
    totalUsers   = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
    totalBills   = db.prepare('SELECT COUNT(*) AS cnt FROM bills').get().cnt;
    yourBalance  = getUser(message.author.id).coins;
  } catch (err) {
    console.error('⚠️ Failed to fetch global stats:', err);
    try {
      return await channel.send('❌ Error retrieving global economy info.');
    } catch {
      console.error('❌ Cannot send error message in channel:', err);
      return;
    }
  }

  // 3) Next reward timing
  let nextRewardText = 'Unknown';
  try {
    const last      = getCooldown(message.author.id);
    const guildConf = JSON.parse(fs.readFileSync(configFilePath, 'utf8'))[message.guildId] || null;
    let cooldownMs  = 24 * 60 * 60 * 1000;
    if (guildConf) {
      const m = guildConf.tempo.match(/(\d+)([dhm])/);
      const v = m ? parseInt(m[1], 10) : 24;
      cooldownMs = m[2] === 'h' ? v * 3600000
                 : m[2] === 'm' ? v *   60000
                 :                 v * 86400000;
    }
    const now = Date.now();
    if (now - last < cooldownMs) {
      const diff = cooldownMs - (now - last);
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      nextRewardText = `${h}h ${m}m`;
    } else {
      nextRewardText = 'Available now';
    }
  } catch {
    nextRewardText = 'Unknown';
  }

  // 4) Server count
  const totalGuilds = client.guilds.cache.size;

  // 5) Build quoted-style message
  const lines = [
    '# 🏆Economy Information 🏆',
    '',
    `🌐Global Balance: \`${fromSats(totalCoins)}\` **coins**`,
    `💰Your Balance: \`${fromSats(yourBalance)}\` coins`,
    nextRewardText === 'Available now'
      ? `⏱️Next Reward: 🎉 NOW 🎉`
      : `⏱️Next Reward: \`${nextRewardText}\`⚠️`,
    `🏦Servers: \`${totalGuilds}\` servers`,
    `📖Total Transactions: \`${totalTx}\` transactions`,
    `💳Total Bills: \`${totalBills}\` bills`,
    `📨Total Claims: \`${totalClaims}\` claims`,
    `⭐Coin Users: \`${totalUsers}\` users`,
    '',
    '🪙 Oficial Discord Coin System 🪙'
  ];
  const messageContent = lines.map(l => `> ${l}`).join('\n');

  // 6) Send with error protection
  try {
    await channel.send(messageContent);
  } catch (err) {
    console.error('❌ Failed to send !global message:', err);
  }
}



if (cmd === '!claim') {
  try {
    const userId = message.author.id;
    let coins, cooldownMs;

    if (message.guild) {
      // Resgate dentro de um servidor
      const config = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      const conf   = config[message.guild.id];
      if (!conf) {
        return await message.reply('⚠️ No rewards.');
      }
      coins      = conf.coins;               // número de coins (ex: 1)
      cooldownMs = parseTempo(conf.tempo);
    } else {
      // Resgate via DM
      coins      = 0.00138889;
      cooldownMs = 1 * 60 * 60 * 1000;      // 24h
    }

    const last = getCooldown(userId);
    const now  = Date.now();
    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      return await message.reply(`⏳ Wait more ${h}h ${m}m to claim again.`);
    }

    // ① converte o valor em coins para satoshis
    const amountSats = toSats(coins);

    // ② adiciona sats ao usuário
    addCoins(userId, amountSats);

    // ③ atualiza cooldown e notificação
    setCooldown(userId, now);
    setNotified(userId, false);

    // ④ registra transação de claim (from “zero” para o usuário)
    try {
      const date = new Date().toISOString();
      const txId = genUniqueTxId();
      db.prepare(`
        INSERT INTO transactions (id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        txId,
        date,
        '000000000000',  // endereço “zero”
        userId,
        amountSats
      );

      // ⑤ exibe ao usuário o valor formatado em coins
      await message.reply(
        `🎉 You claimed **${fromSats(amountSats)}** coins successfully!`
      );
    } catch (err) {
      console.error('⚠️ Failed to log claim transaction:', err);
      // ainda passa o valor correto formatado
      await message.reply(
        `🎉 You claimed **${fromSats(amountSats)}** coins, but I couldn't log the transaction.`
      );
    }

  } catch (err) {
    console.error('❌ Command error !claim:', err);
    try {
      await message.reply('❌ Error while processing your claim. Try again later.');
    } catch (sendErr) {
      console.error('❌ Message sending error while processing !claim:', sendErr);
    }
  }
}


  if (message.content === '!user') {
    try {
      const embed = new EmbedBuilder()
        .setTitle('🏧 Registration 🏧')
        .setDescription('Click on the button to register.');

      const button = new ButtonBuilder()
        .setCustomId('user_register_button')
        .setLabel('Register')
        .setStyle(ButtonStyle.Secondary); // cinza

      const row = new ActionRowBuilder().addComponents(button);

      await message.channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
      console.error('❌ Error sending !user embed:', err);
    }
  }


if (cmd === '!rank') {
  try {
    const { fromSats } = require('./database');

    // 1) get all accounts
    const todos = getAllUsers();
    const totalAccounts = todos.length;

    // 2) sort by coins desc, take top 25
    const top25 = [...todos]
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 25);

    let descricao = '';
    // 3) build description
    for (let i = 0; i < top25.length; i++) {
      const entry = top25[i];
      const dbRecord = getUser(entry.id);
      let displayName;

      if (dbRecord && dbRecord.username) {
        displayName = dbRecord.username;
      } else {
        try {
          const user = await client.users.fetch(entry.id);
          displayName = user.tag;
        } catch {
          displayName = entry.id;
        }
      }

      descricao += `**${i + 1}.** ${displayName} — **${fromSats(entry.coins)} coins**\n`;
    }

    // 4) total economy
    const totalEconomy = todos.reduce((acc, cur) => acc + cur.coins, 0);
    descricao += `\n💰 **Global:** ${fromSats(totalEconomy)} **coins**`;
    descricao += `\n**Total Accounts:** ${totalAccounts} **users**`;

    // 5) send embed
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor('Blue')
          .setTitle('🏆 TOP 25')
          .setDescription(descricao || 'No coin holders yet.')
      ]
    });

  } catch (err) {
    console.error('❌ Command error !rank:', err);
    try {
      await message.reply('❌ Error !rank. Try again later.');
    } catch (sendErr) {
      console.error('❌ Error sending !rank error message:', sendErr);
    }
  }
 }
});





// 2) Atualize o handler do botão Resgatar para aceitar cliques em DMs ou em servidores:
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'resgatar') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  await safeDefer(interaction, { flags: 64 });

  const fs = require('fs');
  const { toSats, fromSats, addCoins, setCooldown, setNotified, getCooldown, genUniqueTxId, db } = require('./database');
  const userId = interaction.user.id;
  let coins, cooldownMs;

  if (interaction.guildId) {
    // clique dentro de um servidor — mantém sua lógica original
    const config = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const conf   = config[interaction.guildId];
    if (!conf) {
      return interaction.editReply({ content: '⚠ No claim rewards for this server.' });
    }
    coins      = conf.coins;
    cooldownMs = parseTempo(conf.tempo);
  } else {
    // clique na DM — define valores padrão
    coins      = 0.00138889;                     // quantia padrão em DMs
    cooldownMs = 1 * 60 * 60 * 1000;   // 24h
  }

  const last = getCooldown(userId);
  const now  = Date.now();
  if (now - last < cooldownMs) {
    const restante = cooldownMs - (now - last);
    const h = Math.floor(restante / 3600000);
    const m = Math.floor((restante % 3600000) / 60000);
    return interaction.editReply({ content: `⏳ Wait more ${h}h ${m}m to claim again.` });
  }

  // converte para satoshis e adiciona ao usuário
  const amountSats = toSats(coins);
  addCoins(userId, amountSats);
  setCooldown(userId, now);
  setNotified(userId, false);

  // registra transação de claim (from zero para o usuário)
  try {
    const date = new Date().toISOString();
    const txId = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions (id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(txId, date, '000000000000', userId, amountSats);
  } catch (err) {
    console.error('⚠️ Failed to log claim transaction:', err);
  }

  // responde exibindo sempre 8 casas decimais
  return interaction.editReply({
    content: `🎉 You claimed **${fromSats(amountSats)}** coins successfully!`
  });
});



client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'user_register_button') {
    if (interaction.replied || interaction.deferred) return;

    try {
      // NÃO chame deferReply antes de showModal!
      // Chama o modal do comando user.js para abrir
      await userCommand.execute(interaction);

      // Modal abre imediatamente, não precisa de deferReply nem deleteReply

    } catch (err) {
      console.error('❌ Error handling user_register_button:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Internal error.', ephemeral: true });
        }
      } catch {}
    }
  }
});


client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'atm_balance') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  try {
    await safeDefer(interaction, { flags: 64 }); // resposta ephemeral
  } catch {
    return;
  }

  const { getUser, fromSats } = require('./database');
  const user = getUser(interaction.user.id);

  return interaction.editReply({
    content: `💰 Account **${interaction.user.tag} Balance:** ${fromSats(user.coins)} **coins**`
  });
});

const userCommand = require('./commands/user');

// Handler para o modal de usuário
client.on('interactionCreate', async interaction => {
  // Só processa se for modal submit com customId 'user_modal'
  if (!interaction.isModalSubmit() || interaction.customId !== 'user_modal') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;

  try {
    // ephemerally defer the reply
    await safeDefer(interaction, { flags: 64 });

    // executa o modalSubmit do comando user.js
    await userCommand.modalSubmit(interaction);
  } catch (e) {
    console.error('User modal error:', e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Internal error.', ephemeral: true });
      }
    } catch {}
  }
});



client.on('interactionCreate', async interaction => {
  // Only handle the “Transfer” button
  if (!interaction.isButton() || interaction.customId !== 'atm_transfer') return;

  // Avoid double-show
  if (interaction.replied || interaction.deferred) return;

  try {
    await interaction.showModal({
      customId: 'atm_modal_transfer',
      title: '🏧 Global Discord Coin ATM 🏧',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: 'userId',
              label: 'User ID:',
              style: 1,
              minLength: 17,
              maxLength: 20,
              required: true
            }
          ]
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: 'valor',
              label: 'Value:',
              style: 1,
              required: true
            }
          ]
        }
      ]
    });
  } catch (err) {
    console.error(`❌ No permission to open modal:`, err);
    // Ephemeral feedback so the user knows the button failed
    try {
      await interaction.reply({ content: '❌ No permission.', ephemeral: true });
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {
  // only handle the ATM transfer modal
  if (!interaction.isModalSubmit() || interaction.customId !== 'atm_modal_transfer') return;

  // 1) Acknowledge the modal immediately
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    // may already be acknowledged—continue anyway
  }

  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');
  const { AttachmentBuilder } = require('discord.js');
  const { getUser, createUser, toSats, fromSats } = require('./database');

  // 2) Read inputs
  const senderId = interaction.user.id;
  const targetId = interaction.fields.getTextInputValue('userId').trim();
  const amountStr = interaction.fields.getTextInputValue('valor').trim();

  // 3) Validate
  if (
    !targetId ||
    !/^\d+(\.\d{1,8})?$/.test(amountStr) ||
    targetId === senderId
  ) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }
  const amountSats = toSats(amountStr);
  if (amountSats <= 0) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }

  // 4) Check sender balance
  const sender = getUser(senderId);
  if (sender.coins < amountSats) {
    return interaction.editReply({ content: '💸 Low balance.' });
  }

  // ensure target exists in DB
  try {
    getUser(targetId);
  } catch {
    createUser(targetId);
  }

  // 5) Perform transfer
  try {
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?')
      .run(amountSats, senderId);
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
      .run(amountSats, targetId);
  } catch (err) {
    console.error('⚠️ Error updating balances:', err);
    return interaction.editReply({ content: '❌ Transfer failed.' });
  }

  // 6) Log transactions
  const date        = new Date().toISOString();
  const txIdSender   = genUniqueTxId();
  const txIdReceiver = genUniqueTxId();
  try {
    const stmt = db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(txIdSender, date, senderId, targetId, amountSats);
    stmt.run(txIdReceiver, date, senderId, targetId, amountSats);
  } catch (err) {
    console.error('⚠️ Error logging transactions:', err);
  }

  // 7) Build the comprovante file
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${senderId}-${txIdSender}.txt`);
  const fileContent = [
    `Transaction ID: ${txIdSender}`,
    `Date         : ${date}`,
    `From         : ${senderId}`,
    `To           : ${targetId}`,
    `Amount       : ${fromSats(amountSats)} coins`
  ].join(os.EOL);
  fs.writeFileSync(filePath, fileContent);

  // 8) Attempt to send the file in a single editReply
  try {
    await interaction.editReply({
      content: `✅ Sent **${fromSats(amountSats)} coins** to <@${targetId}>.`,
      files: [
        new AttachmentBuilder(filePath, {
          name: `${senderId}-${txIdSender}.txt`
        })
      ]
    });
  } catch (err) {
    console.warn('⚠️ No permission to send the transaction file:', err);
    try {
      await interaction.editReply({
        content: `✅ Sent **${fromSats(amountSats)} coins** to <@${targetId}>.\nComprovante: \`${txIdSender}\``
      });
    } catch (err2) {
      console.error('⚠️ Fallback failure:', err2);
    }
  } finally {
    // 9) clean up the temp file
    try { fs.unlinkSync(filePath); } catch {}
  }
});



// Registra automaticamente novos usuários no banco quando entrarem em qualquer servidor
client.on('guildMemberAdd', async (member) => {
  const userId = member.id;

  // Verifica se o usuário já está no banco
  const already = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!already) {
    // 1) Registro imediato no banco
    const now = Date.now() - 24 * 60 * 60 * 1000;
    getUser(userId);
    setCoins(userId, 0);
    setCooldown(userId, now);
    setNotified(userId, false);
    console.log(`➕ New user ${member.user.tag} registered.`);

    // 2) Monta DM de boas-vindas
    const welcomeEmbed = new EmbedBuilder()
      .setColor('Blue')
      .setTitle('🎉 Welcome!')
      .setDescription([
        'Use the **Claim** button or `/claim` to receive **1 coin**',
        'every day! And use our API to buy things.',
        '',
        'To send coins use:',
        '`!pay User_ID amount`',
        'Example: `!pay 1378457877085290628 0.00000001`'
      ].join('\n'));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('resgatar')
        .setLabel('Claim ✅')
        .setStyle(ButtonStyle.Success)
    );

    // 3) Enfileira e processa DM apenas para usuarios novos
    enqueueDM(userId, welcomeEmbed.toJSON(), row.toJSON());
  }
});


function removeOldBills() {
  const { fromSats } = require('./database');
  const threshold = Date.now() - NINETY_DAYS;

  try {
    // 1) Busca todas as bills expiradas
    const expired = db
      .prepare('SELECT bill_id, from_id, amount FROM bills WHERE date < ?')
      .all(threshold);

    // 2) Enfileira DM de expiração para cada from_id válido
    for (const { bill_id, from_id, amount } of expired) {
      if (from_id) {
        try {
          const embed = new EmbedBuilder()
            .setTitle('# ⚠️Your Bill Expired⚠️')
            .setDescription([
              '*You will need to call another bill ID.*',
              '',
              `Bill ID: \`${bill_id}\``,
              `Worth: \`${fromSats(amount)} coins.\``
            ].join('\n'));

          enqueueDM(from_id, embed.toJSON(), { components: [] });
        } catch (err) {
          console.warn(`⚠️ Could not enqueue expiration DM for ${from_id}:`, err);
        }
      }
    }

    // 3) Remove todas as bills expiradas
    const result = db
      .prepare('DELETE FROM bills WHERE date < ?')
      .run(threshold);

    console.log(`[removeOldBills] ${result.changes} bills removed.`);
  } catch (err) {
    console.warn('⚠️ Old bill deleting error:', err);
  }
}




// Função para registrar apenas usuários novos (que ainda não existem no DB)
async function registerAllMembers() {
  console.log('🔄 Initializing the registration of all servers users in the database...');

  // Pega todos os IDs já cadastrados
  const existingIds = new Set(getAllUsers().map(u => u.id));
  const guilds = client.guilds.cache;
  let totalNew = 0;
  const totalGuilds = guilds.size;
  const now = 24 * 60 * 60 * 1000 + Date.now();

  for (const guild of guilds.values()) {
    // Garante que todos os membros estejam no cache
    await guild.members.fetch();

    guild.members.cache.forEach(member => {
      const id = member.user.id;
      // Se já existe, pule
      if (existingIds.has(id)) return;

      // Caso não exista, cria registro com valores padrão
      getUser(id);           // insere com default coins=0, cooldown=0, notified=0
      // se quiser reforçar, pode descomentar:
      // setCoins(id, 0);
       setCooldown(id, now);
      // setNotified(id, false);

      existingIds.add(id);
      totalNew++;
    });
  }

  console.log(`✅ Registred ${totalNew} users in ${totalGuilds} servers.`);
}

setInterval(removeOldBills, 10 * 60 * 1000);



function startBot() {
    client.login(TOKEN);
}

module.exports = { startBot, client };
