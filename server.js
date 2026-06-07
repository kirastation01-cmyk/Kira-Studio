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

// Keys from env vars OR from request headers (sent by app)
function getKey(req, envName, headerName) {
  return process.env[envName] || req.headers[headerName] || '';
}

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
        // Try JSON parse, else return buffer
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

// ── STEP 1: SCRIPT WITH CLAUDE ────────────────────────────────
async function generateScript(niche, language, customPrompt, anthropicKey) {
  const langInstr = language === 'Khmer'
    ? 'Write entirely in Khmer language.'
    : language === 'English + Khmer'
    ? 'Write each scene in English. Then add Khmer translation prefixed with [KH]:'
    : 'Write in English.';

  const userPrompt = customPrompt ||
    `Write a viral 60-second faceless TikTok/YouTube Shorts script about "${niche}".
${langInstr}
Return ONLY valid JSON, no markdown, no backticks, no extra text:
{"title":"video title here","scenes":[{"en":"scene 1 text","kh":"scene 1 khmer"},{"en":"scene 2 text","kh":"scene 2 khmer"},{"en":"scene 3 text","kh":"scene 3 khmer"},{"en":"scene 4 text","kh":"scene 4 khmer"}]}`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: userPrompt }]
    }
  });

  if (res.status !== 200) {
    throw new Error('Claude API error: ' + JSON.stringify(res.body));
  }

  const content = res.body.content;
  if (!content || !content[0] || !content[0].text) {
    throw new Error('Claude returned empty response: ' + JSON.stringify(res.body));
  }

  const text = content[0].text.trim();
  // Strip any markdown code blocks if present
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  // Find JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in Claude response: ' + text);

  try {
    return JSON.parse(match[0]);
  } catch(e) {
    throw new Error('Invalid JSON from Claude: ' + match[0]);
  }
}

// ── STEP 2: VOICE WITH ELEVENLABS ─────────────────────────────
async function generateVoice(text, voiceName, jobId, elevenLabsKey) {
  // Default voice IDs — user can override these
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
      text: text.substring(0, 5000), // ElevenLabs limit safety
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
        res.on('end', () => reject(new Error('ElevenLabs error ' + res.statusCode + ': ' + Buffer.concat(chunks).toString())));
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
async function generateImage(prompt, sceneIdx, jobId, falKey) {
  const imgPath = path.join(OUT_DIR, `${jobId}_scene${sceneIdx}.jpg`);

  // Submit to fal.ai queue
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
    throw new Error('Fal.ai submit failed: ' + JSON.stringify(submit.body));
  }

  const requestId = submit.body.request_id;

  // Poll for completion
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

  throw new Error('Fal.ai timed out after 2 minutes');
}

// ── IMAGE PROMPTS PER NICHE ───────────────────────────────────
function buildPrompts(niche, scenes, style) {
  const styleMap = {
    'Cinematic': 'cinematic film still, dramatic lighting, anamorphic lens flare',
    'Horror': 'dark horror atmosphere, eerie shadows, unsettling, hyper-realistic',
    'Anime': 'anime art style, vibrant, Studio Ghibli inspired, beautiful',
    'Realistic': 'photorealistic, 8K ultra detail, professional photography'
  };
  const s = styleMap[style] || styleMap['Cinematic'];
  return scenes.map(scene =>
    `${scene.en}. ${s}. Vertical 9:16 portrait format. No text, no watermark, no people's faces.`
  );
}

// ── STEP 4: ASSEMBLE MP4 WITH FFMPEG ─────────────────────────
async function assembleVideo(jobId, imagePaths, audioPath, scenes, capMode) {
  const videoPath = path.join(OUT_DIR, `${jobId}_final.mp4`);

  // Check FFmpeg
  const hasFfmpeg = await new Promise(resolve => {
    exec('ffmpeg -version', err => resolve(!err));
  });

  if (!hasFfmpeg) {
    console.log('FFmpeg not found — creating placeholder video file');
    // Create a simple text file as placeholder so download works
    fs.writeFileSync(videoPath, JSON.stringify({
      note: 'FFmpeg not available on this server. Install FFmpeg to get real MP4 output.',
      script: scenes.map(s => s.en).join(' '),
      images: imagePaths
    }));
    return videoPath;
  }

  const segDur = 15;
  const listPath = path.join(OUT_DIR, `${jobId}_list.txt`);
  const listContent = imagePaths.map(p => `file '${p}'\nduration ${segDur}`).join('\n')
    + `\nfile '${imagePaths[imagePaths.length-1]}'`;
  fs.writeFileSync(listPath, listContent);

  // Caption filter
  let vf = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1';
  if (capMode && capMode !== 'NONE') {
    const captionParts = scenes.map((s, i) => {
      const start = i * segDur;
      const end = start + segDur;
      const txt = capMode === 'KH' ? (s.kh || s.en) : capMode === 'BOTH' ? `${s.en}` : s.en;
      const safe = (txt || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/\[/g,'\\[').replace(/\]/g,'\\]');
      return `drawtext=fontsize=28:fontcolor=white:x=(w-text_w)/2:y=h-100:text='${safe}':enable='between(t\\,${start}\\,${end})':box=1:boxcolor=black@0.6:boxborderw=6`;
    });
    vf += ',' + captionParts.join(',');
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
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { console.error('FFmpeg error:', stderr); reject(new Error('FFmpeg failed: ' + stderr.slice(-500))); }
      else resolve();
    });
  });

  try { fs.unlinkSync(listPath); } catch(e) {}
  imagePaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  try { fs.unlinkSync(audioPath); } catch(e) {}

  return videoPath;
}

// ── JOB STORE ─────────────────────────────────────────────────
const jobs = {};

// ── MAIN GENERATE ENDPOINT ────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { niche, language, voice, style, capMode, customPrompt, autoPost } = req.body;

  // Get API keys from env vars first, then headers
  const anthropicKey  = process.env.ANTHROPIC_API_KEY   || req.headers['x-anthropic-key']  || '';
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY  || req.headers['x-elevenlabs-key'] || '';
  const falKey        = process.env.FAL_API_KEY         || req.headers['x-fal-key']        || '';

  if (!anthropicKey)  return res.status(400).json({ error: 'Missing Anthropic API key' });
  if (!elevenLabsKey) return res.status(400).json({ error: 'Missing ElevenLabs API key' });
  if (!falKey)        return res.status(400).json({ error: 'Missing Fal.ai API key' });

  const jobId = 'job_' + Date.now();
  jobs[jobId] = { id: jobId, status: 'rendering', step: 'Starting...', progress: 0, createdAt: new Date().toISOString() };
  res.json({ jobId });

  // Run pipeline async
  (async () => {
    try {
      // 1. Script
      jobs[jobId].step = 'Writing script with Claude AI...';
      jobs[jobId].progress = 5;
      const script = await generateScript(niche || 'Dark Stories', language || 'English', customPrompt, anthropicKey);
      jobs[jobId].step = 'Script ready ✓';
      jobs[jobId].progress = 20;
      jobs[jobId].script = script;

      // 2. Voice
      jobs[jobId].step = 'Generating voice with ElevenLabs...';
      jobs[jobId].progress = 22;
      const fullText = script.scenes.map(s => s.en).join('. ');
      const audioPath = await generateVoice(fullText, voice || 'Marcus', jobId, elevenLabsKey);
      jobs[jobId].step = 'Voice ready ✓';
      jobs[jobId].progress = 45;

      // 3. Images (sequential to avoid rate limits)
      const prompts = buildPrompts(niche, script.scenes, style || 'Cinematic');
      const imagePaths = [];
      for (let i = 0; i < prompts.length; i++) {
        jobs[jobId].step = `Generating scene ${i+1} of 4 with Fal.ai...`;
        jobs[jobId].progress = 45 + (i * 8);
        const imgPath = await generateImage(prompts[i], i, jobId, falKey);
        imagePaths.push(imgPath);
      }
      jobs[jobId].step = 'All images ready ✓';
      jobs[jobId].progress = 80;

      // 4. Assemble
      jobs[jobId].step = 'Assembling final MP4...';
      jobs[jobId].progress = 82;
      const videoPath = await assembleVideo(jobId, imagePaths, audioPath, script.scenes, capMode || 'BOTH');

      // 5. Done
      jobs[jobId] = {
        ...jobs[jobId],
        status: 'complete',
        step: 'Done! Your video is ready.',
        progress: 100,
        title: script.title || (niche + ' Story'),
        script,
        videoUrl: '/output/' + path.basename(videoPath),
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

// ── JOB STATUS ────────────────────────────────────────────────
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// ── HEALTH CHECK ──────────────────────────────────────────────
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
  else res.json({ status: 'Kira Studio API running. Place index.html in /public folder.' });
});

app.listen(PORT, () => console.log(`Kira Studio server running on port ${PORT}`));
