// Bot Discord d'exemple hébergé par AstraPanel.
// Le token est lu dans la variable d'environnement DISCORD_TOKEN (onglet « Variables » du panel).
import os from 'node:os';
import { Client, Events, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN manquant : ajoutez-le dans l’onglet « Variables » du panel puis redémarrez.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Vérifie que le bot répond'),
  new SlashCommandBuilder().setName('info').setDescription('Informations sur le bot et la machine qui l’héberge'),
];

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Connecté en tant que ${c.user.tag} sur ${c.guilds.cache.size} serveur(s)`);
  // Enregistre les commandes slash (elles apparaissent dans Discord en quelques secondes).
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  console.log(`📝 ${commands.length} commandes slash enregistrées`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply(`🏓 Pong ! Latence : ${client.ws.ping} ms`);
  }

  if (interaction.commandName === 'info') {
    const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const uptime = Math.floor(process.uptime() / 60);
    await interaction.reply(
      [
        '🤖 **Hébergé sur AstraPanel**',
        `• Machine : ${os.hostname()} (${os.arch()})`,
        `• Node.js : ${process.version}`,
        `• RAM utilisée : ${ram} Mo`,
        `• En ligne depuis : ${uptime} min`,
      ].join('\n'),
    );
  }
});

// Arrêt propre quand le panel arrête ou redémarre le bot.
process.on('SIGTERM', async () => {
  console.log('Arrêt du bot…');
  await client.destroy();
  process.exit(0);
});

client.login(token).catch((err) => {
  console.error(`❌ Connexion à Discord impossible : ${err.message}`);
  if (err.code === 'TokenInvalid') {
    console.error('   Token invalide : régénérez-le dans le portail développeur Discord (onglet Bot → Reset Token).');
  }
  process.exit(1);
});
