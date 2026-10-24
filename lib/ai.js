'use strict';
// 调用兼容 OpenAI Chat Completions 接口的视觉模型（OpenAI / 通义千问 / 智谱 / DeepSeek / 各类中转均可）
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = `你是晶圆厂产能记录的识别助手。用户会上传一张或多张手写/打印的产能记录照片，你只负责「如实转录」，不做任何计算。

记录规则：
- 「#数字」是机台号（如 #7、#08、#10），其后直到下一个 # 之前的每一行都是该机台的批次。机台号可能和第一条批次写在同一行。
- 每条批次形如：批次号 (片数) 型号。例：BE2956.01 (12) B586
  - 批次号：通常两位大写字母 + 四位数字，可带「.两位数字」后缀，如 BE2751、BP1592.02、BE3390.02
  - 片数：括号里的整数，通常 1–25
  - 型号：通常一个字母 + 三位数字，如 B586、B339；可能没写
- 行首可能有序号「1.」「2.」，也可能没有，序号不要放进批次号。
- 页面顶部一般写日期/时间段，如「10.18~10.19」或「10.18 6:00 - 10.19 6:00」。
- 被横线划掉、涂黑的内容是作废内容，忽略，以旁边重写的内容为准，并在 note 中说明有涂改。
- 页面末尾可能写有「共计/合计 xxx 片」，原样记录到 paper_total；没写就填 null。绝对不要自己做加法。

不确定性要求（非常重要）：
- 任何字迹模糊、有涂改、有改写、可能有歧义的字段（如 1/7、0/6、3/8、5/6、4/9、. 与 , 是否为小数点），给出你认为最可能的值，同时把该字段名放进 uncertain 数组，并在 note 中写明原因和其它可能值，例如 "小数部分有涂改，可能是 .02 或 .01"。
- 宁可多标记，不要漏标记。字迹清晰无歧义的字段不要标记。
- 有多张图片时按图片顺序合并；同一机台在多张图出现时合并到一起并在 uncertainties 中说明。

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。结构：
{
  "period": "页面上的时间段原文，如 10.18~10.19；没有则为空字符串",
  "machines": [
    {
      "machine": "7",
      "uncertain": [],          // 机台号不确定时为 ["machine"]
      "note": "",
      "lots": [
        { "lot": "BP1592.02", "qty": 12, "model": "B473", "uncertain": [], "note": "" }
      ]
    }
  ],
  "paper_total": null,
  "uncertainties": ["整体性的问题，如：图片底部被手指遮挡，可能有遗漏"]
}
uncertain 数组只能包含 "lot"、"qty"、"model" 这三个值（机台层级只能是 "machine"）。`;

function extractJson(text) {
  if (!text) throw new Error('AI 返回为空');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('AI 返回的内容不是 JSON：' + s.slice(0, 200));
  s = s.slice(a, b + 1).replace(/\/\/[^\n"]*$/gm, ''); // 去掉模型偶尔照抄的行尾注释
  return JSON.parse(s);
}

async function chat(cfg, messages, { timeoutMs = 180000, maxTokens = 4096 } = {}) {
  if (!cfg.apiKey) throw new Error('尚未配置 AI API Key，请到后台设置页面填写，或在 .env 中设置 AI_API_KEY');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, temperature: Number(cfg.temperature) || 0, max_tokens: maxTokens, messages }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`AI 接口返回 ${res.status}：${body.slice(0, 500)}`);
    const json = JSON.parse(body);
    const content = json.choices?.[0]?.message?.content;
    return Array.isArray(content) ? content.map((c) => c.text || '').join('') : content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 接口超时，请稍后重试或换一个更快的模型');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** images: [{ mime, buffer }] */
async function recognize(cfg, images) {
  if (process.env.AI_MOCK === '1') {
    await new Promise((r) => setTimeout(r, Number(process.env.AI_MOCK_DELAY) || 8000));
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'mock-response.json'), 'utf8'));
  }
  const system = SYSTEM_PROMPT + (cfg.extraPrompt ? `\n\n补充说明：\n${cfg.extraPrompt}` : '');
  const content = [{ type: 'text', text: `共 ${images.length} 张图片，请按规则转录为 JSON。` }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` } });
  }
  const text = await chat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content },
  ]);
  return extractJson(text);
}

async function testConnection(cfg) {
  const text = await chat(cfg, [{ role: 'user', content: '回复 OK 两个字母即可' }], { timeoutMs: 30000, maxTokens: 10 });
  return String(text || '').trim();
}

module.exports = { recognize, testConnection, extractJson, SYSTEM_PROMPT };
