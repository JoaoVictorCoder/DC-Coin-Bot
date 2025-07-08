
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
const {
  getUser, setCoins, addCoins, db,
  setCooldown, getCooldown, setNotified, wasNotified,
  getAllUsers, getServerApiChannel, getCardOwner,
  getCardOwnerByHash, createTransaction, getTransaction,
  genUniqueTxId, enqueueDM, getNextDM, deleteDM
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
    console.error(`Erro ao executar /${interaction.commandName}`, err);
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
    console.error('⚠️ Falha ao escrever config.json:', err);
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


let isProcessing = false;

async function sendOneDM(job) {
  const { id, user_id, embed_json, row_json } = job;
  try {
    const embedObj = EmbedBuilder.from(JSON.parse(embed_json));
    const rowObj   = ActionRowBuilder.from(JSON.parse(row_json));

    const payload = { embeds: [embedObj] };
    if (rowObj.components.length > 0) {
      payload.components = [rowObj];
    }

    const user = await client.users.fetch(user_id);
    await user.send(payload);
    console.log(`✉️ DM sent to ${user.tag}`);
  } catch (err) {
    console.warn(`⚠️ DM failure to ${user_id}: ${err.message}`);
  } finally {
    // remove da fila sempre, mesmo em erro
    deleteDM(id);
  }
}

async function processDMQueue() {
  if (isProcessing) return;
  isProcessing = true;
  console.log('➡️ Starting DM queue processor');

  const batchSize = 1;
  let jobs;

  do {
    jobs = [];
    // puxar até batchSize jobs
    for (let i = 0; i < batchSize; i++) {
      const job = getNextDM();
      if (!job) break;
      jobs.push(job);
    }

    // enviar em série com delay de 2s entre cada
    for (const job of jobs) {
      await sendOneDM(job);
      await new Promise(r => setTimeout(r, 2000));
    }

    // se lotou o batch, fazer uma pausa extra antes de buscar o próximo
    if (jobs.length === batchSize) {
      console.log('⏳ Batch completo, aguardando 2 s antes do próximo lote');
      await new Promise(r => setTimeout(r, 2000));
    }
  } while (jobs.length === batchSize);

  // resetar sequência SQLite
  try {
    db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'dm_queue'").run();
    console.log('🔄 DM queue sequence reset to 0');
  } catch (err) {
    console.warn('⚠️ Failed to reset DM sequence:', err.message);
  }

  console.log('✔️ DM queue empty, stopping processor');
  isProcessing = false;
}

client.processDMQueue = processDMQueue;



client.once('ready', () => {
  console.log(`✅ Bot started as ${client.user.tag}`);
  processDMQueue();

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
> (English Message)
> 
> Thanks for contributing with this bot!
> 
> Set up your bot on your server to make possible for users to get coin rewards!
> 
> Use \`!set channel_id\`
> 
> Example: \`!set 1387464728045162656\`
> 
> Be sure that the bot has the right permission to view the channel and send messages & embeds.
> 
> All the commands is better with /commands (but ! and / works)
> 
> 📘 **List of avaliable commands:**
> - \`!rank\` — view the rank of the most rich people.
> - \`!pay @user ammount\` — example: \`!pay @user 0.01\` to send money
> - \`!bal\` — check your current balance
> - \`!check\` — checks the ID of a transaction
> - \`!history\` — checks your or others transaction history
> - \`!card\` — generates a debit card to use in the payment api in other bots
> - \`!cardreset\` — resets and gives you another card to keep it safe
> - \`!restore\` — restores your wallet backup
> - \`!backup\` — creates a wallet backup to restores your coins even if this account got deleted
> - \`!view @user\` — example: \`!view @user\` to see another user's balance
> - \`!notify channel_ID\` — example: \`!notify 1324535042843869300\` to create a notifications channel for the bot
> - \`!set channel_ID\` — example: \`!set 1387471903832281219\` to create a atm and rewards channel for your server and improve your server's Engagement!
> \`Do not forget to config the server and put all those channels! It will improve a lot your server and bot functionalities.\`
> 
> 💛 Help this project with bitcoins donation. Any help is welcome:
\`\`\`
bc1qs9fd9fnngn9svkw8vv5npd7fn504tqx40kuh00
\`\`\`
> 💬 Oficial Support: https://discord.gg/C5cAfhcdRp
> 
> 🏦 Add the bot in more servers: https://discord.com/oauth2/authorize?client_id=1391067775077978214&permissions=1126864127511616&integration_type=0&scope=bot
> 
> Bot Creators: MinyBaby e FoxOficial.
> 
> (Mensagem em Português)
> 
> Obrigado por contribuir e usar esse bot!
> 
> Configure o bot no seu servidor para que ele possa gerar recompensas para seus usuários!
> 
> Use \`!set id_do_canal\`
> 
> Exemplo: \`!set 1387464728045162656\`
> 
> Certifique-se que o bot tenha permissão de enviar mensagens e emblemas no canal desejado.
> 
> Comandos com / são melhores (mas os comandos ! e / funcionam iguais)
> 
> 📘 **Lista de comandos disponíveis:**
> - \`!rank\` — vê o rank global das pessoas mais ricas
> - \`!pay @usuário valor\` — exemplo: \`!pay @user 0.01\` para transferir dinheiro
> - \`!bal\` — consulta seu saldo atual
> - \`!check\` — consulta ID da transferência
> - \`!history\` — consulta histórico de transações
> - \`!card\` — cria seu cartão de crédito do bot para usar em api de pagamento de outros bots
> - \`!cardreset\` — reseta e pega outro cartão para evitar ter seu cartão clonado
> - \`!restore\` — restaura seu backup
> - \`!backup\` — faz um backup do seu saldo para resgatar em outra conta mesmo se essa aqui for deletada
> - \`!view @usuário\` — exemplo: \`!view @user\` para ver quanto dinheiro outro usuário tem
> - \`!remind ID_do_canal\` — exemplo: \`!remind 1324535042843869300\` para criar o canal de notificação do bot
> - \`!set ID_do_canal\` — exemplo: \`!set 1387471903832281219\` para criar o canal de recompensas para poder usar o bot e aumentar o engajamento do seu servidor!
> \`Não esqueça de configurar e colocar todos esses canais mencionados ao seu servidor! Isso vai melhorar e muito o funcionamento do seu servidor e do bot.\`
> 
> 💛 Ajude a manter o projeto com Bitcoins. Qualquer ajuda é bem vinda:
\`\`\`
bc1qs9fnngn9svkw8vv5npd7fn504tqx40kuh00
\`\`\`
> 💬 Suporte Oficial: https://discord.gg/C5cAfhcdRp
> 
> 🏦 Adicione o bot em mais servidores: https://discord.com/oauth2/authorize?client_id=1391067775077978214&permissions=1126864127511616&integration_type=0&scope=bot
> 
> Criadores do Bot: MinyBaby e FoxOficial.
  `;

    // Enfileira a mensagem para o dono do servidor via DM
    try {
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setDescription(mensagem);

      enqueueDM(owner.id, embed.toJSON(), { components: [] });
      processDMQueue();
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
    const user = getUser(message.author.id);
    return await message.reply(`> 💰 Saldo: ${user.coins.toFixed(8)} coins.`);
  } catch (err) {
    console.error('❌ Failed to send !bal reply:', err);
    // opcional: tentar notificar o usuário sobre o erro
    try {
      await message.reply('❌ Não foi possível recuperar seu saldo. Tente novamente mais tarde.');
    } catch {}
  }
}


if (cmd === '!view') {
  try {
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
      .setDescription(`💰 **${record.coins.toFixed(8)} coins**`);

    await message.reply({ embeds: [embed] });

  } catch (err) {
    console.error('❌ Unexpected error in !view command:', err);
    // Opcional: não notificar o usuário, pois já houve tentativa de resposta
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

  // 0) Checa permissão de envio
  if (guild && !apiChannel.permissionsFor(botMember).has('SendMessages')) {
    console.warn(`❌No permission to use api channel at: ${guild.name} (${guild.id})`);
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

  // 2) valida valor
  const amount = parseFloat(valorStr);
  if (isNaN(amount) || amount <= 0) {
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
  getUser(targetId);

  const owner = getUser(ownerId);
  // saldo insuficiente?
  if (owner.coins < amount) {
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

  // 5) faz a transferência de coins
  setCoins(ownerId, owner.coins - amount);
  addCoins(targetId, amount);

  // data atual ISO
  const date = new Date().toISOString();

  // 6) registra a transação para o owner
  const txIdOwner = genUniqueTxId();
  db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES (?,?,?,?,?)
  `).run(txIdOwner, date, ownerId, targetId, amount);

  //     registra também para o receiver com outro UUID
  const txIdReceiver = genUniqueTxId();
  db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES (?,?,?,?,?)
  `).run(txIdReceiver, date, ownerId, targetId, amount);

  // 7) responde com sucesso referenciando a mensagem anterior
  try {
    await apiChannel.send({
      content: `${ownerId}:true`,
      reply: { messageReference: message.id }
    });
  } catch (err) {
    console.error('⚠️ Error sending success response:', err);
  }
}


if (cmd === '!help') {
  const embed = new EmbedBuilder()
    .setColor('#00BFFF')
    .setTitle('🤖 Comandos disponíveis')
    .addFields(
      { name: '💰 Economy',    value: '!bal, !rank, !pay' },
      { name: '🎁 Rewards',    value: '!set' },
      { name: '💸 Commands',   value: '!view, !check, !history' },
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
  const tempoStr = '24h';
  const coins = 1;

  // Atualiza config.json usando as funções centralizadas
  const config = loadConfig();
  config[message.guild.id] = { canalId, tempo: tempoStr, coins };
  if (!saveConfig(config)) {
    console.warn('⚠️ Não foi possível salvar as novas configurações em config.json');
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


if (cmd === '!pay') {
  try {
    // 1) parse & validate target & amount
    let target = message.mentions.users.first();
    if (!target && args[0]) {
      try {
        target = await client.users.fetch(args[0]);
      } catch (err) {
        console.error('❌ Error fetching target user in !pay:', err);
        return await message.reply('❌ Unknown user.');
      }
    }
    const amount = parseFloat(args[1]);
    if (!target || isNaN(amount) || amount <= 0 || target.id === message.author.id) {
      return await message.reply('❌ Use: !pay @user <amount>');
    }

    // 2) busca sender e receiver no DB
    let sender, receiver;
    try {
      sender   = getUser(message.author.id);
      receiver = getUser(target.id);
    } catch (err) {
      console.error('⚠️ Error fetching user records in !pay:', err);
      return await message.reply('❌ Could not access user data. Try again later.');
    }
    if (sender.coins < amount) {
      return await message.reply('💸 Low balance.');
    }

    // 3) atualiza saldos com tratamento
    try {
      setCoins(message.author.id, sender.coins - amount);
      setCoins(target.id, receiver.coins + amount);
    } catch (err) {
      console.error('⚠️ Error updating balances in !pay:', err);
      return await message.reply('❌ Could not complete transaction. Try again later.');
    }

    // 4) gerar timestamp e registrar transações
    const date = new Date().toISOString();
    let txIdSender, txIdReceiver;
    try {
      txIdSender   = genUniqueTxId();
      txIdReceiver = genUniqueTxId();
      const stmt    = db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?,?,?,?,?)
      `);
      stmt.run(txIdSender, date, message.author.id, target.id, amount);
      stmt.run(txIdReceiver, date, message.author.id, target.id, amount);
    } catch (err) {
      console.error('⚠️ Error logging transactions in !pay:', err);
      // seguimos adiante, pois o saldo já foi atualizado
    }

    // 5) prepara arquivo temporário para o sender
    const tempDir         = path.join(__dirname, 'temp');
    const senderFilePath  = path.join(tempDir, `${message.author.id}-${txIdSender}.txt`);
    const senderContent   = [
      `Transaction ID: ${txIdSender}`,
      `Date         : ${date}`,
      `From         : ${message.author.id}`,
      `To           : ${target.id}`,
      `Amount       : ${amount.toFixed(8)} coins`
    ].join(os.EOL);
    try {
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
      fs.writeFileSync(senderFilePath, senderContent);
    } catch (err) {
      console.error('⚠️ Error writing temp file in !pay:', err);
      // podemos prosseguir sem anexo
    }

    // 6) tenta enviar resposta com attachment
    const replyText = `✅ Sent **${amount.toFixed(8)} coins** to **${target.tag}**.`;
    try {
      const files = fs.existsSync(senderFilePath)
        ? [ new AttachmentBuilder(senderFilePath, { name: `${message.author.id}-${txIdSender}.txt` }) ]
        : [];
      await message.reply({ content: replyText, files });
    } catch (err) {
      if (err.code === 50013) {
        console.warn('⚠️ No permission to send attachment in !pay:', err);
        await message.reply(`${replyText}\n❌ No permission to send the transaction file.`);
      } else {
        console.error('❌ Error sending !pay reply:', err);
        await message.reply('❌ Error occurred while sending confirmation.');
      }
    } finally {
      // 7) limpa arquivo temporário
      try { fs.unlinkSync(senderFilePath); } catch {}
    }

  } catch (err) {
    console.error('❌ Unexpected error in !pay command:', err);
    // Não chutamos crashar: informamos genericamente
    try {
      await message.reply('❌ Internal error processing !pay. Please try again later.');
    } catch {}
  }
}



  if (cmd === '!check') {
    const txId = args[0];
    if (!txId) {
      return message.reply('❌ Use: !check <transaction_ID>');
    }
  
    // busca no banco
    const tx = getTransaction(txId);
    if (!tx) {
      return message.reply('❌ Unknown transaction.');
    }
  
    // recria arquivo de comprovante
    const tempDir = path.join(__dirname, 'temp');
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
  
    // monta texto de resposta
    const replyText = `✅ Transaction: (${tx.date}) from \`${tx.from_id}\` to \`${tx.to_id}\` of \`${tx.amount.toFixed(8)}\` coins.`;
  
    // tenta enviar com anexo
    try {
      const attachment = new AttachmentBuilder(filePath, { name: `${txId}.txt` });
      await message.reply({ content: replyText, files: [attachment] });
    } catch (err) {
      if (err.code === 50013) {
        // falta permissão de anexar
        console.warn('⚠️ No permission to send the verification ID:', err);
        await message.reply(`${replyText}\n❌ No permission to send the ID.`);
      } else {
        console.error('Erro inesperado ao enviar comprovante de verificação:', err);
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
    return message.reply('❌ Backup failed. Try `/backup`.');
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
      db.prepare('INSERT INTO backups(code,userId) VALUES(?,?)').run(c, userId);
      codes.push(c);
    }
  } catch (err) {
    console.error('⚠️ Backup failed at code generation:', err);
    return message.reply('❌ Backup failed. Try `/backup`.');
  }

  // 3) monta linhas e arquivo
  const codeLines = codes.map(c => `> \`\`\`${c}\`\`\``).join('\n');
  const tempDir = path.join(__dirname, '..', 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const fileName = `Data-do-backup_${userId}_discord_coins_backup_codes.txt`;
  const filePath = path.join(tempDir, fileName);
  try {
    fs.writeFileSync(filePath, codeLines);
  } catch (err) {
    console.error('⚠️ Backup failed writing file:', err);
    return message.reply('❌ Backup failed. Try `/backup`.');
  }

  // 4) prepara embed DM
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

  // 5) enfileira DM com anexo
  try {
    enqueueDM(userId, dmEmbed.toJSON(), { components: [] }, [{ path: filePath, name: fileName }]);
    if (typeof client.processDMQueue === 'function') client.processDMQueue();
  } catch (err) {
    console.error('⚠️ I can’t enqueue DM:', err);
    try { fs.unlinkSync(filePath); } catch {}
    return message.reply('⚠️ I can\'t send you DM. Try using `/backup`.');
  }

  // 6) resposta no canal
  try {
    await message.reply('✅ Successfully generated 12 backup codes and sent to your DM.');
  } catch (err) {
    console.error('⚠️ No permission to reply in channel:', err);
    // não crashar, mas ainda limpa o arquivo
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// dentro do seu handler de messageCreate, adicione:
if (cmd === '!restore' && args.length >= 1) {
  const code = args[0].trim();

  // 1) busca backup
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

  // 2) mesmo usuário?
  if (oldId === newId) {
    try {
      db.prepare('DELETE FROM backups WHERE code = ?').run(code);
    } catch (err) {
      console.error('⚠️ Failed to delete self‐restore backup:', err);
    }
    return message.reply(
      '❌ You are trying to restore the same wallet in the same account.\nUse `/backup` again.'
    );
  }

  // 3) pega saldo da conta antiga
  let origin;
  try {
    origin = getUser(oldId);
  } catch (err) {
    console.error('⚠️ Restore failed at getUser(oldId):', err);
    return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
  }
  const oldBal = origin.coins;

  // 4) carteira vazia?
  if (oldBal <= 0) {
    try {
      db.prepare('DELETE FROM backups WHERE code = ?').run(code);
    } catch (err) {
      console.error('⚠️ Failed to delete empty backup:', err);
    }
    return message.reply('❌ Empty Wallet.');
  }

  // 5) transfere saldo
  try {
    addCoins(newId, oldBal);
    setCoins(oldId, 0);
  } catch (err) {
    console.error('⚠️ Restore failed at balance transfer:', err);
    return message.reply('❌ Restore failed. Try `/restore <CODE>`.');
  }

  // 6) registra transações com IDs únicos
  const date = new Date().toISOString();
  try {
    const txIdOwner = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?,?,?,?,?)
    `).run(txIdOwner, date, oldId, newId, oldBal);

    const txIdReceiver = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?,?,?,?,?)
    `).run(txIdReceiver, date, oldId, newId, oldBal);
  } catch (err) {
    console.error('⚠️ Failed to log restore transactions:', err);
    // não aborta a restauração, apenas loga
  }

  // 7) deleta o código de backup (uso único)
  try {
    db.prepare('DELETE FROM backups WHERE code = ?').run(code);
  } catch (err) {
    console.error('⚠️ Failed to delete used backup code:', err);
  }

  // 8) confirma no canal
  return message.reply(
    `🎉 Backup Restored Successfully! **${oldBal.toFixed(8)} coins** were transferred to your wallet.`
  );
}


  // no seu index.js ou commands.js, onde você trata comandos de texto:
if (cmd === '!history') {
  try {
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
    header.push(`💸 Balance: ${userRow.coins.toFixed(8)} coins`);
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
      `AMOUNT: ${tx.amount.toFixed(8)} coins`,
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



if (cmd === '!global') {
  const channel = message.channel;

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
  try {
    totalCoins   = db.prepare('SELECT SUM(coins) AS sum FROM users').get().sum || 0;
    totalTx      = db.prepare('SELECT COUNT(*) AS cnt FROM transactions').get().cnt;
    totalClaims  = db.prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE from_id = '000000000000'").get().cnt;
    totalUsers   = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
    yourBalance  = getUser(message.author.id).coins;
  } catch (err) {
    console.error('⚠️ Failed to fetch global stats:', err);
    try { return await channel.send('❌ Error retrieving global economy info.'); }
    catch { console.error('❌ Cannot send error message in channel:', err); return; }
  }

  // 3) Next reward timing
  let nextRewardText = 'Unknown';
  try {
    const last      = getCooldown(message.author.id);
    const guildConf = JSON.parse(fs.readFileSync(configFilePath, 'utf8'))[message.guildId] || null;
    let cooldownMs  = 24 * 60 * 60 * 1000;
    if (guildConf) {
      const m = guildConf.tempo.match(/(\d+)([dhm])/);
      const v = m ? parseInt(m[1]) : 24;
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
    `🌐Global Balance: \`${totalCoins.toFixed(8)}\` **coins**`,
    `💰Your Balance: \`${yourBalance.toFixed(8)}\` coins`,
    nextRewardText === 'Available now'
      ? `⏱️Next Reward: 🎉 NOW 🎉`
      : `⏱️Next Reward: \`${nextRewardText}\`⚠️`,
    `🏦Servers: \`${totalGuilds}\` servers`,
    `📖Total Transactions: \`${totalTx}\` transactions`,
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
      coins     = conf.coins;
      cooldownMs = parseTempo(conf.tempo);
    } else {
      // Resgate via DM
      coins     = 1;
      cooldownMs = 24 * 60 * 60 * 1000; // 24h
    }

    const last = getCooldown(userId);
    const now  = Date.now();
    if (now - last < cooldownMs) {
      const restante = cooldownMs - (now - last);
      const h = Math.floor(restante / 3600000);
      const m = Math.floor((restante % 3600000) / 60000);
      return await message.reply(`⏳ Wait more ${h}h ${m}m to claim again.`);
    }

    addCoins(userId, coins);
    setCooldown(userId, now);
    setNotified(userId, false);

    // ➊ registra transação de claim (from zeros para o usuário)
    try {
      const date = new Date().toISOString();
      const txId = genUniqueTxId();
      db.prepare(`
        INSERT INTO transactions(id, date, from_id, to_id, amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(txId, date, '000000000000', userId, coins);
    } catch (err) {
      console.error('⚠️ Failed to log claim transaction:', err);
    }

    await message.reply(`🎉 You claimed **${coins.toFixed(8)} coins** successfully!`);
  } catch (err) {
    console.error('❌ Erro no comando !claim:', err);
    try {
      await message.reply('❌ Ocorreu um erro ao processar seu claim. Tente novamente mais tarde.');
    } catch (sendErr) {
      console.error('❌ Falha ao enviar mensagem de erro no !claim:', sendErr);
    }
  }
}


if (cmd === '!rank') {
  try {
    // Obtém todos os usuários do banco
    const todos = getAllUsers();
    const totalAccounts = todos.length;

    // Ordena por saldo e pega os 25 mais ricos
    const top25 = [...todos]
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 25);

    let descricao = '';
    let totalTop = 0;

    // Monta a descrição do embed
    for (let i = 0; i < top25.length; i++) {
      const entry = top25[i];
      totalTop += entry.coins;

      // Busca a tag do usuário
      const user = await client.users.fetch(entry.id).catch(() => null);
      descricao += `**${i + 1}.** ${user?.tag || 'Desconhecido'} — **${entry.coins.toFixed(8)} coins**\n`;
    }

    // Soma o total da economia completa
    const totalEconomy = todos.reduce((acc, cur) => acc + cur.coins, 0);

    descricao += `\n💰 **Global:** ${totalEconomy.toFixed(8)} **coins**`;
    descricao += `\n**Total Accounts:** ${totalAccounts} **users**`;

    // Envia o embed
    return await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor('Blue')
          .setTitle('🏆 TOP 25')
          .setDescription(descricao || 'Any coins users yet.')
      ]
    });
  } catch (err) {
    console.error('❌ Erro no comando !rank:', err);
    try {
      await message.reply('❌ Ocorreu um erro ao processar o rank. Tente novamente mais tarde.');
    } catch (sendErr) {
      console.error('❌ Falha ao enviar mensagem de erro no !rank:', sendErr);
    }
  }
}
});



// 2) Atualize o handler do botão Resgatar para aceitar cliques em DMs ou em servidores:
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'resgatar') return;

  // evita double-reply
  if (interaction.replied || interaction.deferred) return;
  await safeDefer(interaction,{ flags: 64 });

  const userId = interaction.user.id;
  let coins, cooldownMs;

  if (interaction.guildId) {
    // clique dentro de um servidor — mantém sua lógica original
    const config = JSON.parse(fs.readFileSync(configFilePath));
    const conf = config[interaction.guildId];
    if (!conf) {
      return interaction.editReply({ content: '⚠ No claim rewards for this server.' });
    }
    coins     = conf.coins;
    cooldownMs = parseTempo(conf.tempo);
  } else {
    // clique na DM — define valores padrão
    coins     = 1;                  // quantia padrão em DMs
    cooldownMs = 24 * 60 * 60 * 1000; // 24h
  }

  const last = getCooldown(userId);
  const now  = Date.now();

  if (now - last < cooldownMs) {
    const restante = cooldownMs - (now - last);
    const h = Math.floor(restante / 3600000);
    const m = Math.floor((restante % 3600000) / 60000);
    return interaction.editReply({ content: `⏳ Wait more ${h}h ${m}m to claim again.` });
  }

  addCoins(userId, coins);
  setCooldown(userId, now);
  setNotified(userId, false);

  // registra transação de claim (from zeros para o usuário)
  try {
    const date = new Date().toISOString();
    const txId = genUniqueTxId();
    db.prepare(`
      INSERT INTO transactions(id, date, from_id, to_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(txId, date, '000000000000', userId, coins);
  } catch (err) {
    console.error('⚠️ Failed to log claim transaction:', err);
  }
  return interaction.editReply({ content: `🎉 You claimed **${coins.toFixed(8)} coins** successfully!` });
});


client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'atm_balance') return;

  if (interaction.replied || interaction.deferred) return;
  try {
    await safeDefer(interaction,{ flags: 64 }); // ephemeral response
  } catch (e) {
    return;
  }

  const user = getUser(interaction.user.id);
  return interaction.editReply({
    content: `💰 Account **${interaction.user.tag} Balance:** ${user.coins.toFixed(8)} **coins**`
  });
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
  } catch (err) {
    console.warn('⚠️ No permission to reply:', err);
    // podemos continuar mesmo assim, mas é possível que já esteja acked
  }

  // 2) Read inputs
  const senderId = interaction.user.id;
  const targetId = interaction.fields.getTextInputValue('userId');
  const amount   = parseFloat(interaction.fields.getTextInputValue('valor'));

  // 3) Validate
  if (!targetId || isNaN(amount) || amount <= 0 || targetId === senderId) {
    return interaction.editReply({ content: '❌ Unknown data.' });
  }
  const sender = getUser(senderId);
  if (sender.coins < amount) {
    return interaction.editReply({ content: '💸 Low balance.' });
  }

  // 4) Perform transfer + log in the database
  setCoins(senderId, sender.coins - amount);
  addCoins(targetId, amount);

  // registra transação para o sender com UUID único
  const date = new Date().toISOString();
  const txIdSender = genUniqueTxId();
  db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES (?,?,?,?,?)
  `).run(txIdSender, date, senderId, targetId, amount);

  // registra também no histórico do receiver com outro UUID único
  const txIdReceiver = genUniqueTxId();
  db.prepare(`
    INSERT INTO transactions(id, date, from_id, to_id, amount)
    VALUES (?,?,?,?,?)
  `).run(txIdReceiver, date, senderId, targetId, amount);

  // 5) Build the comprovante file for the sender
  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
  const filePath = path.join(tempDir, `${senderId}-${txIdSender}.txt`);
  const fileContent = [
    `Transaction ID: ${txIdSender}`,
    `Date         : ${date}`,
    `From         : ${senderId}`,
    `To           : ${targetId}`,
    `Amount       : ${amount.toFixed(8)} coins`
  ].join(os.EOL);
  fs.writeFileSync(filePath, fileContent);

  // 6) Attempt to send the file in a single editReply
  try {
    await interaction.editReply({
      content: `✅ Sent **${amount.toFixed(8)} coins** to <@${targetId}>.`,
      files: [ new AttachmentBuilder(filePath, { name: `${senderId}-${txIdSender}.txt` }) ]
    });
  } catch (err) {
    // provavelmente falta permissão ATTACH_FILES → fallback para apenas mostrar o TXID
    console.warn('⚠️ No permission to send the transaction file:', err);
    try {
      await interaction.editReply({
        content: `✅ Sent **${amount.toFixed(8)} coins** to <@${targetId}>.\nComprovante: \`${txIdSender}\``
      });
    } catch (err2) {
      console.error('⚠️ Fallback failure:', err2);
    }
  } finally {
    // 7) clean up the temp file
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
        '*PT-BR*',
        'Use o botão **Claim** abaixo ou `/claim` para receber **1 coin**',
        'todos os dias! E ainda usar nossa api para comprar coisas.',
        '',
        'Para enviar coins a outros, use:',
        '`!pay User_ID quantia`',
        'Exemplo: `!pay 1378457877085290628 0.00000001`',
        '',
        '*English*',
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
    processDMQueue();
  }
});



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


client.login(TOKEN);
