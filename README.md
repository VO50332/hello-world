# 🎁 WhatsApp Free-Stuff Search

Search your WhatsApp groups for free stuff — photos, descriptions, and contact links in one place.

Each person runs this on their own computer, scans their own QR code, adds their own groups, and searches their own messages. No cloud, no accounts, no sharing data with anyone.

---

## How it works

```
Your phone ──QR scan──▶ Bot syncs messages ──▶ You search on localhost:3000
```

1. Run the app on your computer.
2. Scan the QR code with your phone (one time only).
3. Add WhatsApp groups you want to search.
4. Scan messages — the website shows all items with photos and contact links.

---

## Requirements

- **Node.js** version 18 or newer → [Download here](https://nodejs.org)
- **WhatsApp** on your phone (needed once for QR code login)

That's it — no Chrome, no cloud services, no API keys.

---

## Setup

### 1. Download

```bash
git clone https://github.com/VO50332/hello-world.git
cd hello-world
```

### 2. Install

```bash
npm install
```

### 3. Start

```bash
npm start
```

### 4. Scan QR code

Your browser will open automatically at [http://localhost:3000](http://localhost:3000) and show a QR code.

On your phone: **WhatsApp → Settings → Linked Devices → Link a Device** → scan the QR code.

You only need to do this once — your session is saved automatically.

### 5. Add groups & scan

After connecting:
1. Click **⚙️ ניהול קבוצות** (Manage Groups) to add WhatsApp groups
2. Click **🔍 סריקת הודעות** (Scan Messages) to search for items
3. Browse the results — click photos to enlarge, click contacts to open WhatsApp chat

---

## Using the website

| Feature | How |
|---|---|
| Search by keyword | Type in the search box at the top |
| Add groups | Open ⚙️ ניהול קבוצות → pick groups from the list |
| Scan messages | Open 🔍 → set days + keywords → click "התחל סריקה" |
| Keyword modes | OR (any keyword matches) or AND (all keywords must match) |
| View full photo | Click any photo |
| Contact seller | Click the phone link → opens WhatsApp chat |
| Mark as taken | Click "סמן כנלקח" on a card |
| Delete items | Click "מחק" on a card, or "🗑️ מחק הכל" to clear everything |

---

## Project structure

```
├── src/
│   ├── index.js          ← Entry point (starts everything)
│   ├── bot/index.js      ← WhatsApp connection (Baileys)
│   ├── server/index.js   ← Web server & API
│   └── db/index.js       ← SQLite database
├── public/
│   ├── index.html        ← Main page
│   ├── qr.html           ← QR code page
│   ├── app.js            ← Frontend logic
│   └── style.css         ← Styles
├── data/                 ← Database + photos (auto-created, gitignored)
├── .env.example          ← Optional config
└── package.json
```

---

## FAQ

**The bot stopped — what do I do?**
Run `npm start` again. If the session expired you'll see a new QR code to scan.

**I see "No messages found" when scanning**
Wait about 1 minute after connecting for WhatsApp to sync your message history. The sync status indicator at the top of the scan panel shows progress.

**How do I search for specific items?**
Use the keyword field in the scan panel (e.g. "כיסא,ספה,מיטה"). Separate multiple keywords with commas. Choose OR (any match) or AND (all must match).

**Can other people see my data?**
No. Everything runs on your computer at localhost:3000. Your messages, photos, and contacts stay on your machine.

**I want to run this 24/7**
Use [PM2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start src/index.js --name whatsapp-search
pm2 save
pm2 startup
```
