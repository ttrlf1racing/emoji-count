// index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ChannelType
} from 'discord.js';

// --- Load environment variables ---
const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.GUILD_ID?.trim(); // optional: instant command registration
if (!token) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// --- Create bot client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- Define /export-reactions command ---
const exportCommand = new SlashCommandBuilder()
  .setName('export-reactions')
  .setDescription('Export all reactions from a message into a CSV file.')
  .addStringOption(o =>
    o.setName('message')
      .setDescription('Message URL or ID')
      .setRequired(true)
  )
  .addChannelOption(o =>
    o.setName('channel')
      .setDescription('Channel (required if using a bare message ID)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  )
  .addBooleanOption(o =>
    o.setName('include_user_ids')
      .setDescription('Include user IDs in the CSV (default: true)')
      .setRequired(false)
  );

// --- Register command on startup ---
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: [exportCommand.toJSON()] }
      );
      console.log(`⚙️ Registered /export-reactions instantly for guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: [exportCommand.toJSON()]
      });
      console.log('⚙️ Registered /export-reactions globally (may take up to 1h to appear)');
    }
  } catch (err) {
    console.error('❌ Failed to register slash command:', err);
  }
});

// --- Utility to parse URL or ID ---
function parseMessageRef(input) {
  const match = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (match) return { guildId: match[1], channelId: match[2], messageId: match[3] };
  return { messageId: input };
}

// --- Handle command interactions ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'export-reactions') return;

  if (!interaction.inGuild()) {
    return interaction.reply({ content: '❌ Use this command inside a server.', ephemeral: true });
  }

  const raw = interaction.options.getString('message', true);
  const optChannel = interaction.options.getChannel('channel');
  const includeIds = interaction.options.getBoolean('include_user_ids') ?? true;

  await interaction.deferReply({ ephemeral: true });

  const ref = parseMessageRef(raw);
  let channel = optChannel;

  if (!channel) {
    if (!ref.channelId) {
      return interaction.editReply('❌ Provide a channel when using a bare message ID.');
    }
    channel = interaction.guild.channels.cache.get(ref.channelId);
    if (!channel) return interaction.editReply('❌ I cannot access that channel.');
  }

  let message;
  try {
    message = await channel.messages.fetch(ref.messageId);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Could not fetch that message. Check the channel, ID/URL, and my permissions.');
  }

  // --- Build CSV ---
  const header = includeIds ? 'Emoji,User,User ID\n' : 'Emoji,User\n';
  let csv = header;

  const addLine = (emoji, user) => {
    const tag = `${user.username}#${user.discriminator}`;
    csv += includeIds ? `${emoji},${tag},${user.id}\n` : `${emoji},${tag}\n`;
  };

  try {
    for (const [, reaction] of message.reactions.cache) {
      const emojiLabel = reaction.emoji?.id
        ? `${reaction.emoji.name}:${reaction.emoji.id}` // custom emoji
        : reaction.emoji?.name ?? 'unknown';

      let lastId;
      while (true) {
        const batch = await reaction.users.fetch({ limit: 100, after: lastId });
        if (batch.size === 0) break;

        for (const [, user] of batch) addLine(emojiLabel, user);
        lastId = [...batch.keys()].pop();
        if (batch.size < 100) break;
      }
    }
  } catch (err) {
    console.error(err);
    return interaction.editReply(
      '❌ Failed to fetch reaction users. Ensure I have **View Channel**, **Read Message History**, and **Read Reactions** permissions.'
    );
  }

  if (csv === header) {
    return interaction.editReply('ℹ️ That message has no reactions to export.');
  }

  const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'reactions.csv' });
  await interaction.editReply({ content: '✅ Export complete. Here’s your file:', files: [file] });
});

// --- Login ---
client.login(token);
