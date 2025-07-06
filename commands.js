// commands.js
const fs   = require('fs');
const path = require('path');
const { REST, Routes, Collection } = require('discord.js');

/**
 * Carrega todos os arquivos de ./commands, popula client.commands
 * e registra (deploy) tanto globalmente quanto por guild imediatamente.
 *
 * @param {Client} client    - instância do Discord.js Client
 * @param {string} token     - DISCORD_TOKEN
 * @param {string} clientId  - CLIENT_ID
 */
function setupCommands(client, token, clientId) {
  // 1) Carrega comandos em client.commands
  client.commands = new Collection();
  const commands = [];
  const commandsPath = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
  }

  // 2) Registra via REST
  const rest = new REST({ version: '10' }).setToken(token);

  client.once('ready', async () => {
    try {
      console.log('🔄 Adding commands GLOBALLY...');
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log('✅ Global commands added.');

      // Para cada guild onde o bot está, faz registro imediato
      for (const guild of client.guilds.cache.values()) {
        const guildId = guild.id;
        try {
          console.log(`🔄 Adding commands in guild ${guild.name} (${guildId})...`);
          await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands }
          );
          console.log(`✅ Added commands in guild ${guild.name} (${guildId}).`);
        } catch (err) {
          console.error(`❌ Error while adding commands in guild ${guild.name} (${guildId}):`, err);
        }
      }
    } catch (err) {
      console.error('❌ Commands registration failure:', err);
    }
  });
}

module.exports = { setupCommands };
