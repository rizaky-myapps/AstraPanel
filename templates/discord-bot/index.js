// Bot Discord d'exemple hébergé par AstraPanel.
// Le token est lu dans la variable d'environnement DISCORD_TOKEN (onglet « Variables » du panel).
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN manquant : ajoutez-le dans l’onglet « Variables » du panel puis redémarrez.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Vérifie que le bot répond'),
  new SlashCommandBuilder()
    .setName('text')
    .setDescription('Envoie un message par l’intermédiaire du bot')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Le texte à envoyer (\\n pour aller à la ligne)')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .addChannelOption((option) =>
      option
        .setName('salon')
        .setDescription('Salon où envoyer le message (par défaut : le salon actuel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    // Réservée par défaut aux membres qui peuvent gérer les messages (modifiable dans
    // Paramètres du serveur → Intégrations), pour éviter que n'importe qui parle à la place du bot.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),
];

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Connecté en tant que ${c.user.tag} sur ${c.guilds.cache.size} serveur(s)`);
  // Enregistre les commandes slash (elles apparaissent dans Discord en quelques secondes).
  await c.application.commands.set(commands.map((cmd) => cmd.toJSON()));
  console.log(`📝 ${commands.length} commandes slash enregistrées`);
});

async function sendText(interaction) {
  const message = interaction.options.getString('message', true).replaceAll('\\n', '\n');
  const channel = interaction.options.getChannel('salon') ?? interaction.channel;

  const permissions = channel?.permissionsFor(interaction.client.user);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    await interaction.reply({
      content: `❌ Je n'ai pas la permission d'écrire dans ${channel ?? 'ce salon'}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Les mentions @everyone, @here et de rôles sont désactivées pour éviter les abus.
  await channel.send({ content: message, allowedMentions: { parse: ['users'] } });
  await interaction.reply({ content: `✅ Message envoyé dans ${channel}.`, flags: MessageFlags.Ephemeral });
  console.log(`💬 ${interaction.user.tag} a envoyé un message dans #${channel.name}`);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`🏓 Pong ! Latence : ${client.ws.ping} ms`);
    }

    if (interaction.commandName === 'text') {
      await sendText(interaction);
    }
  } catch (err) {
    console.error(`Erreur pendant /${interaction.commandName} :`, err);
    const reply = { content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
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
