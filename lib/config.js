'use strict';
// AI 配置：优先读取后台保存的 data/config.json，其次读取 .env
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

function fromEnv() {
  return {
    baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o',
    temperature: process.env.AI_TEMPERATURE !== undefined ? Number(process.env.AI_TEMPERATURE) : 0,
    extraPrompt: process.env.AI_EXTRA_PROMPT || '',
  };
}

function load() {
  const base = fromEnv();
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const k of Object.keys(base)) if (saved[k] !== undefined && saved[k] !== '') base[k] = saved[k];
  } catch (_) { /* 尚未在后台保存过 */ }
  return base;
}

function save(patch) {
  const cur = load();
  const next = { ...cur };
  for (const k of ['baseUrl', 'model', 'extraPrompt']) if (typeof patch[k] === 'string') next[k] = patch[k].trim();
  if (patch.temperature !== undefined && patch.temperature !== '') next.temperature = Number(patch.temperature) || 0;
  // apiKey 留空表示不修改
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function masked(cfg) {
  const k = cfg.apiKey || '';
  return { ...cfg, apiKey: k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '', hasKey: !!k };
}

module.exports = { load, save, masked };
