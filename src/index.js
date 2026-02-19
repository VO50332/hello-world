// Main entry point — starts both the web server and the WhatsApp bot together

require('dotenv').config();  // Load .env file into process.env

require('./server/index');   // Start the website / API
require('./bot/index');      // Start the WhatsApp bot (shows QR on first run)
