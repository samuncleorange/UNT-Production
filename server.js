'use strict';
require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const config = require('./lib/config');
const ai = require('./lib/ai');
const jobs = require('./lib/jobs');
const Production = require('./public/shared/production');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_CODE = process.env.ACCESS_CODE || '';     // 设置后，识别接口需要访问码，防止 API 额度被外人刷
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // 设置后才能使用 /admin.html 后台
const SHIFT_START = process.env.SHIFT_START || '6:00';
const SHIFT_TZ = process.env.SHIFT_TZ || 'Asia/Shanghai'; // 结算时区，默认北京时间

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireAccess(req, res, next) {
  if (!ACCESS_CODE || safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
  res.status(401).json({ error: '访问码错误', needAccessCode: true });
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: '后台未启用：请在 .env 中设置 ADMIN_PASSWORD 后重启服务' });
  if (safeEqual(req.get('x-admin-password') || '', ADMIN_PASSWORD)) return next();
  res.status(401).json({ error: '后台密码错误' });
}

// 压缩照片：按 EXIF 自动转正，长边缩到 2400px，减少上传给 AI 的体积
async function prepareImage(file) {
  try {
    const buffer = await sharp(file.buffer).rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 }).toBuffer();
    return { mime: 'image/jpeg', buffer };
  } catch (_) {
    throw new Error(`图片「${file.originalname}」格式无法识别，请改用 JPG 或 PNG`);
  }
}

app.get('/api/status', (_req, res) => {
  const cfg = config.load();
  res.json({ needAccessCode: !!ACCESS_CODE, aiConfigured: !!cfg.apiKey || process.env.AI_MOCK === '1', model: cfg.model, shiftStart: SHIFT_START });
});

async function recognizeImages(images, job) {
  const raw = await ai.recognize(config.load(), images);
  // 统计时间段按提交时间自动生成，不依赖纸上是否写日期
  const period = Production.shiftPeriod(job.createdAt, { tz: SHIFT_TZ, shiftStart: SHIFT_START });
  const data = Production.normalize(raw, { shiftStart: SHIFT_START, period });
  return {
    text: Production.format(data),
    data,
    totals: Production.computeTotals(data),
    issues: Production.validate(data),
  };
}
jobs.init(recognizeImages);

// 提交识别任务：保存图片后立即返回任务号，识别在后台进行
app.post('/api/jobs', requireAccess, upload.array('images', 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '请先上传图片' });
  try {
    const images = await Promise.all(files.map(prepareImage));
    res.json(jobs.publicJob(jobs.create(images)));
  } catch (e) {
    console.error('[jobs:create]', e);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs', requireAccess, (_req, res) => res.json({ jobs: jobs.list() }));

app.get('/api/jobs/:id', requireAccess, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(jobs.publicJob(job));
});

app.post('/api/jobs/:id/retry', requireAccess, (req, res) => {
  const job = jobs.retry(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(jobs.publicJob(job));
});

// 图片用 <img> 加载，无法带请求头，访问码通过 ?code= 传
app.get('/api/jobs/:id/images/:n', (req, res, next) => {
  req.headers['x-access-code'] = req.headers['x-access-code'] || req.query.code || '';
  next();
}, requireAccess, (req, res) => {
  const job = jobs.get(req.params.id);
  const n = Number(req.params.n);
  if (!job || !Number.isInteger(n) || n < 0 || n >= job.imageCount) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').type('jpeg').sendFile(jobs.imageFile(job.id, n));
});

// ---- 后台 ----
app.get('/api/admin/config', requireAdmin, (_req, res) => res.json(config.masked(config.load())));
app.post('/api/admin/config', requireAdmin, (req, res) => res.json(config.masked(config.save(req.body || {}))));
app.post('/api/admin/test', requireAdmin, async (req, res) => {
  try {
    const cfg = { ...config.load(), ...Object.fromEntries(Object.entries(req.body || {}).filter(([, v]) => v !== '' && v !== undefined)) };
    res.json({ ok: true, reply: await ai.testConnection(cfg) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});
app.get('/api/admin/prompt', requireAdmin, (_req, res) => res.json({ prompt: ai.SYSTEM_PROMPT }));

app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过 25MB' : err.code === 'LIMIT_FILE_COUNT' ? '一次最多上传 10 张图片' : err.message;
  res.status(400).json({ error: msg });
});

app.listen(PORT, HOST, () => console.log(`UNT 产能识别服务已启动：http://${HOST}:${PORT}`));
