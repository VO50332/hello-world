# 🎁 שוק מתנות — WhatsApp Free-Stuff Marketplace Bot

A bot that monitors your Hebrew WhatsApp group and automatically publishes all free-item posts to a website — complete with photos and contact links.

---

## How it works

```
WhatsApp Group  →  Bot reads messages  →  Saves to database  →  Website shows listings
```

1. The bot runs in the background on your computer (or a server).
2. It monitors your WhatsApp group for new messages.
3. Every message (with its photo, if any) is saved to a local database.
4. The website shows all items in a nice grid — anyone can browse, click a contact link, or mark an item as taken.

---

## Requirements

- **Node.js** version 18 or newer → [Download here](https://nodejs.org)
- **Google Chrome** (used by the bot to run WhatsApp Web)
- Your phone with **WhatsApp** installed (needed once for the QR code login)

---

## Setup (step by step)

### 1. Download the project

```bash
git clone <this-repo-url>
cd whatsapp-marketplace-bot
```

### 2. Install dependencies

```bash
npm install
```

This downloads all the required libraries (may take a minute).

### 3. Configure the group name

Copy the example config file and edit it:

```bash
cp .env.example .env
```

Open `.env` in any text editor and set `WHATSAPP_GROUP_NAME` to the **exact** name of your WhatsApp group (copy-paste from WhatsApp to get the Hebrew text right).

### 4. Start the app

```bash
npm start
```

On the **first run** you will see a QR code in the terminal. Open WhatsApp on your phone:

> **Settings → Linked Devices → Link a Device** → scan the QR code

After scanning, the bot logs in and the website is ready. You only need to do this once — your session is saved automatically.

### 5. Open the website

Go to [http://localhost:3000](http://localhost:3000) in your browser.

---

## Using the website

| Feature | How |
|---|---|
| Browse items | Open the website — items refresh automatically every 30 seconds |
| View full photo | Click any photo |
| Contact seller | Click the phone link → opens WhatsApp chat |
| Mark as taken | Click "סמן כנלקח" on a card |
| Show taken items | Tick "הצג גם פריטים שנלקחו" at the top |
| Delete an item | Click "מחק" → confirm |

---

## Project structure

```
├── src/
│   ├── index.js          ← Main entry point (starts everything)
│   ├── bot/
│   │   └── index.js      ← WhatsApp bot logic
│   ├── server/
│   │   └── index.js      ← Web server & API
│   └── db/
│       └── index.js      ← Database helpers
├── public/
│   ├── index.html        ← Website HTML
│   ├── style.css         ← Styles
│   ├── app.js            ← Website JavaScript
│   └── uploads/          ← Saved photos (auto-created)
├── data/                 ← SQLite database (auto-created)
├── .env.example          ← Config template
└── package.json
```

---

## FAQ

**The bot stopped — what do I do?**
Run `npm start` again. If you see a QR code, scan it once more.

**I want to run this 24/7 (always on)**
Use a tool like [PM2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start src/index.js --name marketplace
pm2 save
pm2 startup   # makes it restart automatically after reboot
```

**Can others outside my home access the website?**
Not by default — it only runs on your own computer. To share it publicly you would need to deploy it to a server (e.g. a cheap VPS or a free service like Railway.app).

**Will the bot post my own messages too?**
Yes — every message in the group becomes a listing, including yours. You can delete individual items from the website.
