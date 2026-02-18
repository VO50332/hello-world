// Main entry point — starts both the web server and the WhatsApp bot together

require('./server/index');   // Start the website / API
require('./bot/index');      // Start the WhatsApp bot (shows QR on first run)
