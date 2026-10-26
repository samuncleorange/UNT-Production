/*
 * 产能数据的规范化、校验、格式化与验算。
 * 同时在 Node（服务端）和浏览器（前端二次编辑后重新验算）中使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Production = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOT_RE = /^[A-Z]{2}\d{4}(\.\d{2})?$/; // 例：BE2751、BE2956.01
  const MAX_QTY = 25;                          // 一盒晶元最多 25 片

  // 型号（如 B586、B319-6、B319-8）种类太多，照原样识别，不做格式校验，也不进核对区
  const FIELD_NAMES = { lot: '批次号', qty: '片数', machine: '机台号' };

  /** 全角转半角、去空格、常见 OCR 混淆修正（只做无歧义的修正） */
  function cleanToken(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[。，]/g, '.')
      .replace(/[‐-―−﹣]/g, '-')
      .replace(/\s+/g, '')
      .toUpperCase();
  }

  function normMachine(m) {
    const s = cleanToken(m).replace(/^#/, '').replace(/号$/, '');
    if (/^\d+$/.test(s)) return s.padStart(2, '0');
    return s;
  }

  /**
   * 时间段规范化：纸上常写 "10.18~10.19"、"10/18-10/19"，统一为 "10.18 6:00 - 10.19 6:00"。
   * 已带时间的保持原样（只统一分隔符）。shiftStart 为交班时间，默认 6:00。
   */
  function normPeriod(p, shiftStart) {
    shiftStart = shiftStart || '6:00';
    if (!p) return '';
    const s = String(p).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
    const d = '(\\d{1,2})[./月-](\\d{1,2})日?';
    const t = '(?:\\s*(\\d{1,2}[:：]\\d{2}))?';
    const re = new RegExp(`^${d}${t}\\s*[~\\-—–至到]+\\s*${d}${t}$`);
    const m = s.match(re);
    if (!m) return s;
    const t1 = (m[3] || shiftStart).replace('：', ':');
    const t2 = (m[6] || shiftStart).replace('：', ':');
    return `${+m[1]}.${m[2]} ${t1} - ${+m[4]}.${m[5]} ${t2}`;
  }

  /**
   * 按提交时间自动生成统计时间段。
   * 规则：每天北京时间 6:00 结算「前一天 6:00 - 当天 6:00」的产能。
   * 以距离最近的 6:00 为结算点（即 18:00 之前提交算当天 6:00 结束的那一段，18:00 之后算第二天的）。
   */
  function shiftPeriod(ts, opts) {
    opts = opts || {};
    const tz = opts.tz || 'Asia/Shanghai';
    const start = opts.shiftStart || '6:00';
    const [h, m] = start.split(/[:：]/).map(Number);
    const shiftHours = h + (m || 0) / 60;
    const shifted = new Date((ts ?? Date.now()) + (12 - shiftHours) * 3600e3);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(shifted).map((p) => [p.type, p.value]));
    const end = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
    const begin = new Date(end.getTime() - 86400e3);
    const md = (d) => `${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
    const t = `${h}:${String(m || 0).padStart(2, '0')}`;
    return `${md(begin)} ${t} - ${md(end)} ${t}`;
  }

  function toInt(q) {
    if (typeof q === 'number' && Number.isFinite(q)) return q;
    const s = cleanToken(q).replace(/[()（）片]/g, '');
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  /**
   * 将 AI 返回的 JSON 规范化为内部结构：
   * { period, machines: [{ machine, lots: [{ lot, qty, model, uncertain:[], note }] }], paperTotal, aiNotes: [] }
   */
  function normalize(raw, opts) {
    raw = raw || {};
    opts = opts || {};
    const machines = [];
    for (const m of raw.machines || []) {
      const lots = [];
      for (const l of m.lots || []) {
        const uncertain = Array.isArray(l.uncertain) ? l.uncertain.filter((x) => FIELD_NAMES[x] && x !== 'machine') : [];
        lots.push({
          lot: cleanToken(l.lot),
          qty: toInt(l.qty),
          model: cleanToken(l.model),
          uncertain,
          note: l.note ? String(l.note).trim() : '',
        });
      }
      machines.push({
        machine: normMachine(m.machine),
        uncertain: Array.isArray(m.uncertain) && m.uncertain.includes('machine'),
        note: m.note ? String(m.note).trim() : '',
        lots,
      });
    }
    const paperTotal = toInt(raw.paper_total ?? raw.paperTotal);
    const paperPeriod = normPeriod(raw.period, opts.shiftStart);
    const period = opts.period || paperPeriod;
    return {
      period,
      paperPeriod: opts.period && paperPeriod && paperPeriod !== opts.period ? paperPeriod : '',
      machines,
      paperTotal,
      aiNotes: (raw.uncertainties || raw.aiNotes || []).map(String).filter(Boolean),
    };
  }

  /** 代码验算：逐批次累加，绝不依赖 AI 的加法 */
  function computeTotals(data) {
    let total = 0;
    const perMachine = [];
    for (const m of data.machines) {
      let sub = 0;
      for (const l of m.lots) if (Number.isInteger(l.qty)) sub += l.qty;
      perMachine.push({ machine: m.machine, count: m.lots.length, subtotal: sub });
      total += sub;
    }
    return { total, perMachine };
  }

  /**
   * 生成需要人工核对的提示列表。
   * level: 'error' 必须核对 / 'warn' 建议核对 / 'info' 提示
   */
  function validate(data) {
    const issues = [];
    const seen = new Map();
    const totals = computeTotals(data);

    if (data.paperPeriod) issues.push({ level: 'info', where: '日期', msg: `纸上写的日期是「${data.paperPeriod}」，文本已按提交时间自动填为「${data.period}」。如果是补交以前的记录，请手动修改第一行。` });
    if (!data.machines.length) issues.push({ level: 'error', where: '整体', msg: '没有识别到任何机台，请检查图片是否清晰、是否按格式书写。' });

    for (const m of data.machines) {
      const mw = `#${m.machine || '?'}`;
      if (!/^\d{2}$/.test(m.machine)) issues.push({ level: 'error', where: mw, msg: `机台号「${m.machine}」格式异常，应为两位数字。` });
      if (m.uncertain) issues.push({ level: 'warn', source: 'ai', where: mw, msg: `机台号字迹不确定${m.note ? '：' + m.note : ''}` });
      if (!m.lots.length) issues.push({ level: 'warn', where: mw, msg: '该机台下没有识别到批次。' });

      m.lots.forEach((l, i) => {
        const w = `${mw} 第${i + 1}行 ${l.lot || ''}`.trim();
        if (l.uncertain.length) {
          const f = l.uncertain.map((x) => FIELD_NAMES[x]).join('、');
          issues.push({ level: 'warn', source: 'ai', where: w, msg: `AI 对【${f}】不确定${l.note ? '：' + l.note : ''}` });
        } else if (l.note) {
          issues.push({ level: 'info', source: 'ai', where: w, msg: l.note });
        }
        if (!l.lot) issues.push({ level: 'error', where: w, msg: '批次号缺失。' });
        else if (!LOT_RE.test(l.lot)) issues.push({ level: 'warn', where: w, msg: `批次号「${l.lot}」不符合常见格式（两位字母+四位数字，可带 .两位数字）。` });

        if (l.qty === null) issues.push({ level: 'error', where: w, msg: '片数缺失或无法识别为整数，未计入合计。' });
        else if (l.qty <= 0 || l.qty > MAX_QTY) issues.push({ level: 'error', where: w, msg: `片数 ${l.qty} 超出正常范围（1–${MAX_QTY}）。` });

        if (l.lot) {
          if (seen.has(l.lot)) issues.push({ level: 'info', where: w, msg: `批次号与 ${seen.get(l.lot)} 重复，请确认是否同一批次分在两台机。` });
          else seen.set(l.lot, w);
        }
      });
    }

    if (data.paperTotal !== null && data.paperTotal !== undefined) {
      if (data.paperTotal !== totals.total) {
        issues.push({
          level: 'error',
          where: '共计',
          msg: `纸上写的合计为 ${data.paperTotal} 片，代码逐行验算为 ${totals.total} 片，相差 ${data.paperTotal - totals.total} 片。请核对是否漏识别/漏记批次，或纸上合计算错。`,
        });
      }
    }

    for (const it of issues) if (!it.source) it.source = 'rule';
    for (const n of data.aiNotes) issues.push({ level: 'warn', source: 'ai', where: 'AI 提示', msg: n });
    return issues;
  }

  /** 输出标准格式文本，共计由代码计算 */
  function format(data) {
    const lines = [];
    lines.push(`${data.period || ''}生产情况：`);
    lines.push('');
    for (const m of data.machines) {
      lines.push(`#${m.machine}`);
      m.lots.forEach((l, i) => {
        const qty = l.qty === null ? '?' : l.qty;
        lines.push(`${i + 1}. ${l.lot} (${qty})${l.model ? ' ' + l.model : ''}`);
      });
      lines.push('');
    }
    lines.push(`共计：${computeTotals(data).total}片`);
    return lines.join('\n');
  }

  /**
   * 解析标准格式文本（用户在网页上手动修改后重新验算）。
   * 返回 { data, statedTotal }
   */
  function parseText(text) {
    const data = { period: '', machines: [], paperTotal: null, aiNotes: [] };
    let cur = null;
    let statedTotal = null;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
      if (!line) continue;
      let mt;
      if ((mt = line.match(/^共计\s*[:：]?\s*(\d+)/))) { statedTotal = parseInt(mt[1], 10); continue; }
      if ((mt = line.match(/^(.*?)生产情况/))) { data.period = mt[1].trim(); continue; }
      if ((mt = line.match(/^#\s*(\S+)/))) {
        cur = { machine: normMachine(mt[1]), uncertain: false, note: '', lots: [] };
        data.machines.push(cur);
        continue;
      }
      if ((mt = line.match(/^(?:\d+\s*[.、]\s*)?([A-Za-z]{1,3}[\w.]*)\s*\(\s*([^)]*?)\s*\)\s*(\S+)?/))) {
        if (!cur) { cur = { machine: '?', uncertain: false, note: '', lots: [] }; data.machines.push(cur); }
        cur.lots.push({ lot: cleanToken(mt[1]), qty: toInt(mt[2]), model: cleanToken(mt[3] || ''), uncertain: [], note: '' });
      }
    }
    return { data, statedTotal };
  }

  return { normalize, normPeriod, shiftPeriod, computeTotals, validate, format, parseText, LOT_RE, MAX_QTY };
});
