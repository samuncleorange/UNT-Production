'use strict';
/*
 * 后台识别任务队列。
 * - 上传后立即返回任务号，识别在服务器后台进行，用户可以离开页面
 * - 任务和图片保存在 data/jobs/ 下，服务重启后未完成的任务会自动继续
 * - 超过保留期限的任务自动清理
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.JOBS_DIR || path.join(__dirname, '..', 'data', 'jobs');
const KEEP_DAYS = Number(process.env.JOB_KEEP_DAYS) || 30;
const CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY) || 2);
const MAX_ATTEMPTS = 2; // 网络类错误自动重试 1 次

const jobs = new Map(); // id -> job（不含图片）
const queue = [];
let running = 0;
let processor = null;

function jobFile(id) { return path.join(DIR, id, 'job.json'); }
function imageFile(id, n) { return path.join(DIR, id, `${n}.jpg`); }

function save(job) {
  const tmp = jobFile(job.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, jobFile(job.id));
}

function summary(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    imageCount: job.imageCount,
    period: job.result?.data?.period || '',
    total: job.result?.totals?.total ?? null,
    issueCount: job.result ? job.result.issues.filter((i) => i.level !== 'info').length : null,
    error: job.error || null,
    position: job.status === 'queued' ? queue.indexOf(job.id) + 1 : 0,
  };
}

function publicJob(job) {
  return { ...summary(job), result: job.result || null };
}

function init(fn) {
  processor = fn;
  fs.mkdirSync(DIR, { recursive: true });
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  const pending = [];
  for (const id of fs.readdirSync(DIR)) {
    let job;
    try { job = JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); } catch (_) { continue; }
    if (job.createdAt < cutoff) { fs.rmSync(path.join(DIR, id), { recursive: true, force: true }); continue; }
    if (job.status === 'queued' || job.status === 'processing') {
      job.status = 'queued'; // 服务重启前没做完的，重新排队
      save(job);
      pending.push(job);
    }
    jobs.set(id, job);
  }
  pending.sort((a, b) => a.createdAt - b.createdAt).forEach((j) => queue.push(j.id));
  if (pending.length) console.log(`[jobs] 恢复 ${pending.length} 个未完成任务`);
  pump();
  setInterval(cleanup, 6 * 3600e3).unref();
}

function cleanup() {
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== 'processing' && job.status !== 'queued') {
      jobs.delete(id);
      fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
    }
  }
}

/** images: [{ mime, buffer }]，已压缩为 jpeg */
function create(images) {
  const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(path.join(DIR, id), { recursive: true });
  images.forEach((img, n) => fs.writeFileSync(imageFile(id, n), img.buffer));
  const job = { id, status: 'queued', createdAt: Date.now(), imageCount: images.length, attempts: 0 };
  save(job);
  jobs.set(id, job);
  queue.push(id);
  pump();
  return job;
}

function loadImages(job) {
  const out = [];
  for (let n = 0; n < job.imageCount; n++) out.push({ mime: 'image/jpeg', buffer: fs.readFileSync(imageFile(job.id, n)) });
  return out;
}

function isTransient(err) {
  const m = String(err && err.message);
  return /超时|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket| 429|返回 5\d\d/.test(m);
}

async function run(job) {
  job.status = 'processing';
  job.startedAt = Date.now();
  job.attempts = (job.attempts || 0) + 1;
  delete job.error;
  save(job);
  try {
    const result = await processor(loadImages(job), job);
    job.result = { ...result, elapsedMs: Date.now() - job.startedAt };
    job.status = 'done';
  } catch (e) {
    console.error(`[jobs] ${job.id} 第 ${job.attempts} 次失败：`, e.message);
    if (job.attempts < MAX_ATTEMPTS && isTransient(e)) {
      job.status = 'queued';
      queue.push(job.id);
    } else {
      job.status = 'failed';
      job.error = e.message || String(e);
    }
  }
  if (job.status !== 'queued') job.finishedAt = Date.now();
  save(job);
}

function pump() {
  while (processor && running < CONCURRENCY && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    running++;
    run(job).catch((e) => console.error('[jobs]', e)).finally(() => { running--; pump(); });
  }
}

function get(id) {
  return /^[a-z0-9]+$/.test(id) ? jobs.get(id) : undefined;
}

function retry(id) {
  const job = get(id);
  if (!job || job.status === 'queued' || job.status === 'processing') return job;
  job.status = 'queued';
  job.attempts = 0;
  delete job.result;
  delete job.error;
  delete job.finishedAt;
  save(job);
  queue.push(id);
  pump();
  return job;
}

function list(limit = 30) {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(summary);
}

module.exports = { init, create, get, retry, list, publicJob, imageFile };
