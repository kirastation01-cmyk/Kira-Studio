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
    const reqOpts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: options.method || 'GET', headers: options.headers || {} };
    const req = lib.request(reqOpts, res => {
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
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); return downloadFile(res.headers.location, dest).then(resolve).catch(reject); }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SCRIPT: 12 SCENES = 3 MINUTES ────────────────────────────
async function generateScript(niche, language, customPrompt, anthropicKey) {
  const langInstr = language === 'Khmer' ? 'Write in Khmer. Also keep English in en field.'
    : language === 'English + Khmer' ? 'English in en field. Khmer translation in kh field.'
    : 'English only. Leave kh as empty string.';

  const prompt = customPrompt ||
    `Write a viral 3-minute faceless TikTok/YouTube Shorts script about "${niche}".
${langInstr}

EXACTLY 12 scenes. Each scene = 15 seconds = 3 minutes total.
Hook scenes 1-2, build tension 3-6, climax 7-9, shocking reveal 10-11, CTA scene 12.
Each scene: 1-2 short punchy sentences. Make it impossible to stop watching.

Return ONLY valid JSON, no markdown:
{"title":"title","scenes":[{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"},{"en":"text","kh":"khmer"}]}`;

  const res = await httpRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-haiku-4-5', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }
  });

  if (res.status !== 200) throw new Error('Claude error ' + res.status + ': ' + JSON.stringify(res.body).slice(0,200));
  const content = res.body.content;
  if (!content || !content[0] || !content[0].text) throw new Error('Claude empty response');

  const text = content[0].text.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON from Claude: ' + text.slice(0,200));

  const parsed = JSON.parse(match[0]);
  if (!parsed.scenes || parsed.scenes.length < 4) throw new Error('Too few scenes: ' + parsed.scenes?.length);

  // Ensure exactly 12 scenes
  while (parsed.scenes.length < 12) parsed.scenes.push(parsed.scenes[parsed.scenes.length-1]);
  parsed.scenes = parsed.scenes.slice(0, 12);
  return parsed;
}

// ── VOICE: ELEVENLABS ─────────────────────────────────────────
async function generateVoice(text, voiceName, jobId, elevenLabsKey) {
  const voiceIds = { 'Marcus':'AZnzlk1XvdvUeBnXmlld', 'Adam':'pNInz6obpgDQGcFmaJgB', 'Rachel':'21m00Tcm4TlvDq8ikWAM', 'Bella':'EXAVITQu4vr4xnSDxMaL' };
  const voiceId = voiceIds[voiceName] || voiceIds['Marcus'];
  const audioPath = path.join(OUT_DIR, `${jobId}_voice.mp3`);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: text.substring(0,5000), model_id:'eleven_multilingual_v2', voice_settings:{stability:0.5,similarity_boost:0.8,style:0.2} });
    const req = https.request({
      hostname:'api.elevenlabs.io', path:`/v1/text-to-speech/${voiceId}`, method:'POST',
      headers:{'Content-Type':'application/json','xi-api-key':elevenLabsKey,'Accept':'audio/mpeg'}
    }, res => {
      if (res.statusCode !== 200) {
        const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>reject(new Error('ElevenLabs '+res.statusCode+': '+Buffer.concat(c).toString().slice(0,200)))); return;
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

// ── IMAGES: FAL.AI with retry + fallback ──────────────────────
async function generateImage(prompt, imgIdx, jobId, falKey, attempt) {
  attempt = attempt || 1;
  const imgPath = path.join(OUT_DIR, `${jobId}_img${imgIdx}.jpg`);

  try {
    // Try fast sync endpoint first
    const res = await httpRequest('https://fal.run/fal-ai/fast-lightning-sdxl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
      body: { prompt, image_size: 'portrait_4_3', num_inference_steps: 4, num_images: 1 }
    });

    if (res.body && res.body.images && res.body.images[0] && res.body.images[0].url) {
      await downloadFile(res.body.images[0].url, imgPath);
      return imgPath;
    }

    // Fallback to flux/schnell queue
    return await generateFluxQueued(prompt, imgIdx, jobId, falKey, imgPath);

  } catch(err) {
    if (attempt < 3) {
      console.log(`Image ${imgIdx} attempt ${attempt} failed (${err.message}), retrying...`);
      await sleep(5000);
      return generateImage(prompt, imgIdx, jobId, falKey, attempt + 1);
    }
    // Final fallback: use a dark cinematic Unsplash image so video still renders
    console.log(`Image ${imgIdx} using fallback after 3 fails`);
    const fallbacks = [
      'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1509248961158-e54f6934749c?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1566228015668-4c45dbc4e2f5?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1531722569936-825d4ecc6416?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1483058712412-4245e9b90334?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1539650116574-8efeb43e2750?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=576&h=1024&fit=crop',
      'https://images.unsplash.com/photo-1453847668862-487637052f8a?w=576&h=1024&fit=crop'
    ];
    await downloadFile(fallbacks[imgIdx % fallbacks.length], imgPath);
    return imgPath;
  }
}

async function generateFluxQueued(prompt, imgIdx, jobId, falKey, imgPath) {
  const submit = await httpRequest('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
    body: { prompt, image_size: { width: 576, height: 1024 }, num_inference_steps: 4, num_images: 1, enable_safety_checker: false }
  });

  if (!submit.body || !submit.body.request_id) throw new Error('No request_id from fal: ' + JSON.stringify(submit.body).slice(0,150));

  for (let i = 0; i < 25; i++) {
    await sleep(4000);
    const s = await httpRequest(`https://queue.fal.run/fal-ai/flux/schnell/requests/${submit.body.request_id}`, { headers: { 'Authorization': `Key ${falKey}` } });
    if (s.body && s.body.status === 'COMPLETED') {
      const url = s.body.output?.images?.[0]?.url;
      if (!url) throw new Error('No image URL');
      await downloadFile(url, imgPath);
      return imgPath;
    }
    if (s.body && s.body.status === 'FAILED') throw new Error('Fal job failed');
  }
  throw new Error('Fal.ai timed out');
}

// ── IMAGE PROMPTS — 10 IMAGES FOR 12 SCENES ──────────────────
// Distribution: scenes 0,1 → img0 | 2 → img1 | 3 → img2 | 4 → img3 | 5 → img4
//               6 → img5 | 7 → img6 | 8 → img7 | 9 → img8 | 10,11 → img9
// 10 unique images, more variety, 2 scenes share an image at start and end only
const SCENE_TO_IMG = [0,0,1,2,3,4,5,6,7,8,9,9];

function buildImagePrompts(niche, scenes, style) {
  const styleMap = {
    'Cinematic': 'cinematic film still, dramatic lighting, anamorphic lens, movie quality',
    'Horror':    'dark horror atmosphere, eerie shadows, unsettling, hyper-realistic',
    'Anime':     'anime art style, vibrant colors, beautiful, highly detailed',
    'Realistic': 'photorealistic, professional photography, 8K ultra detail'
  };
  const s = styleMap[style] || styleMap['Cinematic'];

  // Pick 10 scenes to represent each image: indices 0,2,3,4,5,6,7,8,9,10
  const sceneIndices = [0,2,3,4,5,6,7,8,9,10];
  return sceneIndices.map(i => {
    const scene = scenes[i] || scenes[0];
    return `${scene.en}. ${s}. Vertical 9:16 portrait format. No text, no watermark, no faces.`;
  });
}

// ── ASSEMBLE 3-MINUTE MP4 ─────────────────────────────────────
async function assembleVideo(jobId, imagePaths, audioPath, scenes, capMode) {
  const videoPath = path.join(OUT_DIR, `${jobId}_final.mp4`);
  const SEG = 15;

  const hasFfmpeg = await new Promise(resolve => { exec('ffmpeg -version', err => resolve(!err)); });
  if (!hasFfmpeg) {
    fs.writeFileSync(videoPath, JSON.stringify({ note:'Install FFmpeg for real MP4', scenes:scenes.map(s=>s.en) }));
    return videoPath;
  }

  const listPath = path.join(OUT_DIR, `${jobId}_list.txt`);
  let list = '';
  for (let i = 0; i < 12; i++) {
    const imgIdx = SCENE_TO_IMG[i];
    const img = imagePaths[imgIdx] || imagePaths[imagePaths.length-1];
    list += `file '${img}'\nduration ${SEG}\n`;
  }
  list += `file '${imagePaths[imagePaths.length-1]}'`;
  fs.writeFileSync(listPath, list);

  let vf = 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1';
  if (capMode && capMode !== 'NONE') {
    const filters = scenes.map((s, i) => {
      const t0 = i*SEG, t1 = t0+SEG;
      const txt = capMode === 'KH' ? (s.kh||s.en) : s.en;
      const safe = (txt||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&');
      let f = `drawtext=fontsize=26:fontcolor=white:x=(w-text_w)/2:y=h-110:text='${safe}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.6:boxborderw=8`;
      if (capMode === 'BOTH' && s.kh) {
        const sk = (s.kh||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/[\[\]]/g,'\\$&');
        f += `,drawtext=fontsize=18:fontcolor=yellow:x=(w-text_w)/2:y=h-72:text='${sk}':enable='between(t\\,${t0}\\,${t1})':box=1:boxcolor=black@0.5:boxborderw=5`;
      }
      return f;
    });
    vf += ',' + filters.join(',');
  }

  const cmd = ['ffmpeg -y', `-f concat -safe 0 -i "${listPath}"`, `-i "${audioPath}"`, `-vf "${vf}"`, '-c:v libx264 -preset fast -crf 23', '-c:a aac -b:a 128k -shortest -pix_fmt yuv420p', `"${videoPath}"`].join(' ');

  await new Promise((resolve, reject) => {
    exec(cmd, { timeout: 300000 }, (err, so, se) => {
      if (err) { console.error('FFmpeg:', se); reject(new Error('FFmpeg: ' + se.slice(-400))); }
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
  jobs[jobId] = { id:jobId, status:'rendering', step:'Starting...', progress:0, createdAt:new Date().toISOString() };
  res.json({ jobId });

  (async () => {
    try {
      jobs[jobId].step = 'Writing 3-min script with Claude...'; jobs[jobId].progress = 3;
      const script = await generateScript(niche||'Dark Stories', language||'English', customPrompt, anthropicKey);
      jobs[jobId].step = `✓ Script ready — ${script.scenes.length} scenes (3 min)`; jobs[jobId].progress = 15; jobs[jobId].script = script;

      jobs[jobId].step = 'Generating voice with ElevenLabs...'; jobs[jobId].progress = 17;
      const audioPath = await generateVoice(script.scenes.map(s=>s.en).join('. '), voice||'Marcus', jobId, elevenLabsKey);
      jobs[jobId].step = '✓ Voice ready'; jobs[jobId].progress = 32;

      const prompts = buildImagePrompts(niche, script.scenes, style||'Cinematic');
      const imagePaths = [];
      for (let i = 0; i < prompts.length; i++) {
        jobs[jobId].step = `Generating image ${i+1} of 10 with Fal.ai...`; jobs[jobId].progress = 32 + (i * 5);
        imagePaths.push(await generateImage(prompts[i], i, jobId, falKey));
      }
      jobs[jobId].step = '✓ All 10 images ready'; jobs[jobId].progress = 82;

      jobs[jobId].step = 'Assembling 3-minute MP4 with FFmpeg...'; jobs[jobId].progress = 84;
      const videoPath = await assembleVideo(jobId, imagePaths, audioPath, script.scenes, capMode||'BOTH');

      jobs[jobId] = { ...jobs[jobId], status:'complete', step:'✓ 3-minute video is ready!', progress:100,
        title:script.title||(niche+' Story'), script, videoUrl:'/output/'+path.basename(videoPath),
        duration:'3:00', sceneCount:12, imageCount:10, completedAt:new Date().toISOString() };

    } catch(err) {
      console.error('Job error:', err.message);
      jobs[jobId].status = 'failed'; jobs[jobId].step = 'Error: ' + err.message; jobs[jobId].progress = 0;
    }
  })();
});

app.get('/api/job/:id', (req,res) => { const j=jobs[req.params.id]; j?res.json(j):res.status(404).json({error:'Not found'}); });
app.get('/api/jobs', (req,res) => { res.json(Object.values(jobs).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))); });
app.get('/api/health', (req,res) => {
  res.json({ status:'ok', hasAnthropicKey:!!process.env.ANTHROPIC_API_KEY, hasElevenLabsKey:!!process.env.ELEVENLABS_API_KEY, hasFalKey:!!process.env.FAL_API_KEY, hasTikTokToken:!!process.env.TIKTOK_ACCESS_TOKEN, hasYouTubeToken:!!process.env.YOUTUBE_ACCESS_TOKEN, version:'3-min-10img', timestamp:new Date().toISOString() });
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/', (req,res) => {
  const f=path.join(__dirname,'public','index.html');
  fs.existsSync(f)?res.sendFile(f):res.json({status:'Kira Studio API running'});
});

app.listen(PORT, () => console.log(`Kira Studio server running on port ${PORT}`));
