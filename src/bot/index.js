// WhatsApp Bot
// Uses whatsapp-web.js which controls WhatsApp Web in a hidden browser.
// On first run it will show a QR code — scan it with your phone to log in.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { saveItem } = require('../db');

// ── Configuration ────────────────────────────────────────────────────────────
const TARGET_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'שוק מתנות';

// WHATSAPP_GROUP_ID lets you skip the slow group-name lookup entirely.
// The bot will print the ID of every group that sends a message — copy it
// from the log and add it to your .env file as WHATSAPP_GROUP_ID=<id>.
let targetGroupId = process.env.WHATSAPP_GROUP_ID || null;

// Where to save photos sent in the group
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '../../.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    protocolTimeout: 120000, // 2 min — for photo downloads on slow connections
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

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
  if (targetGroupId) {
    console.log(`✅ Bot is running! Monitoring group: "${TARGET_GROUP_NAME}" (${targetGroupId})`);
  } else {
    console.log(`✅ Bot is ready. Waiting to identify group "${TARGET_GROUP_NAME}"...`);
    console.log('   When any group message arrives, its ID will be printed here.');
    console.log('   Copy the correct ID into your .env as: WHATSAPP_GROUP_ID=<id>');
  }
});

// ── Main message handler ─────────────────────────────────────────────────────
client.on('message_create', async (message) => {
  try {
    // Only handle group messages
    if (!message.from.endsWith('@g.us')) return;

    // If WHATSAPP_GROUP_ID is not set yet, log every group's ID to help the user find theirs
    if (!targetGroupId) {
      console.log(`📋 Group message received — Group ID: ${message.from}`);
      console.log(`   If this is "${TARGET_GROUP_NAME}", add to your .env:`);
      console.log(`   WHATSAPP_GROUP_ID=${message.from}`);
      return;
    }

    if (message.from !== targetGroupId) return;

    // Read sender info directly from the message data — no Puppeteer call needed
    const rawAuthor = message.author || message._data?.author || '';
    const phone = rawAuthor.replace('@c.us', '') || message.from;
    const senderName = message._data?.notifyName || phone;

    console.log(`📨 New message in "${TARGET_GROUP_NAME}" from ${senderName}`);

    // Handle photo attachments
    let photoPath = null;
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media && media.mimetype?.startsWith('image/')) {
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

    const description = message.body?.trim();

    if (!description && !photoPath) {
      console.log('  ⏭️  Skipping: no text and no photo');
      return;
    }

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
  client.initialize();
});

// ── History scanner ───────────────────────────────────────────────────────────
// Tracks the state of the background scan so the status endpoint can report it.
let scanState = { running: false, days: null, startedAt: null, result: null, error: null };

function getScanState() {
  return { ...scanState };
}

// Starts a background scan and returns immediately.
// Call getScanState() to poll for progress.
function startScan(days) {
  if (scanState.running) return { alreadyRunning: true };

  if (!targetGroupId) {
    return { error: 'Group ID not set. Add WHATSAPP_GROUP_ID to your .env file and restart.' };
  }
  if (!targetGroupId.endsWith('@g.us')) {
    return { error: `Invalid group ID "${targetGroupId}". It must end with @g.us. Check WHATSAPP_GROUP_ID in your .env.` };
  }

  scanState = { running: true, days, startedAt: new Date().toISOString(), result: null, error: null };

  // Run in background — do NOT await
  runScan(days).then(result => {
    scanState = { running: false, days, startedAt: scanState.startedAt, result, error: null };
  }).catch(err => {
    const message = err?.message || String(err);
    console.error('❌ Scan failed:', message);
    scanState = { running: false, days, startedAt: scanState.startedAt, result: null, error: message };
  });

  return { started: true };
}

async function runScan(days) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const limit = Math.min(days * 150, 3000);

  console.log(`\n🔍 Scanning last ${days} day(s) — fetching up to ${limit} messages...`);

  let chat;
  try {
    chat = await client.getChatById(targetGroupId);
  } catch (err) {
    const msg = err?.message || String(err);
    throw new Error(`Could not load the group chat. WhatsApp error: "${msg}". Make sure the group ID is correct and the bot is fully connected.`);
  }

  if (!chat) {
    throw new Error(`Group not found (ID: ${targetGroupId}). The bot may not be a member of this group.`);
  }

  console.log(`   Found chat: "${chat.name}" — loading messages...`);
  const messages = await chat.fetchMessages({ limit });
  console.log(`   Fetched ${messages.length} messages, processing...`);

  let saved = 0, skipped = 0;

  for (const msg of messages) {
    if (msg.timestamp * 1000 < cutoffMs) continue;

    const rawAuthor = msg.author || msg._data?.author || '';
    const phone = rawAuthor.replace('@c.us', '') || targetGroupId;
    const senderName = msg._data?.notifyName || phone;

    let photoPath = null;
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.mimetype?.startsWith('image/')) {
          const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'jpg';
          const filename = `${Date.now()}_${msg.id.id}.${ext}`;
          const filePath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
          photoPath = `/uploads/${filename}`;
        }
      } catch (_) { /* skip undownloadable media */ }
    }

    const description = msg.body?.trim();
    if (!description && !photoPath) continue;

    const itemId = saveItem({
      messageId: msg.id.id,
      description: description || '(ללא תיאור)',
      phone,
      senderName,
      photoPath,
    });

    if (itemId) saved++;
    else skipped++;
  }

  console.log(`✅ Scan done — ${saved} new items saved, ${skipped} duplicates skipped.\n`);
  return { fetched: messages.length, saved, skipped };
}

client.initialize();

module.exports = { client, startScan, getScanState };
