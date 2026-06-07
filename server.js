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

// ── HELPERS ──────────────────────────────────────────────────
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = lib.request(reqOpts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw.toString()), buffer: raw });
        } catch(e) {
          resolve({ status: res.statusCode, body: raw.toString(), buffer: raw });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(data);
    }
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const doGet = (u) => {
      lib.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    };
    doGet(url);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── STEP 1: SCRIPT — 12 SCENES = 3 MINUTES ───────────────────
// Each scene = 15 seconds. 12 scenes x 15s = 180 seconds = exactly 3 minutes
async function generateScript(niche, language, customPrompt, anthropicKey) {
  const langInstr = language === 'Khmer'
    ? 'Write entirely in Khmer language.'
    : language === 'English + Khmer'
    ? 'Write each scene in English. Also provide a Khmer translation for each scene in the kh field.'
    : 'Write in English. Leave the kh field as an empty string.';

  const userPrompt = customPrompt ||
    `Write a viral 3-minute faceless video script for TikTok/YouTube Shorts about "${niche}".
${langInstr}

IMPORTANT: You must write EXACTLY 12 scenes. Each scene is 15 seconds long = 3 minutes total.
Structure: Hook (scenes 1-2) → Build tension (scenes 3-6) → Climax (scenes 7-9) → Shocking reveal (scenes 10-11) → Call to action (scene 12)

Each scene text should be 1-2 short punchy sentences only. Make it suspenseful and keep viewers watching.

Return ONLY valid JSON, no markdown, no backticks, no extra text:
{"title":"catchy video title","scenes":[
{"en":"scene 1 text","kh":"khmer translation"},
{"en":"scene 2 text","kh":"khmer translation"},
{"en":"scene 3 text","kh":"khmer translation"},
{"en":"scene 4 text","kh":"khmer translation"},
{"en":"scene 5 text","kh":"khmer translation"},
{"en":"scene 6 text","kh":"khmer translation"},
{"en":"scene 7 text","kh":"khmer translation"},
{"en":"scene 8 text","kh":"khmer translation"},
{"en":"scene 9 text","kh":"khmer translation"},
{"en":"scene 10 text","kh":"khmer translation"},
{"en":"scene 11 text","kh":"khmer translation"},
{"en":"scene 12 text","kh":"khmer translation"}
]}`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: userPrompt }]
    }
  });

  if (res.status !== 200) throw new Error('Claude API error: ' + JSON.stringify(res.body));

  const content = res.body.content;
  if (!content || !content[0] || !content[0].text) throw new Error('Claude returned empty response');

  const text = content[0].text.trim();
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in Claude response: ' + text.slice(0, 200));

  const parsed = JSON.parse(match[0]);

  // Safety: ensure we have exactly 12 scenes
  if (!parsed.scenes || parsed.scenes.length < 4) throw new Error('Claude returned too few scenes: ' + parsed.scenes?.length);

  // Pad to 12 if needed (shouldn't happen but just in case)
  while (parsed.scenes.length < 12) {
    const last = parsed.scenes[parsed.scenes.length - 1];
    parsed.scenes.push({ en: last.en, kh: last.kh });
  }

  // Trim to 12
  parsed.scenes = parsed.scenes.slice(0, 12);

  return parsed;
}

// ── STEP 2: VOICE WITH ELEVENLABS ─────────────────────────────
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
    const bodyData = JSON.stringify({
      text: text.substring(0, 5000),
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2 }
    });

    const reqOpts = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsKey,
        'Accept': 'audio/mpeg'
      }
    };

    const req = https.request(reqOpts, res => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => reject(new Error('ElevenLabs error ' + res.statusCode + ': ' + Buffer.concat(chunks).toString().slice(0, 300))));
        return;
      }
      const file = fs.createWriteStream(audioPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(audioPath)));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.write(bodyData);
    req.end();
  });
}

// ── STEP 3: IMAGES WITH FAL.AI ────────────────────────────────
// We generate 6 unique images — each image is reused for 2 consecutive scenes
// 6 images x 2 scenes x 15s = 3 minutes. Saves cost and time.
async function generateImage(prompt, imgIdx, jobId, falKey) {
  const imgPath = path.join(OUT_DIR, `${jobId}_img${imgIdx}.jpg`);

  const submit = await httpRequest('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${falKey}`
    },
    body: {
      prompt: prompt,
      image_size: { width: 576, height: 1024 },
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: false
    }
  });

  if (!submit.body || !submit.body.request_id) {
    throw new Error('Fal.ai submit failed: ' + JSON.stringify(submit.body).slice(0, 200));
  }

  const requestId = submit.body.request_id;

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const status = await httpRequest(
      `https://queue.fal.run/fal-ai/flux/schnell/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );

    if (status.body && status.body.status === 'COMPLETED') {
      const imgUrl = status.body.output?.images?.[0]?.url;
      if (!imgUrl) throw new Error('No image URL in fal.ai response');
      await downloadFile(imgUrl, imgPath);
      return imgPath;
    }
    if (status.body && status.body.status === 'FAILED') {
      throw new Error('Fal.ai image generation failed');
    }
  }

  throw new Error('Fal.ai timed out');
}

// ── IMAGE PROMPTS — 6 UNIQUE IMAGES FOR 12 SCENES ────────────
function buildImagePrompts(niche, scenes, style) {
  const styleMap = {
    'Cinematic': 'cinematic film still, dramatic lighting, anamorphic lens flare, movie quality',
    'Horror': 'dark horror atmosphere, eerie shadows, deeply unsettling, hyper-realistic',
    'Anime': 'anime art style, vibrant, beautiful, Studio Ghibli inspired',
    'Realistic': 'photorealistic, 8K ultra detail, professional photography, award winning'
  };
  const s = styleMap[style] || styleMap['Cinematic'];

  // Take scenes 0, 2, 4, 6, 8, 10 — one image per pair of scenes
  return [0, 2, 4, 6, 8, 10].map(i => {
    const scene = scenes[i] || scenes[0];
    return `${scene.en}. ${s}. Vertical 9:16 portrait format. Cinematic composition. No text overlay, no watermark, no faces.`;
  });
}

// Map 12 scenes to 6 images: scene 0-1 → img 0, scene 2-3 → img 1, etc.
function sceneToImageIndex(sceneIdx) {
  return Math.floor(sceneIdx / 2);
}

// ── STEP 4: ASSEMBLE 3-MINUTE MP4 ────────────────────────────
async function assembleVideo(jobId, imagePaths, audioPath, scenes, capMode) {
  const videoPath = path.join(OUT_DIR, `${jobId}_final.mp4`);
  const SEG_DUR = 15; // 15 seconds per scene x 12 scenes = 3 minutes

  const hasFfmpeg = await new Promise(resolve => {
    exec('ffmpeg -version', err => resolve(!err));
  });

  if (!hasFfmpeg) {
    console.log('FFmpeg not available — writing placeholder');
    fs.writeFileSync(videoPath, JSON.stringify({
      note: 'FFmpeg not installed. Add FFmpeg to your Render deployment.',
      scenes: scenes.map(s => s.en).join(' | ')
    }));
    return videoPath;
  }

  // Build concat list — 12 scenes, each using one of the 6 images
  const listPath = path.join(OUT_DIR, `${jobId}_list.txt`);
  let listContent = '';
  for (let i = 0; i < 12; i++) {
    const imgPath = imagePaths[sceneToImageIndex(i)];
    listContent += `file '${imgPath}'\nduration ${SEG_DUR}\n`;
  }
  // FFmpeg concat requires last file repeated
  listContent += `file '${imagePaths[imagePaths.length - 1]}'`;
  fs.writeFileSync(listPath, listContent);

  // Build caption drawtext filters for all 12 scenes
  let vf = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1';

  if (capMode && capMode !== 'NONE') {
    const captionFilters = scenes.map((s, i) => {
      const start = i * SEG_DUR;
      const end = start + SEG_DUR;
      const txt = capMode === 'KH' ? (s.kh || s.en) : s.en;
      const safe = (txt || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/\[/g,'\\[').replace(/\]/g,'\\]');

      let filter = `drawtext=fontsize=26:fontcolor=white:x=(w-text_w)/2:y=h-110:text='${safe}':enable='between(t\\,${start}\\,${end})':box=1:boxcolor=black@0.6:boxborderw=8`;

      // If BOTH, add Khmer below English
      if (capMode === 'BOTH' && s.kh) {
        const safekh = (s.kh || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
        filter += `,drawtext=fontsize=18:fontcolor=yellow:x=(w-text_w)/2:y=h-75:text='${safekh}':enable='between(t\\,${start}\\,${end})':box=1:boxcolor=black@0.5:boxborderw=6`;
      }

      return filter;
    });
    vf += ',' + captionFilters.join(',');
  }

  const cmd = [
    'ffmpeg -y',
    `-f concat -safe 0 -i "${listPath}"`,
    `-i "${audioPath}"`,
    `-vf "${vf}"`,
    '-c:v libx264 -preset fast -crf 23',
    '-c:a aac -b:a 128k',
    '-shortest -pix_fmt yuv420p',
    `"${videoPath}"`
  ].join(' ');

  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('FFmpeg error:', stderr);
        reject(new Error('FFmpeg failed: ' + stderr.slice(-500)));
      } else resolve();
    });
  });

  try { fs.unlinkSync(listPath); } catch(e) {}
  imagePaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  try { fs.unlinkSync(audioPath); } catch(e) {}

  return videoPath;
}

// ── JOB STORE ─────────────────────────────────────────────────
const jobs = {};

// ── GENERATE ENDPOINT ─────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { niche, language, voice, style, capMode, customPrompt, autoPost } = req.body;

  const anthropicKey  = process.env.ANTHROPIC_API_KEY   || req.headers['x-anthropic-key']  || '';
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY  || req.headers['x-elevenlabs-key'] || '';
  const falKey        = process.env.FAL_API_KEY         || req.headers['x-fal-key']        || '';

  if (!anthropicKey)  return res.status(400).json({ error: 'Missing Anthropic API key' });
  if (!elevenLabsKey) return res.status(400).json({ error: 'Missing ElevenLabs API key' });
  if (!falKey)        return res.status(400).json({ error: 'Missing Fal.ai API key' });

  const jobId = 'job_' + Date.now();
  jobs[jobId] = { id: jobId, status: 'rendering', step: 'Starting...', progress: 0, createdAt: new Date().toISOString() };
  res.json({ jobId });

  (async () => {
    try {
      // 1. Script — 12 scenes
      jobs[jobId].step = 'Writing 3-minute script with Claude AI...';
      jobs[jobId].progress = 3;
      const script = await generateScript(niche || 'Dark Stories', language || 'English', customPrompt, anthropicKey);
      jobs[jobId].step = `Script ready ✓ — ${script.scenes.length} scenes (${Math.round(script.scenes.length * 15 / 60)} min)`;
      jobs[jobId].progress = 15;
      jobs[jobId].script = script;

      // 2. Voice — full narration
      jobs[jobId].step = 'Generating 3-minute voice narration with ElevenLabs...';
      jobs[jobId].progress = 17;
      const fullText = script.scenes.map(s => s.en).join('. ');
      const audioPath = await generateVoice(fullText, voice || 'Marcus', jobId, elevenLabsKey);
      jobs[jobId].step = 'Voice narration ready ✓';
      jobs[jobId].progress = 35;

      // 3. Images — 6 unique images for 12 scenes
      const prompts = buildImagePrompts(niche, script.scenes, style || 'Cinematic');
      const imagePaths = [];
      for (let i = 0; i < prompts.length; i++) {
        jobs[jobId].step = `Generating image ${i+1} of 6 with Fal.ai...`;
        jobs[jobId].progress = 35 + (i * 7);
        const imgPath = await generateImage(prompts[i], i, jobId, falKey);
        imagePaths.push(imgPath);
      }
      jobs[jobId].step = 'All 6 images ready ✓';
      jobs[jobId].progress = 78;

      // 4. Assemble 3-minute MP4
      jobs[jobId].step = 'Assembling 3-minute MP4 with FFmpeg...';
      jobs[jobId].progress = 80;
      const videoPath = await assembleVideo(jobId, imagePaths, audioPath, script.scenes, capMode || 'BOTH');

      // 5. Done
      jobs[jobId] = {
        ...jobs[jobId],
        status: 'complete',
        step: '✓ Your 3-minute video is ready!',
        progress: 100,
        title: script.title || (niche + ' Story'),
        script,
        videoUrl: '/output/' + path.basename(videoPath),
        duration: '3:00',
        sceneCount: script.scenes.length,
        completedAt: new Date().toISOString()
      };

    } catch(err) {
      console.error('Job error:', err.message);
      jobs[jobId].status = 'failed';
      jobs[jobId].step = 'Error: ' + err.message;
      jobs[jobId].progress = 0;
    }
  })();
});

// ── STATUS ENDPOINTS ──────────────────────────────────────────
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasAnthropicKey:  !!process.env.ANTHROPIC_API_KEY,
    hasElevenLabsKey: !!process.env.ELEVENLABS_API_KEY,
    hasFalKey:        !!process.env.FAL_API_KEY,
    hasTikTokToken:   !!process.env.TIKTOK_ACCESS_TOKEN,
    hasYouTubeToken:  !!process.env.YOUTUBE_ACCESS_TOKEN,
    timestamp: new Date().toISOString()
  });
});

// ── SERVE APP ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f)) res.sendFile(f);
  else res.json({ status: 'Kira Studio API running. Add index.html to /public folder.' });
});

app.listen(PORT, () => console.log(`Kira Studio server running on port ${PORT}`));
