# Omega V5 - Elite WhatsApp Bot

Advanced multi-node WhatsApp automation bot with AI, broadcasting, Intel scraping, and comprehensive group management.

## 🚀 Features

### Core Features
- **Multi-Node Support** - Run multiple WhatsApp sessions simultaneously
- **AI Integration** - Multiple AI providers (DigitalOcean, OpenRouter, Qwen, OpenAI, Claude, DeepSeek)
- **Telegram Control** - Full bot management via Telegram
- **Intel System** - Automatic group link scraping and auto-join queue
- **Broadcasting** - Mass message/status updates across all groups
- **Group Management** - Anti-link, anti-bot, anti-spam, auto-promote, strikes
- **Sticker Engine** - Convert images/videos to animated stickers
- **Menu System** - Dynamic command menus with AI-generated images

### Advanced Features
- **Node Mode** - Public/private command access per node
- **Ghost Protocol** - Stealth broadcasting to avoid detection
- **Queue System** - BullMQ-powered job processing with Redis
- **Rate Limiting** - Prevent spam and abuse
- **Role-Based Access** - Owner/Admin/Public command permissions
- **Memory System** - AI conversation memory per user
- **Link Preview** - Rich link previews for broadcasts
- **Voice Notes** - AI voice analysis and TTS generation

## 📋 Requirements

- **Node.js** 18+ (tested on v22.22.2)
- **MongoDB** 4.4+
- **Redis** 6.0+
- **PM2** (for process management)
- **yt-dlp** (for video downloads)
- **ffmpeg** (for media processing)

## 🛠️ Installation

### 1. Clone Repository
```bash
git clone https://github.com/yourusername/omega-v5.git
cd omega-v5
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Setup MongoDB
```bash
# Install MongoDB
sudo apt update
sudo apt install -y mongodb

# Start MongoDB
sudo systemctl start mongodb
sudo systemctl enable mongodb

# Create database user
mongosh
use admin
db.createUser({
  user: "pappybot",
  pwd: "your_secure_password",
  roles: [{ role: "readWrite", db: "PappyUltimate2" }]
})
exit
```

### 4. Setup Redis
```bash
# Install Redis
sudo apt install -y redis-server

# Configure Redis password
sudo nano /etc/redis/redis.conf
# Uncomment and set: requirepass your_redis_password

# Restart Redis
sudo systemctl restart redis
sudo systemctl enable redis
```

### 5. Install System Dependencies
```bash
# Install ffmpeg
sudo apt install -y ffmpeg

# Install yt-dlp
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### 6. Configure Environment
```bash
# Copy example env file
cp .env.example .env

# Edit with your credentials
nano .env
```

**Required Configuration:**
- `OWNER_WA_JID` - Your WhatsApp number (e.g., 2348012345678)
- `TG_BOT_TOKEN` - Get from @BotFather on Telegram
- `OWNER_TG_ID` - Your Telegram user ID (get from @userinfobot)
- `MONGO_URI` - MongoDB connection string
- `REDIS_PASSWORD` - Redis password
- At least one AI API key (DigitalOcean recommended)

### 7. Start Bot
```bash
# Using PM2 (recommended)
pm2 start ecosystem.config.js
pm2 save

# Or using Node directly
npm start
```

## 📱 Pairing WhatsApp

### Via Telegram
1. Start your Telegram bot: `/start`
2. Go to **Nodes** → **Deploy Node**
3. Enter phone number with country code (e.g., 2348012345678)
4. Check WhatsApp for pairing code
5. Enter code in WhatsApp → Linked Devices → Link with phone number

## Telegram Hub Features

### Auto-Downloader Toggle
- Open Telegram hub and tap **Auto-Downloader ON/OFF**.
- When ON, sending a supported link auto-downloads media with live progress updates.
- Supported platforms include YouTube, TikTok, Instagram, X/Twitter, Facebook, Reddit, Spotify, SoundCloud, Pinterest, Dailymotion, Vimeo, and Twitch.

### Music Finder Toggle
- Open Telegram hub and tap **Music Finder ON/OFF**.
- When ON:
- Send a song name as text to get top YouTube matches (inline buttons).
- Forward an audio file (with title/file metadata) to trigger song suggestions.
- Tap a suggested result to receive MP3 audio and lyrics.

### Extract Audio From Downloaded Video
- After auto-downloading a video, the bot shows an **Extract Audio** button.
- Tap it to fetch and send the MP3 version of that video.

## 🎮 Commands

### Public Commands
- `.menu` - Show command menu
- `.ping` - Check bot latency
- `.sys` - System stats
- `.play [song]` - Play music
- `.video [search]` - Send video
- `.tourl` - Convert media to URL
- `.tts [text]` - Text to speech

### Admin Commands (Group Admins)
- `.promote` / `.demote` - Manage admins
- `.kick` - Remove member
- `.warn` / `.warns` / `.resetwarn` - Warning system
- `.mute` / `.unmute` - Lock/unlock group
- `.antilink on/off` - Auto-delete links
- `.antibot on/off` - Auto-kick bots
- `.antispam on/off` - Spam protection
- `.updategstatus` - Update group status

### Owner Commands
- `.pappy on/off` - Toggle AI mode
- `.nodemode public/private` - Set node access mode
- `.gcast [message]` - Broadcast to all groups
- `.godcast [message]` - Stealth broadcast
- `.autojoin on/off` - Auto-join groups from links
- `.sudo [number]` - Add sudo user
- `.setprefix [symbol]` - Change command prefix

## 🤖 AI Configuration

The bot supports multiple AI providers. Configure at least one:

### DigitalOcean AI (Recommended - Free Tier)
```bash
DIGITALOCEAN_AI_KEY=your_key_here
```

### Other Providers
- **OpenRouter**: `OPENROUTER_API_KEY`
- **Qwen (Alibaba)**: `QWEN_API_KEY`
- **OpenAI**: `OPENAI_API_KEY`
- **Claude**: `ANTHROPIC_API_KEY`
- **DeepSeek**: `DEEPSEEK_API_KEY`

## 🔒 Security

### Protected Data (Gitignored)
- `.env` - Environment variables
- `data/sessions/` - WhatsApp session files
- `data/botState*.json` - Bot state files
- `data/intel.json` - Intel database
- `data/logs/` - Log files

## 📊 Monitoring

```bash
pm2 status              # Check bot status
pm2 logs omega-v5       # View logs
pm2 restart omega-v5    # Restart bot
pm2 monit               # Monitor resources
```

## 🐛 Troubleshooting

### AI Not Working
1. Check API keys in `.env`
2. Verify DigitalOcean AI key is valid
3. Check logs: `pm2 logs omega-v5 | grep AI`

### WhatsApp Disconnecting
1. Clear bad sessions: `rm -rf data/sessions/*/session-*`
2. Restart bot: `pm2 restart omega-v5`
3. Re-pair if needed

## 📄 License

MIT License

## 📞 Support

- **Telegram**: t.me/pappylung
- **Issues**: GitHub Issues

---

**Built with ❤️ by Pappy**
