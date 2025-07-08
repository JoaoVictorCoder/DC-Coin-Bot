// commands.js
const fs   = require('fs');
const path = require('path');
const { REST, Routes, Collection } = require('discord.js');

/**
 * Registers commands globally and per-guild via Discord REST API.
 *
 * @param {Array<Object>} commandsJSON - Array of command JSON definitions
 * @param {string} token               - Your bot token
 * @param {string} clientId            - Your application (client) ID
 * @param {Array<string|Object>} guilds - Guilds to register commands for, either IDs or { id, name }
 */
async function deployCommands(commandsJSON, token, clientId, guilds = []) {
  const rest = new REST({ version: '10' }).setToken(token);

  // 1) Global
  try {
    console.log('🔄 Registering global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: commandsJSON });
    console.log('✅ Global commands registered.');
  } catch (err) {
    console.error('❌ Failed to register global commands:', err);
  }

  // 2) Per-guild
  if (guilds.length > 0) {
    await Promise.all(
      guilds.map(g => {
        const guildId = typeof g === 'string' ? g : g.id;
        const guildName = typeof g === 'object' && g.name ? g.name : guildId;
        return rest
          .put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsJSON })
          .then(() => console.log(`✅ Commands registered for guild ${guildName} (${guildId})`))
          .catch(err => console.error(`❌ Failed to register commands for guild ${guildName} (${guildId}):`, err));
      })
    );
  }
}

/**
 * Loads command modules from ./commands, populates client.commands,
 * and triggers registration both globally and per-guild.
 *
 * @param {import('discord.js').Client} client
 * @param {string} token    Your bot token
 * @param {string} clientId Your application (client) ID
 */
function setupCommands(client, token, clientId) {
  // 1) Load all commands
  client.commands = new Collection();
  const commandsJSON = [];
  const commandsDir = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
    try {
      const command = require(path.join(commandsDir, file));
      client.commands.set(command.data.name, command);
      commandsJSON.push(command.data.toJSON());
    } catch (err) {
      console.error(`❌ Error loading command file ${file}:`, err);
    }
  }

  // 2) On ready, register globally and per existing guilds
  client.once('ready', () => {
    const guilds = Array.from(client.guilds.cache.values())
      .map(g => ({ id: g.id, name: g.name }));
    deployCommands(commandsJSON, token, clientId, guilds);
  });

  // 3) When joining a new guild, register there immediately
  client.on('guildCreate', guild => {
    console.log(`🔄 Joined new guild ${guild.name} (${guild.id}), registering commands...`);
    deployCommands(commandsJSON, token, clientId, [{ id: guild.id, name: guild.name }]);
  });
}

module.exports = { setupCommands };
