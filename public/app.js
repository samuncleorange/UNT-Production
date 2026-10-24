(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const files = [];
  let needAccessCode = false;
  let jobList = [];          // 最近任务摘要
  let current = null;        // 当前打开的任务（含 result）
  let aiIssues = [];
  let checked = new Set();
  let pollTimer = null;
  const baseTitle = document.title;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const code = () => $('accessCode').value.trim();
  const headers = () => (code() ? { 'x-access-code': code() } : {});

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    const json = await res.json().catch(() => ({ error: `服务器返回 ${res.status}` }));
    if (!res.ok) {
      const err = new Error(json.error || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // ---------- 状态 ----------
  $('accessCode').value = store.get('accessCode') || '';
  fetch('/api/status').then((r) => r.json()).then((s) => {
    needAccessCode = s.needAccessCode;
    $('accessRow').hidden = !needAccessCode;
    $('status').textContent = s.aiConfigured ? `模型：${s.model}` : '⚠ 未配置 AI 接口';
    $('status').classList.toggle('bad', !s.aiConfigured);
    if (!needAccessCode || code()) loadJobs(true);
  }).catch(() => { $('status').textContent = '服务未连接'; });

  // ---------- 指引折叠 ----------
  if (store.get('guideCollapsed') === '1') $('guide').classList.add('collapsed');
  const syncGuideBtn = () => { $('toggleGuide').textContent = $('guide').classList.contains('collapsed') ? '展开' : '收起'; };
  syncGuideBtn();
  $('toggleGuide').onclick = () => {
    $('guide').classList.toggle('collapsed');
    store.set('guideCollapsed', $('guide').classList.contains('collapsed') ? '1' : '0');
    syncGuideBtn();
  };

  // ---------- 选择图片 ----------
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

  // 手机照片常有 5–10MB，上传前在本机压缩，上传更快，切出去也不容易断
  async function compress(file) {
    if (file.size < 1.2 * 1024 * 1024 && /jpe?g|png/.test(file.type)) return file;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      return blob && blob.size < file.size ? new File([blob], (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (_) {
      return file;
    }
  }

  function upload(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/jobs');
      for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let json = {};
        try { json = JSON.parse(xhr.responseText); } catch (_) {}
        xhr.status >= 200 && xhr.status < 300 ? resolve(json) : reject(new Error(json.error || `上传失败（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败，请重试'));
      xhr.send(fd);
    });
  }

  // ---------- 提交 ----------
  $('run').onclick = async () => {
    $('error').hidden = true;
    if (needAccessCode && !code()) { showError('请先输入访问码'); $('accessCode').focus(); return; }
    store.set('accessCode', code());
    askNotify();

    $('run').disabled = true;
    $('progress').hidden = false;
    setProgress(0, '正在压缩图片…');
    try {
      const fd = new FormData();
      for (const f of files) {
        const c = await compress(f.file);
        fd.append('images', c, c.name || 'image.jpg');
      }
      const job = await upload(fd, (p) => setProgress(p, `正在上传 ${Math.round(p * 100)}%…`));
      setProgress(1, '已提交');
      files.splice(0).forEach((f) => URL.revokeObjectURL(f.url));
      renderThumbs();
      store.set('watchJob', job.id);
      toast('已提交，可以离开页面了，识别完成后回来查看');
      upsertJob(job);
      openJob(job.id, true);
      schedulePoll(1500);
    } catch (e) {
      showError(e.message);
      $('run').disabled = !files.length;
    } finally {
      setTimeout(() => { $('progress').hidden = true; }, 600);
    }
  };
  function setProgress(p, text) { $('progressBar').style.width = Math.round(p * 100) + '%'; $('progressText').textContent = text; }
  function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }

  // ---------- 任务列表与轮询 ----------
  async function loadJobs(first) {
    try {
      const { jobs } = await api('/api/jobs');
      const before = new Map(jobList.map((j) => [j.id, j.status]));
      jobList = jobs;
      renderJobs();
      // 刚完成的任务
      for (const j of jobs) {
        const was = before.get(j.id);
        if (was && was !== j.status && (j.status === 'done' || j.status === 'failed')) onJobFinished(j);
      }
      if (first) {
        const watch = store.get('watchJob');
        const target = jobs.find((j) => j.id === watch) || jobs.find((j) => j.id === store.get('lastOpened'));
        if (target) openJob(target.id, false);
      } else if (current && jobs.some((j) => j.id === current.id && j.status !== current.status)) {
        openJob(current.id, false);
      }
    } catch (e) {
      if (e.status === 401) { $('accessRow').hidden = false; return; }
    }
    schedulePoll();
  }

  function hasPending() { return jobList.some((j) => j.status === 'queued' || j.status === 'processing'); }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!hasPending() && delay === undefined) return;
    // 页面在后台时浏览器会暂停计时器，回到前台时由 visibilitychange 立即刷新
    pollTimer = setTimeout(() => loadJobs(false), delay ?? 3000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!needAccessCode || code())) loadJobs(false);
  });
  window.addEventListener('focus', () => { if (!needAccessCode || code()) loadJobs(false); });
  $('refreshJobs').onclick = () => loadJobs(false);
  $('accessCode').addEventListener('change', () => { store.set('accessCode', code()); loadJobs(true); });

  function upsertJob(job) {
    const i = jobList.findIndex((j) => j.id === job.id);
    const { result, ...summary } = job;
    i === -1 ? jobList.unshift(summary) : (jobList[i] = summary);
    renderJobs();
  }

  function onJobFinished(j) {
    const watching = store.get('watchJob') === j.id;
    if (j.status === 'done') {
      document.title = '✅ 识别完成 · ' + baseTitle;
      notify('产能识别完成', `${j.period || ''} 共计 ${j.total} 片${j.issueCount ? `，${j.issueCount} 处待核对` : ''}`);
    } else {
      document.title = '⚠ 识别失败 · ' + baseTitle;
      notify('产能识别失败', j.error || '');
    }
    if (watching || (current && current.id === j.id)) openJob(j.id, !watching);
  }

  const STATUS = { queued: '排队中', processing: '识别中', done: '已完成', failed: '失败' };

  function renderJobs() {
    $('historyCard').hidden = !jobList.length;
    const ul = $('jobs');
    ul.innerHTML = '';
    for (const j of jobList) {
      const li = document.createElement('li');
      li.className = `job ${j.status}${current && current.id === j.id ? ' active' : ''}`;
      let detail = '';
      if (j.status === 'done') detail = `<b>${j.total}</b> 片${j.issueCount ? ` · <span class="warn-text">${j.issueCount} 处待核对</span>` : ''}`;
      else if (j.status === 'failed') detail = `<span class="err-text">${esc(j.error || '识别失败')}</span>`;
      else if (j.status === 'queued') detail = j.position > 1 ? `前面还有 ${j.position - 1} 个任务` : '即将开始';
      else detail = `已用时 <span data-since="${j.startedAt}">${elapsed(j.startedAt)}</span>`;
      li.innerHTML = `<button type="button" class="job-open">
          <span class="chip">${STATUS[j.status]}</span>
          <span class="job-main"><span class="job-title">${esc(j.period || '提交于 ' + fmtTime(j.createdAt))}</span><span class="job-detail">${detail}</span></span>
          <span class="job-time">${fmtTime(j.createdAt)} · ${j.imageCount} 张</span>
        </button>`;
      li.querySelector('.job-open').onclick = () => openJob(j.id, true);
      ul.appendChild(li);
    }
  }

  setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = elapsed(+el.dataset.since); }), 1000);

  // ---------- 打开任务 ----------
  async function openJob(id, scroll) {
    let job;
    try { job = await api('/api/jobs/' + id); } catch (e) { toast(e.message); return; }
    upsertJob(job);
    const sameJob = current && current.id === job.id && current.status === job.status;
    current = job;
    store.set('lastOpened', id);
    renderJobs();
    if (sameJob) { // 状态没变，不打断正在编辑的内容
      if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    $('results').hidden = false;
    $('results').classList.toggle('pending', job.status !== 'done');
    renderOriginals(job);
    if (job.status === 'done') {
      if (store.get('watchJob') === id) { store.del('watchJob'); document.title = baseTitle; }
      aiIssues = job.result.issues.filter((i) => i.source === 'ai');
      checked = new Set(JSON.parse(store.get('checked:' + id) || '[]'));
      $('output').value = store.get('edit:' + id) ?? job.result.text;
      $('output').readOnly = false;
      $('jobMeta').innerHTML = `识别用时 ${(job.result.elapsedMs / 1000).toFixed(1)} 秒 · 提交于 ${fmtTime(job.createdAt)}` +
        (store.get('edit:' + id) !== null ? ' · <span class="warn-text">含你的修改</span>' : '');
      refresh();
    } else {
      aiIssues = [];
      $('output').readOnly = true;
      $('output').value = job.status === 'failed'
        ? `识别失败：${job.error}\n\n可以点击下方「重新识别」，或检查后台 AI 配置。`
        : '正在后台识别，可以先离开此页面，完成后回来查看…';
      $('jobMeta').innerHTML = job.status === 'failed'
        ? `<button class="ghost small" id="retryBtn" type="button">重新识别</button>`
        : `<span class="spinner" aria-hidden="true"></span>${STATUS[job.status]}，已提交 <span data-since="${job.createdAt}">${elapsed(job.createdAt)}</span>`;
      if (job.status === 'failed') $('retryBtn').onclick = () => retry(id);
      clearResult();
    }
    if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function retry(id) {
    try {
      const job = await api(`/api/jobs/${id}/retry`, { method: 'POST' });
      store.set('watchJob', id);
      store.del('edit:' + id);
      upsertJob(job);
      current = null;
      openJob(id, false);
      schedulePoll(1500);
    } catch (e) { toast(e.message); }
  }

  function renderOriginals(job) {
    const box = $('originals');
    box.innerHTML = '';
    for (let n = 0; n < job.imageCount; n++) {
      const src = `/api/jobs/${job.id}/images/${n}${code() ? '?code=' + encodeURIComponent(code()) : ''}`;
      const a = document.createElement('a');
      a.href = src; a.target = '_blank'; a.rel = 'noopener'; a.title = '查看原图';
      a.innerHTML = `<img alt="原图 ${n + 1}" loading="lazy"><span>原图 ${n + 1}</span>`;
      a.querySelector('img').src = src;
      box.appendChild(a);
    }
  }

  function clearResult() {
    $('total').textContent = '–';
    $('totalSub').textContent = '';
    $('perMachine').innerHTML = '';
    $('mismatch').hidden = true;
    $('issues').innerHTML = '';
    $('issueCount').textContent = '–';
    $('noIssue').hidden = true;
    autosize();
  }

  // ---------- 验算 & 核对 ----------
  function autosize() {
    const ta = $('output');
    ta.style.height = '0';
    ta.style.height = ta.scrollHeight + 4 + 'px';
  }

  function refresh() {
    autosize();
    if (!current || current.status !== 'done') return;
    const { data, statedTotal } = Production.parseText($('output').value);
    data.paperTotal = current.result.data.paperTotal ?? null;
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
      li.querySelector('button').onclick = () => {
        done ? checked.delete(key) : checked.add(key);
        if (current) store.set('checked:' + current.id, JSON.stringify([...checked]));
        renderIssues(list);
      };
      ul.appendChild(li);
    });
    $('issueCount').textContent = open;
    $('issueCount').classList.toggle('zero', open === 0);
    $('noIssue').hidden = list.length > 0;
  }

  let t;
  $('output').addEventListener('input', () => {
    if (current && current.status === 'done') store.set('edit:' + current.id, $('output').value);
    clearTimeout(t);
    t = setTimeout(refresh, 200);
  });

  $('fixTotal').onclick = () => {
    const { data } = Production.parseText($('output').value);
    const total = Production.computeTotals(data).total;
    const v = $('output').value;
    $('output').value = /共计\s*[:：]?\s*\d*\s*片?/.test(v)
      ? v.replace(/共计\s*[:：]?\s*\d*\s*片?/, `共计：${total}片`)
      : v.replace(/\s*$/, '') + `\n\n共计：${total}片`;
    $('output').dispatchEvent(new Event('input'));
    toast('已按验算结果更新共计');
  };

  $('reset').onclick = () => {
    if (!current || current.status !== 'done') return;
    store.del('edit:' + current.id);
    $('output').value = current.result.text;
    $('jobMeta').querySelector('.warn-text')?.remove();
    refresh();
    toast('已还原为 AI 识别结果');
  };

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

  // ---------- 通知（仅 HTTPS 下可用，HTTP 下自动跳过） ----------
  function askNotify() {
    try {
      if (window.isSecureContext && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (_) {}
  }
  function notify(title, body) {
    if (document.visibilityState === 'visible') return;
    try { if (window.isSecureContext && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch (_) {}
  }

  // ---------- 工具 ----------
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function elapsed(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
})();
