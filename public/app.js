(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const files = [];
  let original = null;   // AI 识别结果（服务端返回）
  let aiIssues = [];     // AI 标记的不确定项，编辑文本后保留
  let checked = new Set();

  // ---------- 状态 ----------
  let needAccessCode = false;
  fetch('/api/status').then((r) => r.json()).then((s) => {
    needAccessCode = s.needAccessCode;
    $('accessRow').hidden = !needAccessCode;
    try { $('accessCode').value = localStorage.getItem('accessCode') || ''; } catch (_) {}
    $('status').textContent = s.aiConfigured ? `模型：${s.model}` : '⚠ 未配置 AI 接口';
    $('status').classList.toggle('bad', !s.aiConfigured);
  }).catch(() => { $('status').textContent = '服务未连接'; });

  // ---------- 指引折叠 ----------
  try { if (localStorage.getItem('guideCollapsed') === '1') $('guide').classList.add('collapsed'); } catch (_) {}
  const syncGuideBtn = () => { $('toggleGuide').textContent = $('guide').classList.contains('collapsed') ? '展开' : '收起'; };
  syncGuideBtn();
  $('toggleGuide').onclick = () => {
    $('guide').classList.toggle('collapsed');
    try { localStorage.setItem('guideCollapsed', $('guide').classList.contains('collapsed') ? '1' : '0'); } catch (_) {}
    syncGuideBtn();
  };

  // ---------- 上传 ----------
  function addFiles(list) {
    for (const f of list) {
      if (!f.type.startsWith('image/')) continue;
      if (files.length >= 10) { toast('最多 10 张'); break; }
      files.push({ file: f, url: URL.createObjectURL(f) });
    }
    renderThumbs();
  }
  function renderThumbs() {
    const box = $('thumbs');
    box.innerHTML = '';
    files.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img alt="第${i + 1}张"><button type="button" aria-label="删除">×</button><span>${i + 1}</span>`;
      d.querySelector('img').src = f.url;
      d.querySelector('img').onclick = () => window.open(f.url, '_blank');
      d.querySelector('button').onclick = () => { URL.revokeObjectURL(f.url); files.splice(i, 1); renderThumbs(); };
      box.appendChild(d);
    });
    $('run').disabled = !files.length;
  }
  $('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  document.addEventListener('paste', (e) => {
    if (e.target === $('output')) return;
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
    if (imgs.length) addFiles(imgs);
  });

  // ---------- 识别 ----------
  $('run').onclick = async () => {
    $('error').hidden = true;
    const code = $('accessCode').value.trim();
    if (needAccessCode && !code) { showError('请先输入访问码'); $('accessCode').focus(); return; }
    try { localStorage.setItem('accessCode', code); } catch (_) {}

    const fd = new FormData();
    files.forEach((f) => fd.append('images', f.file, f.file.name || 'image.jpg'));
    setBusy(true);
    try {
      const res = await fetch('/api/recognize', { method: 'POST', body: fd, headers: code ? { 'x-access-code': code } : {} });
      const json = await res.json().catch(() => ({ error: `服务器返回 ${res.status}` }));
      if (!res.ok) throw new Error(json.error || `识别失败（${res.status}）`);
      original = json;
      aiIssues = json.issues.filter((i) => i.source === 'ai');
      checked = new Set();
      $('output').value = json.text;
      $('results').hidden = false;
      refresh();
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(`识别完成，用时 ${(json.elapsedMs / 1000).toFixed(1)} 秒`);
    } catch (e) {
      showError(e.message);
    } finally {
      setBusy(false);
    }
  };
  function setBusy(b) {
    $('run').disabled = b || !files.length;
    $('run').textContent = b ? '识别中…' : '开始识别';
    $('progress').hidden = !b;
  }
  function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }

  // ---------- 验算 & 核对 ----------
  function refresh() {
    const ta = $('output');
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 4 + 'px';
    const { data, statedTotal } = Production.parseText($('output').value);
    data.paperTotal = original?.data?.paperTotal ?? null;
    const totals = Production.computeTotals(data);
    $('total').textContent = totals.total;
    const lots = totals.perMachine.reduce((a, m) => a + m.count, 0);
    $('totalSub').innerHTML = `${totals.perMachine.length} 台机 · ${lots} 个批次` +
      (data.paperTotal != null ? `<br>纸上合计：${data.paperTotal} 片` : '<br>纸上未写合计');

    $('perMachine').innerHTML = totals.perMachine.map((m) => `<tr><td>#${esc(m.machine)}</td><td>${m.count}</td><td>${m.subtotal}</td></tr>`).join('');

    const mism = statedTotal !== null && statedTotal !== totals.total;
    $('mismatch').hidden = !mism && statedTotal !== null;
    if (statedTotal === null) $('mismatchText').textContent = '文本中没有「共计」行';
    else if (mism) $('mismatchText').textContent = `文本里写的共计 ${statedTotal} 片 ≠ 验算 ${totals.total} 片`;

    const rule = Production.validate(data).filter((i) => i.source === 'rule');
    renderIssues([...rule, ...aiIssues]);
  }

  function renderIssues(list) {
    const order = { error: 0, warn: 1, info: 2 };
    list.sort((a, b) => order[a.level] - order[b.level]);
    const ul = $('issues');
    ul.innerHTML = '';
    let open = 0;
    list.forEach((it) => {
      const key = it.where + '|' + it.msg;
      const done = checked.has(key);
      if (!done && it.level !== 'info') open++;
      const li = document.createElement('li');
      li.className = `issue ${it.level}${done ? ' done' : ''}`;
      li.innerHTML = `<div class="issue-main"><span class="lvl">${{ error: '必须核对', warn: '建议核对', info: '提示' }[it.level]}</span>` +
        `<b class="where">${esc(it.where)}</b><p>${esc(it.msg)}</p></div>` +
        `<button type="button" class="ghost small">${done ? '撤销' : '已核对'}</button>`;
      li.querySelector('button').onclick = () => { done ? checked.delete(key) : checked.add(key); renderIssues(list); };
      ul.appendChild(li);
    });
    $('issueCount').textContent = open;
    $('issueCount').classList.toggle('zero', open === 0);
    $('noIssue').hidden = list.length > 0;
  }

  let t;
  $('output').addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 200); });

  $('fixTotal').onclick = () => {
    const { data } = Production.parseText($('output').value);
    const total = Production.computeTotals(data).total;
    const v = $('output').value;
    $('output').value = /共计\s*[:：]?\s*\d*\s*片?/.test(v)
      ? v.replace(/共计\s*[:：]?\s*\d*\s*片?/, `共计：${total}片`)
      : v.replace(/\s*$/, '') + `\n\n共计：${total}片`;
    refresh();
    toast('已按验算结果更新共计');
  };

  $('reset').onclick = () => { if (original) { $('output').value = original.text; refresh(); toast('已还原'); } };

  $('copy').onclick = async () => {
    const text = $('output').value;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      // 非 HTTPS 部署时 clipboard API 不可用，回退到 execCommand
      $('output').select();
      try { ok = document.execCommand('copy'); } catch (_) {}
      window.getSelection()?.removeAllRanges();
    }
    toast(ok ? '已复制到剪贴板' : '复制失败，请长按文本手动复制');
    if (ok) { $('copy').classList.add('ok'); setTimeout(() => $('copy').classList.remove('ok'), 1200); }
  };

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2000);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
