const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, 'output')));

const PORT = process.env.PORT || 3000;
const OUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Keep-alive ping to prevent Render free tier from sleeping during job
function keepAlive(jobObj) {
  const iv = setInterval(() => {
    if (jobObj.status !== 'rendering') clearInterval(iv);
    // just touch the job object to keep process alive
    jobObj._ping = Date.now();
  }, 20000);
  return iv;
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      method: options.method || 'GET', headers: options.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), buffer: raw }); }
        catch(e) { resolve({ status: res.statusCode, body: raw.toString(), buffer: raw }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Dark fallback images (used if AI generation fails)
const FALLBACKS = [
  'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1509248961158-e54f6934749c?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1505322715561-75cf4ca08175?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1504701954957-2010ec3bcec1?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1546484958-6544e8e5c0b1?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1478358161113-b0e11994a36b?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1542281286-9e0a16bb7366?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1516410529446-2c777cb7366d?w=576&h=1024&fit=crop&q=80',
  'https://images.unsplash.com/photo-1519074002996-a69e7ac46a42?w=576&h=1024&fit=crop&q=80'
];

const NICHE_STYLE = {
  'Dark Stories':      'dark horror cinematic, eerie shadows, abandoned place, moonlight, terrifying atmosphere, no people',
  'True Crime':        'dark documentary style, crime scene, noir lighting, gritty realism, dramatic shadows',
  'Khmer Legends':     'ancient Cambodian temple ruins, supernatural mist, golden glow, mystical night atmosphere',
  'Motivational':      'dramatic sunrise, silhouette, golden light, inspiring, cinematic wide shot',
  'Facts & Lore':      'ancient mystery, dramatic archaeological lighting, cinematic documentary atmosphere',
  'Relationship Drama':'moody cinematic, rain, city lights, emotional drama, film still'
};

// ── SCRIPT ────────────────────────────────────────────────────
async function generateScript(niche, language, customPrompt, anthropicKey) {
  const langInstr = language === 'English + Khmer'
    ? 'Write English in en field. Write Khmer translation in kh field.'
    : language === 'Khmer' ? 'Write English in en. Write Khmer in kh.'
    : 'English in en. Empty string in kh.';

  const storyGuides = {
    'Dark Stories': 'A terrifying paranormal story. Slow dread build. Real sensory details — cold air, strange sounds, shadows. First person. Shocking twist ending.',
    'True Crime': 'A chilling true crime mystery. Specific fake-realistic details: dates, places. Podcast style narration. Unsolved ending.',
    'Khmer Legends': 'Cambodian supernatural folklore. Reference Angkor Wat, Tonle Sap, Phnom Penh. Ancient spirit meets modern day. Haunting ending.',
    'Motivational': 'Rags to riches story. Specific real-feeling struggles and numbers. Earned success. Actionable ending.',
    'Facts & Lore': 'Mind-blowing mystery facts. Each scene more shocking. Changes how you see the world.',
    'Relationship Drama': 'Emotional relationship story. Specific realistic details. Every emotion felt. Shocking revelation at end.'
  };

  const guide = storyGuides[niche] || storyGuides['Dark Stories'];
  const prompt = customPrompt || `Write a viral 3-minute TikTok script about "${niche}". ${guide}

${langInstr}

Rules:
- EXACTLY 10 scenes
- Each scene: 35-45 words. Rich storytelling, not bullet points.
- Scene 1: Hook that stops scrolling in 2 seconds
- Scenes 2-4: Set atmosphere with specific sensory details
- Scenes 5-7: Escalation, something goes wrong
- Scenes 8-9: Terrifying truth revealed
- Scene 10: Twist + "Follow for more scary stories"

Return ONLY JSON:
{"title":"Short catchy title","scenes":[{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"},{"en":"scene text","kh":"khmer"}]}`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-haiku-4-5', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }
  });

  if (res.status !== 200) throw new Error('Claude error ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200));
  const content = res.body.content;
  if (!content || !content[0] || !content[0].text) throw new Error('Claude empty response');

  const text = content[0].text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude: ' + text.slice(0, 200));

  const parsed = JSON.parse(match[0]);
  if (!parsed.scenes || parsed.scenes.length < 4) throw new Error('Too few scenes: ' + parsed.scenes?.length);

  while (parsed.scenes.length < 10) parsed.scenes.push(parsed.scenes[parsed.scenes.length - 1]);
  parsed.scenes = parsed.scenes.slice(0, 10);
  return parsed;
}

// ── VOICE ─────────────────────────────────────────────────────
async function generateVoice(text, voiceName, jobId, elevenLabsKey) {
  const voiceIds = {
    'Marcus': 'AZnzlk1XvdvUeBnXmlld',
    'Adam':   'pNInz6obpgDQGcFmaJgB',
    'Rachel': '21m00Tcm4TlvDq8ikWAM',
    'Bella':  'EXAVITQu4vr4xnSDxMaL'
  };
  const voiceId = voiceIds[voiceName] || voiceIds['Marcus'];
  const audioPath = path.join(OUT_DIR, `${jobId}_voice.mp3`);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: text.substring(0, 4800),
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true }
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': elevenLabsKey, 'Accept': 'audio/mpeg' }
    }, res => {
      if (res.statusCode !== 200) {
        const c = []; res.on('data', x => c.push(x));
        res.on('end', () => reject(new Error('ElevenLabs ' + res.statusCode + ': ' + Buffer.concat(c).toString().slice(0, 200))));
        return;
      }
      const file = fs.createWriteStream(audioPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(audioPath)));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SINGLE IMAGE with timeout + fallback ──────────────────────
async function generateOneImage(prompt, imgIdx, jobId, falKey) {
  const imgPath = path.join(OUT_DIR, `${jobId}_img${imgIdx}.jpg`);

  // Try fal.ai with 45 second timeout
  try {
    const result = await Promise.race([
      tryFalImage(prompt, imgPath, falKey),
      sleep(45000).then(() => { throw new Error('45s timeout'); })
    ]);
    return result;
  } catch(err) {
    console.log(`Image ${imgIdx} failed (${err.message}) — using fallback`);
    await downloadFile(FALLBACKS[imgIdx % FALLBACKS.length], imgPath);
    return imgPath;
  }
}

async function tryFalImage(prompt, imgPath, falKey) {
  // Use fast sync endpoint
  const res = await httpRequest('https://fal.run/fal-ai/fast-lightning-sdxl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
    body: { prompt, image_size: 'portrait_4_3', num_inference_steps: 4, num_images: 1 }
  });

  if (res.body && res.body.images && res.body.images[0] && res.body.images[0].url) {
    await downloadFile(res.body.images[0].url, imgPath);
    return imgPath;
  }

  // Try flux/schnell queue
  const submit = await httpRequest('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
    body: { prompt, image_size: { width: 432, height: 768 }, num_inference_steps: 4, num_images: 1, enable_safety_checker: false }
  });

  if (!submit.body || !submit.body.request_id) throw new Error('No request_id');

  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const s = await httpRequest(
      `https://queue.fal.run/fal-ai/flux/schnell/requests/${submit.body.request_id}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );
    if (s.body && s.body.status === 'COMPLETED') {
      const url = s.body.output?.images?.[0]?.url;
      if (!url) throw new Error('No image URL');
      await downloadFile(url, imgPath);
      return imgPath;
    }
    if (s.body && s.body.status === 'FAILED') throw new Error('Fal job failed');
  }
  throw new Error('Poll timeout');
}

// ── GENERATE ALL 10 IMAGES IN PARALLEL (much faster) ─────────
async function generateAllImages(niche, scenes, style, jobId, falKey, jobObj) {
  const nicheStyle = NICHE_STYLE[niche] || NICHE_STYLE['Dark Stories'];
  const styleExtra = style === 'Horror' ? 'extreme horror, terrifying' : style === 'Anime' ? 'anime art style' : style === 'Realistic' ? 'photorealistic 8K' : 'cinematic film still';

  const prompts = scenes.map((scene, i) => {
    const visual = scene.en.split('.')[0].substring(0, 100);
    return `${visual}. ${nicheStyle}. ${styleExtra}. Vertical portrait. No text no watermark.`;
  });

  // Generate all 10 in parallel — ~45s total instead of 5 minutes sequential
  jobObj.step = 'Generating all 10 scene images in parallel...';
  const promises = prompts.map((p, i) => generateOneImage(p, i, jobId, falKey));
  const imagePaths = await Promise.all(promises);

  const aiCount = imagePaths.length;
  jobObj.step = `✓ All ${aiCount} images ready`;
  jobObj.progress = 77;
  return imagePaths;
}

// ── ASSEMBLE VIDEO ────────────────────────────────────────────
async function assembleVideo(jobId, imagePaths, audioPath, scenes, capMode) {
  const videoPath = path.join(OUT_DIR, `${jobId}_final.mp4`);

  const hasFfmpeg = await new Promise(resolve => { exec('ffmpeg -version', err => resolve(!err)); });
  if (!hasFfmpeg) {
    fs.writeFileSync(videoPath, JSON.stringify({ note: 'FFmpeg not installed', scenes: scenes.map(s => s.en) }));
    return videoPath;
  }

  // Get actual audio duration
  const audioDuration = await new Promise(resolve => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, (err, stdout) => {
      const d = parseFloat(stdout);
      resolve(isNaN(d) ? 180 : d);
    });
  });
  console.log(`Audio duration: ${audioDuration.toFixed(1)}s`);

  const segDur = audioDuration / scenes.length;
  const listPath = path.join(OUT_DIR, `${jobId}_list.txt`);

  let list = '';
  for (let i = 0; i < scenes.length; i++) {
    const img = imagePaths[i] || imagePaths[imagePaths.length - 1];
    list += `file '${img}'\nduration ${segDur.toFixed(3)}\n`;
  }
  list += `file '${imagePaths[imagePaths.length - 1]}'`;
  fs.writeFileSync(listPath, list);

  let vf = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1';

  if (capMode && capMode !== 'NONE') {
    const filters = scenes.map((s, i) => {
      const t0 = (i * segDur).toFixed(2);
      const t1 = ((i + 1) * segDur).toFixed(2);

      // Split caption into max 2 lines of 30 chars each
      const words = (capMode === 'KH' ? (s.kh || s.en) : s.en).split(' ');
      let lines = [], line = '';
      words.forEach(w => {
        if ((line + ' ' + w).trim().length > 30) { lines.push(line.trim()); line = w; }
        else line = (line + ' ' + w).trim();
      });
      if (line) lines.push(line.trim());
      const capText = lines.slice(0, 2).join('\n');
      const safe = capText.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&').replace(/,/g,'\\,');

      let f = `drawtext=fontsize=26:fontcolor=white:x=(w-text_w)/2:y=h*0.82:text='${safe}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.65:boxborderw=10`;

      if (capMode === 'BOTH' && s.kh) {
        const khShort = s.kh.split('.')[0].substring(0, 60);
        const safekh = khShort.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&').replace(/,/g,'\\,');
        f += `,drawtext=fontsize=19:fontcolor=#FFD700:x=(w-text_w)/2:y=h*0.90:text='${safekh}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.55:boxborderw=7`;
      }
      return f;
    });
    vf += ',' + filters.join(',');
  }

  const cmd = [
    'ffmpeg -y',
    `-f concat -safe 0 -i "${listPath}"`,
    `-i "${audioPath}"`,
    `-vf "${vf}"`,
    '-c:v libx264 -preset ultrafast -crf 24',
    '-c:a aac -b:a 128k',
    '-map 0:v -map 1:a -shortest -pix_fmt yuv420p',
    `"${videoPath}"`
  ].join(' ');

  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 300000 }, (err, so, se) => {
      if (err) { reject(new Error('FFmpeg: ' + se.slice(-400))); }
      else resolve();
    });
  });

  try { fs.unlinkSync(listPath); } catch(e) {}
  imagePaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  try { fs.unlinkSync(audioPath); } catch(e) {}
  return videoPath;
}

// ── JOBS ──────────────────────────────────────────────────────
const jobs = {};

app.post('/api/generate', async (req, res) => {
  const { niche, language, voice, style, capMode, customPrompt } = req.body;
  const anthropicKey  = process.env.ANTHROPIC_API_KEY  || req.headers['x-anthropic-key']  || '';
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY || req.headers['x-elevenlabs-key'] || '';
  const falKey        = process.env.FAL_API_KEY        || req.headers['x-fal-key']        || '';

  if (!anthropicKey)  return res.status(400).json({ error: 'Missing Anthropic API key' });
  if (!elevenLabsKey) return res.status(400).json({ error: 'Missing ElevenLabs API key' });
  if (!falKey)        return res.status(400).json({ error: 'Missing Fal.ai API key' });

  const jobId = 'job_' + Date.now();
  const jobObj = { id: jobId, status: 'rendering', step: 'Starting...', progress: 0, createdAt: new Date().toISOString() };
  jobs[jobId] = jobObj;
  res.json({ jobId });

  const aliveInterval = keepAlive(jobObj);

  (async () => {
    try {
      // 1. Script
      jobObj.step = 'Writing story with Claude...'; jobObj.progress = 3;
      const script = await generateScript(niche || 'Dark Stories', language || 'English', customPrompt, anthropicKey);
      jobObj.step = `✓ Script ready — ${script.scenes.length} scenes`; jobObj.progress = 15; jobObj.script = script;

      // 2. Voice + Images IN PARALLEL (saves 1-2 minutes)
      jobObj.step = 'Generating voice + images simultaneously...'; jobObj.progress = 17;
      const fullText = script.scenes.map(s => s.en).join(' ... ');

      const [audioPath, imagePaths] = await Promise.all([
        generateVoice(fullText, voice || 'Marcus', jobId, elevenLabsKey),
        generateAllImages(niche, script.scenes, style || 'Cinematic', jobId, falKey, jobObj)
      ]);

      jobObj.step = '✓ Voice and images ready'; jobObj.progress = 80;

      // 3. Assemble
      jobObj.step = 'Assembling final video...'; jobObj.progress = 82;
      const videoPath = await assembleVideo(jobId, imagePaths, audioPath, script.scenes, capMode || 'BOTH');

      clearInterval(aliveInterval);
      const wordCount = script.scenes.map(s => s.en.split(' ').length).reduce((a, b) => a + b, 0);
      Object.assign(jobObj, {
        status: 'complete',
        step: `✓ Done! ${script.scenes.length} scenes — ~${Math.round(wordCount / 150)} min video`,
        progress: 100,
        title: script.title || (niche + ' Story'),
        script,
        videoUrl: '/output/' + path.basename(videoPath),
        wordCount,
        completedAt: new Date().toISOString()
      });

    } catch(err) {
      clearInterval(aliveInterval);
      console.error('Job failed:', err.message);
      Object.assign(jobObj, { status: 'failed', step: 'Error: ' + err.message, progress: 0 });
    }
  })();
});

app.get('/api/job/:id', (req, res) => {
  const j = jobs[req.params.id];
  j ? res.json(j) : res.status(404).json({ error: 'Not found' });
});
app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: 'v5-parallel',
    hasAnthropicKey:  !!process.env.ANTHROPIC_API_KEY,
    hasElevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
    hasFalKey:        !!process.env.FAL_API_KEY,
    hasTikTokToken:   !!process.env.TIKTOK_ACCESS_TOKEN,
    hasYouTubeToken:  !!process.env.YOUTUBE_ACCESS_TOKEN,
    timestamp: new Date().toISOString()
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.json({ status: 'Kira Studio v5 running' });
});

app.listen(PORT, () => console.log(`Kira Studio v5 running on port ${PORT}`));
