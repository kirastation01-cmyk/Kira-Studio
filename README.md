# Kira Studio — Full Automation Setup Guide
# ==========================================
# Read this fully before starting. Takes ~30 minutes.

## WHAT YOU GET
- Real AI script (Claude)
- Real AI voice (ElevenLabs)  
- Real AI images (Fal.ai)
- Real MP4 video assembled by FFmpeg
- Auto-post to TikTok + YouTube (optional)
- Cost: ~$0.04 per video

---

## STEP 1: GET YOUR API KEYS

### A. Anthropic (Claude — script writing)
1. Go to https://console.anthropic.com
2. Sign up → Verify email
3. Go to API Keys → Create Key
4. Copy it — looks like: sk-ant-api03-xxx...
5. Add $5 credit to start

### B. ElevenLabs (AI Voice)
1. Go to https://elevenlabs.io
2. Sign up → Go to Profile Settings
3. Copy your API Key (under "API Key")
4. Subscribe to Creator plan ($22/mo) for API access
5. Go to Voices tab → note your voice IDs for Marcus, Adam, Rachel, Bella
   (Replace the placeholder IDs in server.js lines 71-76)

### C. Fal.ai (AI Images)
1. Go to https://fal.ai
2. Sign up → Dashboard → Keys
3. Create new key → Copy it
4. Add $5 credit (lasts ~250 videos)

### D. TikTok (Auto-post — optional, do later)
1. Go to https://developers.tiktok.com
2. Create app → Add "Content Posting API"
3. Get OAuth access token for your account
4. NOTE: TikTok requires app review for posting — takes 1-2 weeks

### E. YouTube (Auto-post — optional, do later)
1. Go to https://console.cloud.google.com
2. Create project → Enable "YouTube Data API v3"
3. Create OAuth 2.0 credentials → Get refresh token
4. Use oauth2l or Google's OAuth Playground to get access token

---

## STEP 2: DEPLOY THE BACKEND TO RENDER.COM

1. Create a GitHub account if you don't have one: https://github.com
2. Create a new repository called "kira-studio"
3. Upload these files to GitHub:
   - server.js
   - package.json
   - public/index.html (create public folder first)

4. Go to https://render.com → Sign up
5. Click "New" → "Web Service"
6. Connect your GitHub account → Select kira-studio repo
7. Settings:
   - Name: kira-studio
   - Runtime: Node
   - Build Command: npm install
   - Start Command: node server.js
   - Plan: Free (or $7/mo for always-on)

8. IMPORTANT — Add Environment Variables in Render dashboard:
   - ANTHROPIC_API_KEY = your-key
   - ELEVENLABS_API_KEY = your-key  
   - FAL_API_KEY = your-key
   - TIKTOK_ACCESS_TOKEN = your-token (optional)
   - YOUTUBE_ACCESS_TOKEN = your-token (optional)

9. Click Deploy → Wait ~3 minutes
10. Your URL will be: https://kira-studio-xxxx.onrender.com

---

## STEP 3: INSTALL FFMPEG ON RENDER

Add this to your package.json under "scripts":
  "postinstall": "apt-get install -y ffmpeg || true"

Or use the Render "Docker" deployment with this Dockerfile:
  FROM node:18
  RUN apt-get update && apt-get install -y ffmpeg
  WORKDIR /app
  COPY . .
  RUN npm install
  CMD ["node", "server.js"]

---

## STEP 4: OPEN THE APP

The app (public/index.html) opens at your Render URL.
Or open it locally by double-clicking index.html.

1. Open the app → go to Setup tab
2. Paste your Render URL: https://kira-studio-xxxx.onrender.com
3. Paste your API keys
4. Tap "Check Connection" — should show all green

---

## STEP 5: MAKE YOUR FIRST VIDEO

1. Go to Create tab
2. Select: Dark Stories, English + Khmer, Marcus voice, Cinematic style
3. Tap "Generate & Render Video"
4. Watch the progress bar (~3-5 minutes for first video)
5. Go to Projects tab → tap your video → tap Play
6. Download your real MP4

---

## MONTHLY COSTS (realistic)

3 videos/day:
- ElevenLabs Creator: $22/mo
- Fal.ai images: ~$1.80/mo
- Anthropic Claude: ~$0.27/mo  
- Render hosting: $0 (free) or $7/mo (always-on)
- TOTAL: ~$24-31/month

Expected earnings at 3 videos/day:
- Month 1-2: $0-30 (building audience)
- Month 3-4: $50-150
- Month 6+: $200-600
- ROI: 7-20× your cost

---

## TROUBLESHOOTING

"Cannot reach server" → Server may be sleeping (free tier). Open your 
  Render URL directly in browser to wake it up, then try again.

"Voice generation failed" → Check ElevenLabs key and replace voice IDs 
  in server.js lines 71-76 with your actual ElevenLabs voice IDs.

"Image generation timed out" → Fal.ai sometimes takes >60 seconds. 
  Increase timeout or retry.

"FFmpeg not found" → Use Docker deployment (see Step 3).

Auto-post not working → TikTok requires app review. Start with manual 
  download + post while waiting for approval.

---

## SUPPORT

Agent tab in the app for video editing help.
For server issues, check Render logs in the dashboard.
