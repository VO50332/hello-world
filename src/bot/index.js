// WhatsApp Bot
// Uses whatsapp-web.js which controls WhatsApp Web in a hidden browser.
// On first run it will show a QR code — scan it with your phone to log in.

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { saveItem } = require('../db');

// ── Configuration ────────────────────────────────────────────────────────────
// Set the exact name of your WhatsApp group here (copy-paste from WhatsApp).
const TARGET_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'שוק מתנות';

// Where to save photos sent in the group
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
// ─────────────────────────────────────────────────────────────────────────────

// Create the WhatsApp client.
// LocalAuth saves your session so you only need to scan the QR code once.
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '../../.wwebjs_auth') }),
  puppeteer: {
    // Run Chrome without a visible window (headless mode)
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

// Show QR code in the terminal so you can scan it with your phone
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
  qrcode.generate(qr, { small: true });
  console.log('\nGo to WhatsApp → Settings → Linked Devices → Link a Device\n');
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp authenticated successfully');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('ready', () => {
  console.log(`✅ Bot is running! Monitoring group: "${TARGET_GROUP_NAME}"`);
});

// ── Main message handler ─────────────────────────────────────────────────────
client.on('message_create', async (message) => {
  try {
    // Only handle messages from groups (not private chats)
    if (!message.from.endsWith('@g.us')) return;

    // Get the group's name
    const chat = await message.getChat();
    if (chat.name !== TARGET_GROUP_NAME) return;

    console.log(`📨 New message in "${TARGET_GROUP_NAME}" from ${message._data.notifyName || message.from}`);

    // Get the sender's phone number (strip the WhatsApp suffix @c.us)
    const contact = await message.getContact();
    const phone = contact.number || message.author?.replace('@c.us', '');
    const senderName = contact.pushname || contact.name || phone;

    // Handle photo/video attachments
    let photoPath = null;
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media && media.mimetype?.startsWith('image/')) {
          // Save the image with a unique filename
          const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'jpg';
          const filename = `${Date.now()}_${message.id.id}.${ext}`;
          const filePath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
          photoPath = `/uploads/${filename}`;
          console.log(`  📷 Photo saved: ${filename}`);
        }
      } catch (mediaErr) {
        console.warn('  ⚠️  Could not download media:', mediaErr.message);
      }
    }

    // The message text (caption if it's a photo, or the plain text)
    const description = message.body?.trim();

    // Skip empty messages with no photo
    if (!description && !photoPath) {
      console.log('  ⏭️  Skipping: no text and no photo');
      return;
    }

    // Save to the database
    const itemId = saveItem({
      messageId: message.id.id,
      description: description || '(ללא תיאור)',
      phone,
      senderName,
      photoPath,
    });

    if (itemId) {
      console.log(`  ✅ Item saved (ID: ${itemId})`);
    } else {
      console.log('  ⏭️  Duplicate message, skipped');
    }
  } catch (err) {
    console.error('Error processing message:', err);
  }
});

client.on('disconnected', (reason) => {
  console.log('Bot disconnected:', reason);
  // Reconnect automatically
  client.initialize();
});

// Start the bot
client.initialize();

module.exports = client;
