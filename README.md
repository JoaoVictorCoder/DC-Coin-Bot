<h1 align="center">

  [CoinBot](https://discord.com/oauth2/authorize?client_id=1387445776854290533&permissions=824636869632&integration_type=0&scope=bot) - Discord's best economy bot!
  <img src="logo.png" height="300">
</h1>
  <br><br>

--------

# :memo: Requirements

  - [Node.JS](https://nodejs.org/en/download/)
  - [Git](https://git-scm.com/downloads)

# :computer: Install instructions

  1. Clone this repository
   ```
   git clone https://github.com/FoxUshiha/DC-Coin-Bot
   cd DC-coin-bot
   ```
  
  2. Install dependecies
  ```
  npm install
  npm install discord.js sqlite3
  ```

  3. Create a application
       - Go to https://discord.com/developers/applications/
       - Create an application
       - In the OAuth2 section copy your client id
       - Still in the OAuth2 section, mark the `bot` check and scroll down to Bot Permissions and check `Send Messages` and scroll down again to get its link
       - In the bot section click on `RESET TOKEN` and copy it

  4. Paste the token
       - Go to the .env file and paste your token and ID like this
        ```
          DISCORD_TOKEN=YOUR_BOT_TOKEN
          CLIENT_ID=YOUR_CLIENT_ID
        ```

  5. Start the bot
      ```
        npm start
      ```

------
<h1 align="center">

[![License: CC0-1.0](https://img.shields.io/badge/License-CC0%201.0-lightgrey.svg)](http://creativecommons.org/publicdomain/zero/1.0/)

</h1>
