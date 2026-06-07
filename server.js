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

// ── NICHE STYLES FOR PROMPTS ──────────────────────────────────
const NICHE_IMAGE_STYLE = {
  'Dark Stories':     'dark cinematic horror atmosphere, deep shadows, eerie moonlight, abandoned setting, photorealistic, unsettling',
  'True Crime':       'dark documentary cinematic style, crime scene lighting, gritty realism, noir atmosphere, photorealistic',
  'Khmer Legends':    'ancient Cambodian temple ruins at night, supernatural golden glow, mystical fog, Angkor Wat style, atmospheric',
  'Motivational':     'cinematic sunrise, dramatic golden light, silhouette of person, inspiring, professional photography',
  'Facts & Lore':     'ancient ruins, dramatic archaeological lighting, cinematic documentary, mysterious atmosphere',
  'Relationship Drama':'cinematic emotional drama, rain on city street, moody lighting, romantic tension, film still'
};

// ── SCRIPT: REAL STORYTELLING, ~450 WORDS = 3 MINUTES ────────
// At natural narration pace: ~150 words/min x 3 min = 450 words
// 10 scenes, each ~45 words = rich storytelling, not just 1 sentence
async function generateScript(niche, language, customPrompt, anthropicKey) {
  const langInstr = language === 'English + Khmer'
    ? 'Write the en field in English. Write kh field as Khmer translation of the same text.'
    : language === 'Khmer'
    ? 'Write en field in English and kh field in Khmer.'
    : 'Write en field in English. Leave kh as empty string.';

  const nicheGuide = {
    'Dark Stories': 'A terrifying, atmospheric ghost or paranormal story. Build dread slowly. Use real sensory details — sounds, smells, feelings. Make the listener feel like it happened to a real person. End with a shocking twist.',
    'True Crime': 'A real-feeling true crime story with a mysterious unsolved element. Use specific fake-but-realistic details like dates, locations, names. Build tension like a true crime podcast.',
    'Khmer Legends': 'A Cambodian supernatural legend or folklore story. Reference real Cambodian locations like Angkor Wat, Tonle Sap, Phnom Penh. Mix ancient spirits with modern setting for maximum impact.',
    'Motivational': 'A powerful rags-to-riches personal story. Be specific with struggles and numbers. Make it feel real and earned. End with actionable inspiration.',
    'Facts & Lore': 'Mind-blowing facts about a mysterious topic. Each scene reveals something more shocking than the last. End with the most incredible fact that changes how you see everything.',
    'Relationship Drama': 'A deeply emotional relationship story with a shocking twist. Use specific realistic details. Make the listener feel every emotion. End with a revelation.'
  };

  const guide = nicheGuide[niche] || nicheGuide['Dark Stories'];

  const prompt = customPrompt ||
    `You are a viral TikTok/YouTube Shorts scriptwriter. Write a 3-minute faceless video script about "${niche}".

STORYTELLING STYLE: ${guide}

${langInstr}

CRITICAL REQUIREMENTS:
- Write EXACTLY 10 scenes
- Each scene must be 40-50 words long (this is critical for 3-minute length)
- Write like you are telling a story to a friend at 2am — personal, scary, gripping
- Use "I" or "she" or "he" perspective for immersion
- Each scene ends with a hook that makes you NEED to hear the next one
- NO generic filler. Every sentence must build tension or reveal something
- Scene 1: Shocking hook that stops the scroll in 3 seconds
- Scenes 2-4: Set the scene with specific creepy details
- Scenes 5-7: Things escalate, something goes very wrong
- Scenes 8-9: The terrifying truth is revealed
- Scene 10: The twist ending + "follow for more" CTA

Return ONLY valid JSON, no markdown, no explanation:
{"title":"Catchy scary title under 8 words","scenes":[
{"en":"40-50 word scene 1 text here","kh":"khmer translation"},
{"en":"40-50 word scene 2 text here","kh":"khmer translation"},
{"en":"40-50 word scene 3 text here","kh":"khmer translation"},
{"en":"40-50 word scene 4 text here","kh":"khmer translation"},
{"en":"40-50 word scene 5 text here","kh":"khmer translation"},
{"en":"40-50 word scene 6 text here","kh":"khmer translation"},
{"en":"40-50 word scene 7 text here","kh":"khmer translation"},
{"en":"40-50 word scene 8 text here","kh":"khmer translation"},
{"en":"40-50 word scene 9 text here","kh":"khmer translation"},
{"en":"40-50 word scene 10 text here","kh":"khmer translation"}
]}`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-sonnet-4-5', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }
  });

  if (res.status !== 200) throw new Error('Claude error ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 300));
  const content = res.body.content;
  if (!content || !content[0] || !content[0].text) throw new Error('Claude empty response: ' + JSON.stringify(res.body).slice(0,200));

  const text = content[0].text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude. Got: ' + text.slice(0, 300));

  const parsed = JSON.parse(match[0]);
  if (!parsed.scenes || parsed.scenes.length < 4) throw new Error('Too few scenes: ' + parsed.scenes?.length);

  // Ensure exactly 10 scenes
  while (parsed.scenes.length < 10) parsed.scenes.push(parsed.scenes[parsed.scenes.length - 1]);
  parsed.scenes = parsed.scenes.slice(0, 10);
  return parsed;
}

// ── VOICE: ELEVENLABS ─────────────────────────────────────────
async function generateVoice(text, voiceName, jobId, elevenLabsKey) {
  const voiceIds = {
    'Marcus': 'AZnzlk1XvdvUeBnXmlld',
    'Adam':   'pNInz6obpgDQGcFmaJgB',
    'Rachel': '21m00Tcm4TlvDq8ikWAM',
    'Bella':  'EXAVITQu4vr4xnSDxMaL'
  };
  const voiceId = voiceIds[voiceName] || voiceIds['Marcus'];
  const audioPath = path.join(OUT_DIR, `${jobId}_voice.mp3`);

  // Limit to 5000 chars for ElevenLabs free tier
  const safeText = text.substring(0, 4800);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: safeText,
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
        res.on('end', () => reject(new Error('ElevenLabs ' + res.statusCode + ': ' + Buffer.concat(c).toString().slice(0, 300))));
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

// ── IMAGES: FAL.AI with retry ─────────────────────────────────
async function generateImage(prompt, imgIdx, jobId, falKey, attempt) {
  attempt = attempt || 1;
  const imgPath = path.join(OUT_DIR, `${jobId}_img${imgIdx}.jpg`);

  try {
    // Try fast sync model first
    const res = await httpRequest('https://fal.run/fal-ai/fast-lightning-sdxl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
      body: { prompt, image_size: 'portrait_4_3', num_inference_steps: 4, num_images: 1 }
    });

    if (res.body && res.body.images && res.body.images[0] && res.body.images[0].url) {
      await downloadFile(res.body.images[0].url, imgPath);
      return imgPath;
    }

    // If queued, poll it
    if (res.body && res.body.request_id) {
      return await pollFal(res.body.request_id, imgPath, falKey, 'fal-ai/fast-lightning-sdxl');
    }

    // Fallback to flux/schnell
    return await fluxQueued(prompt, imgPath, falKey);

  } catch(err) {
    if (attempt < 3) {
      console.log(`Img ${imgIdx} attempt ${attempt} failed: ${err.message} — retrying in 6s`);
      await sleep(6000);
      return generateImage(prompt, imgIdx, jobId, falKey, attempt + 1);
    }
    // Final fallback — dark horror placeholder
    console.log(`Img ${imgIdx} all attempts failed — using dark fallback`);
    const darkFallbacks = [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1509248961158-e54f6934749c?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1505322715561-75cf4ca08175?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1504701954957-2010ec3bcec1?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1519074002996-a69e7ac46a42?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1546484958-6544e8e5c0b1?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1478358161113-b0e11994a36b?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1542281286-9e0a16bb7366?w=576&h=1024&fit=crop&q=80',
      'https://images.unsplash.com/photo-1516410529446-2c777cb7366d?w=576&h=1024&fit=crop&q=80'
    ];
    await downloadFile(darkFallbacks[imgIdx % darkFallbacks.length], imgPath);
    return imgPath;
  }
}

async function fluxQueued(prompt, imgPath, falKey) {
  const submit = await httpRequest('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
    body: { prompt, image_size: { width: 576, height: 1024 }, num_inference_steps: 4, num_images: 1, enable_safety_checker: false }
  });
  if (!submit.body || !submit.body.request_id) throw new Error('No request_id: ' + JSON.stringify(submit.body).slice(0,150));
  return pollFal(submit.body.request_id, imgPath, falKey, 'fal-ai/flux/schnell');
}

async function pollFal(requestId, imgPath, falKey, model) {
  for (let i = 0; i < 25; i++) {
    await sleep(4000);
    const s = await httpRequest(
      `https://queue.fal.run/${model}/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );
    if (s.body && s.body.status === 'COMPLETED') {
      const url = s.body.output?.images?.[0]?.url;
      if (!url) throw new Error('No image URL in response');
      await downloadFile(url, imgPath);
      return imgPath;
    }
    if (s.body && s.body.status === 'FAILED') throw new Error('Fal job failed');
  }
  throw new Error('Fal.ai poll timed out after 100s');
}

// ── 10 IMAGE PROMPTS — one per scene ─────────────────────────
function buildImagePrompts(niche, scenes, style) {
  const nicheStyle = NICHE_IMAGE_STYLE[niche] || NICHE_IMAGE_STYLE['Dark Stories'];
  const styleExtra = {
    'Cinematic': 'anamorphic lens, cinematic film still, professional movie lighting',
    'Horror':    'deep horror atmosphere, dim candlelight, abandoned building, terrifying',
    'Anime':     'anime illustration style, vivid colors, dramatic composition',
    'Realistic': 'photorealistic, 8K detail, professional DSLR photography'
  };
  const extra = styleExtra[style] || styleExtra['Cinematic'];

  // One image per scene (10 scenes = 10 images)
  return scenes.map((scene, i) => {
    // Extract a visual moment from the scene text
    const visual = scene.en.split('.')[0]; // First sentence as visual anchor
    return `${visual}. ${nicheStyle}. ${extra}. Vertical 9:16 portrait format. No text overlay, no watermark, no faces visible, no people recognizable.`;
  });
}

// ── ASSEMBLE: images loop to match audio duration exactly ─────
async function assembleVideo(jobId, imagePaths, audioPath, scenes, capMode) {
  const videoPath = path.join(OUT_DIR, `${jobId}_final.mp4`);

  const hasFfmpeg = await new Promise(resolve => { exec('ffmpeg -version', err => resolve(!err)); });
  if (!hasFfmpeg) {
    fs.writeFileSync(videoPath, JSON.stringify({ note: 'FFmpeg not installed', scenes: scenes.map(s => s.en) }));
    return videoPath;
  }

  // Get actual audio duration first
  const audioDuration = await new Promise((resolve) => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, (err, stdout) => {
      const dur = parseFloat(stdout);
      resolve(isNaN(dur) ? 180 : dur); // fallback to 180s if probe fails
    });
  });

  console.log(`Audio duration: ${audioDuration}s`);

  // Each scene gets equal time based on actual audio length
  const segDur = audioDuration / scenes.length;
  const totalScenes = scenes.length;

  const listPath = path.join(OUT_DIR, `${jobId}_list.txt`);
  let list = '';
  for (let i = 0; i < totalScenes; i++) {
    const img = imagePaths[i] || imagePaths[imagePaths.length - 1];
    list += `file '${img}'\nduration ${segDur.toFixed(3)}\n`;
  }
  list += `file '${imagePaths[imagePaths.length - 1]}'`;
  fs.writeFileSync(listPath, list);

  // Build caption filters synced to actual audio timing
  let vf = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1';

  if (capMode && capMode !== 'NONE') {
    const filters = scenes.map((s, i) => {
      const t0 = (i * segDur).toFixed(2);
      const t1 = ((i + 1) * segDur).toFixed(2);
      const txt = capMode === 'KH' ? (s.kh || s.en) : s.en;
      // Word wrap: split into lines of ~35 chars
      const words = (txt || '').split(' ');
      let lines = [], line = '';
      words.forEach(w => {
        if ((line + ' ' + w).trim().length > 32) { lines.push(line.trim()); line = w; }
        else line = (line + ' ' + w).trim();
      });
      if (line) lines.push(line);
      // Show first 2 lines only in caption (keep it readable)
      const capText = lines.slice(0, 2).join(' / ');
      const safe = capText.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&').replace(/,/g,'\\,');

      let f = `drawtext=fontsize=28:fontcolor=white:x=(w-text_w)/2:y=h*0.82:text='${safe}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.65:boxborderw=10:line_spacing=6`;

      if (capMode === 'BOTH' && s.kh) {
        const kh = (s.kh || '').split('.')[0]; // First sentence only for Khmer
        const safekh = kh.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&').replace(/,/g,'\\,');
        f += `,drawtext=fontsize=20:fontcolor=#FFD700:x=(w-text_w)/2:y=h*0.88:text='${safekh}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.55:boxborderw=7`;
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
    '-c:v libx264 -preset fast -crf 22',
    '-c:a aac -b:a 128k',
    '-map 0:v -map 1:a',  // explicitly map video from images, audio from file
    '-shortest',           // cut to shortest stream (audio)
    '-pix_fmt yuv420p',
    `"${videoPath}"`
  ].join(' ');

  console.log('Running FFmpeg...');
  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 360000 }, (err, stdout, stderr) => {
      if (err) { console.error('FFmpeg error:', stderr.slice(-600)); reject(new Error('FFmpeg failed: ' + stderr.slice(-400))); }
      else { console.log('FFmpeg complete'); resolve(); }
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
  jobs[jobId] = { id: jobId, status: 'rendering', step: 'Starting...', progress: 0, createdAt: new Date().toISOString() };
  res.json({ jobId });

  (async () => {
    try {
      // 1. Script — real storytelling ~450 words
      jobs[jobId].step = 'Writing 3-min story with Claude Sonnet...'; jobs[jobId].progress = 3;
      const script = await generateScript(niche || 'Dark Stories', language || 'English', customPrompt, anthropicKey);
      const wordCount = script.scenes.map(s => s.en.split(' ').length).reduce((a,b)=>a+b,0);
      jobs[jobId].step = `✓ Script ready — ${script.scenes.length} scenes, ~${wordCount} words`; jobs[jobId].progress = 15;
      jobs[jobId].script = script;

      // 2. Voice
      jobs[jobId].step = 'Generating voice narration with ElevenLabs...'; jobs[jobId].progress = 17;
      const fullText = script.scenes.map(s => s.en).join(' ... ');
      const audioPath = await generateVoice(fullText, voice || 'Marcus', jobId, elevenLabsKey);
      jobs[jobId].step = '✓ Voice narration ready'; jobs[jobId].progress = 32;

      // 3. Images — 1 per scene = 10 images
      const prompts = buildImagePrompts(niche, script.scenes, style || 'Cinematic');
      const imagePaths = [];
      for (let i = 0; i < prompts.length; i++) {
        jobs[jobId].step = `Generating scene image ${i + 1} of ${prompts.length}...`;
        jobs[jobId].progress = 32 + Math.round((i / prompts.length) * 45);
        const imgPath = await generateImage(prompts[i], i, jobId, falKey);
        imagePaths.push(imgPath);
      }
      jobs[jobId].step = `✓ All ${imagePaths.length} scene images ready`; jobs[jobId].progress = 77;

      // 4. Assemble — video matches audio duration exactly
      jobs[jobId].step = 'Assembling final video with FFmpeg...'; jobs[jobId].progress = 79;
      const videoPath = await assembleVideo(jobId, imagePaths, audioPath, script.scenes, capMode || 'BOTH');

      jobs[jobId] = {
        ...jobs[jobId],
        status: 'complete',
        step: `✓ Video ready! (${script.scenes.length} scenes, ~${Math.round(wordCount / 150)} min)`,
        progress: 100,
        title: script.title || (niche + ' Story'),
        script,
        videoUrl: '/output/' + path.basename(videoPath),
        sceneCount: script.scenes.length,
        imageCount: imagePaths.length,
        wordCount,
        completedAt: new Date().toISOString()
      };

    } catch(err) {
      console.error('Job failed:', err.message);
      jobs[jobId].status = 'failed';
      jobs[jobId].step = 'Error: ' + err.message;
      jobs[jobId].progress = 0;
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
    status: 'ok',
    version: 'v4-real-storytelling-10img',
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
  fs.existsSync(f) ? res.sendFile(f) : res.json({ status: 'Kira Studio API v4 running' });
});

app.listen(PORT, () => console.log(`Kira Studio v4 running on port ${PORT}`));
