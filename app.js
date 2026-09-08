/* ============================================================
   AMAN RESIZE — local file scaling engine
   Everything runs in-browser. No network calls, no uploads.
   ============================================================ */
(function () {
  'use strict';

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  /* ---------- element refs ---------- */
  const $ = (id) => document.getElementById(id);
  const drop = $('drop'), fileInput = $('fileInput'), sizeInput = $('sizeInput');
  const runBtn = $('runBtn'), hint = $('hint'), logBox = $('log');
  const padToggle = $('padToggle');
  const resultsWrap = $('resultsWrap'), results = $('results'), clearBtn = $('clearBtn');
  const gVal = $('gVal'), gUnit = $('gUnit'), gFill = document.querySelector('.g-fill');
  const sOrig = $('sOrig'), sTarget = $('sTarget'), sFinal = $('sFinal'),
        sDelta = $('sDelta'), sQual = $('sQual'), sIter = $('sIter');

  const ACCEPT = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
  const GAUGE_LEN = 515;

  let queue = [];        // File[]
  let unit = 'KB';
  let busy = false;

  /* ============================================================
     HELPERS
     ============================================================ */
  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(b / 1024 < 10 ? 1 : 0) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }

  function ext(name) {
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function baseName(name) {
    return String(name).replace(/\.[^.]+$/, '') || 'file';
  }

  function targetBytes() {
    const n = parseFloat(sizeInput.value);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * (unit === 'MB' ? 1048576 : 1024));
  }

  function log(msg, cls) {
    const line = document.createElement('div');
    line.className = 'log-line' + (cls ? ' ' + cls : '');
    line.textContent = '> ' + msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clearLog() { logBox.innerHTML = ''; }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /* ============================================================
     SANDBOX DETECTION
     Embedded preview frames are often served with a `sandbox`
     attribute that omits `allow-downloads`. In that case Chrome
     silently refuses every save: <a download>, window.open(blob:)
     and showSaveFilePicker() are all blocked. Detect it up front
     so we can tell the user instead of appearing to do nothing.
     ============================================================ */
  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  function downloadsBlocked() {
    if (!inFrame) return false;
    // If we can reach the top document, the frame isn't cross-origin sandboxed.
    try { void window.top.location.href; return false; } catch (e) { return true; }
  }

  function showFrameWarning() {
    if (document.getElementById('frameWarn')) return;
    const bar = document.createElement('div');
    bar.id = 'frameWarn';
    bar.className = 'framewarn';
    bar.innerHTML =
      '<span class="fw-i" aria-hidden="true">!</span>' +
      '<div><b>Downloads are blocked in this embedded preview.</b> ' +
      'The browser blocks saving from a sandboxed frame \u2014 your files are fine, ' +
      'the frame just is not allowed to write them to disk. ' +
      '<u>Open this page in its own browser tab</u> and the download buttons will work normally.</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('has-warn');
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /* Draw a source (Image/Canvas) onto a fresh canvas at `scale`, flattened on white. */
  function rescale(src, scale) {
    const w = Math.max(1, Math.round((src.naturalWidth || src.width) * scale));
    const h = Math.max(1, Math.round((src.naturalHeight || src.height) * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return c;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
      img.src = url;
    });
  }

  /* ============================================================
     UI STATE
     ============================================================ */
  function setGauge(finalBytes, tBytes) {
    if (finalBytes == null) {
      gFill.style.strokeDashoffset = GAUGE_LEN;
      gVal.textContent = '—';
      gUnit.textContent = 'IDLE';
      gFill.classList.remove('ok', 'over');
      return;
    }
    const ratio = finalBytes / tBytes;
    const pct = Math.min(ratio, 1.35);
    gFill.style.strokeDashoffset = GAUGE_LEN * (1 - Math.min(pct / 1.35, 1));
    gFill.classList.toggle('ok', ratio <= 1.02);
    gFill.classList.toggle('over', ratio > 1.02);
    gVal.textContent = Math.round(ratio * 100) + '%';
    gUnit.textContent = ratio <= 1.02 ? 'ON TARGET' : 'OVER TARGET';
  }

  function renderQueue() {
    let list = document.querySelector('.filelist');
    if (!queue.length) { if (list) list.remove(); return; }
    if (!list) {
      list = document.createElement('div');
      list.className = 'filelist';
      drop.insertAdjacentElement('afterend', list);
    }
    list.innerHTML = '';
    queue.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'fitem';
      row.innerHTML =
        '<span class="ft"></span><span class="fn"></span><span class="fs"></span>' +
        '<button class="fx" type="button" aria-label="Remove file">\u00d7</button>';
      row.querySelector('.ft').textContent = (ext(f.name) || '?').toUpperCase();
      row.querySelector('.fn').textContent = f.name;
      row.querySelector('.fs').textContent = fmtBytes(f.size);
      row.querySelector('.fx').addEventListener('click', (e) => {
        e.stopPropagation();
        queue.splice(i, 1);
        renderQueue();
        syncRun();
      });
      list.appendChild(row);
    });
  }

  function syncRun() {
    const t = targetBytes();
    const ready = queue.length > 0 && t !== null && !busy;
    runBtn.disabled = !ready;
    if (busy) return;

    hint.className = 'hint';
    if (!queue.length) {
      hint.textContent = 'Awaiting source file\u2026';
    } else if (t === null) {
      hint.textContent = 'Enter a target size greater than zero.';
      hint.className = 'hint warn';
    } else {
      const total = queue.reduce((s, f) => s + f.size, 0);
      hint.textContent = queue.length + ' file' + (queue.length > 1 ? 's' : '') +
        ' \u00b7 ' + fmtBytes(total) + ' queued \u00b7 target ' + fmtBytes(t) + ' each';
    }
  }

  function addFiles(files) {
    const rejected = [];
    Array.from(files).forEach((f) => {
      if (!ACCEPT.includes(ext(f.name))) { rejected.push(f.name); return; }
      if (queue.some((q) => q.name === f.name && q.size === f.size)) return;
      queue.push(f);
    });
    renderQueue();
    syncRun();
    if (rejected.length) {
      hint.textContent = 'Skipped unsupported: ' + rejected.join(', ');
      hint.className = 'hint err';
    }
  }

  /* ============================================================
     CORE SEARCH — quality binary search at a fixed scale
     Returns the largest blob that still fits under `limit`,
     plus the best (smallest) blob seen in case nothing fits.
     ============================================================ */
  async function searchQuality(source, scale, limit, minQ, onStep) {
    const canvas = rescale(source, scale);
    let lo = minQ, hi = 0.95, best = null, bestQ = 0, smallest = null, smallestQ = 0;
    let passes = 0;

    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      const blob = await canvasToBlob(canvas, 'image/jpeg', q);
      passes++;
      if (!blob) break;

      if (!smallest || blob.size < smallest.size) { smallest = blob; smallestQ = q; }
      if (onStep) onStep(blob.size, q, scale);

      if (blob.size <= limit) {
        if (!best || blob.size > best.size) { best = blob; bestQ = q; }
        lo = q;                     // room to spare — push quality up
      } else {
        hi = q;                     // too heavy — pull quality down
      }
      if (hi - lo < 0.012) break;
    }

    // Nothing fit within the allowed quality band? Probe the floor explicitly,
    // so a legitimately-reachable target isn't missed by the bisection path.
    if (!best) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', minQ);
      passes++;
      if (blob) {
        if (!smallest || blob.size < smallest.size) { smallest = blob; smallestQ = minQ; }
        if (blob.size <= limit) { best = blob; bestQ = minQ; }
      }
    }
    return { best, bestQ, smallest, smallestQ, passes, width: canvas.width, height: canvas.height };
  }

  /* ============================================================
     IMAGE PIPELINE
     ============================================================ */
  async function processImage(file, limit) {
    const img = await loadImage(file);
    log('decoded ' + img.naturalWidth + '\u00d7' + img.naturalHeight + ' px');

    const scales = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.26, 0.19, 0.13, 0.09];
    let fallback = null, fallbackMeta = null, totalPasses = 0;

    /* Two sweeps. The first keeps quality at a readable floor (45%) and shrinks
       resolution to reach the target — a smaller sharp image beats a full-size
       smeared one. Only if that fails do we allow deep quality loss. */
    const sweeps = [
      { minQ: 0.45, label: 'pass A \u00b7 quality floor 45%' },
      { minQ: 0.05, label: 'pass B \u00b7 quality unlocked' }
    ];

    for (const sweep of sweeps) {
      log(sweep.label, 'dim');
      for (const scale of scales) {
        const r = await searchQuality(img, scale, limit, sweep.minQ, (size, q) => {
          log('scale ' + Math.round(scale * 100) + '% q' + q.toFixed(2) +
              ' \u2192 ' + fmtBytes(size), size <= limit ? null : 'dim');
        });
        totalPasses += r.passes;

        if (r.best) {
          return {
            blob: r.best, quality: r.bestQ, scale: scale, passes: totalPasses,
            width: r.width, height: r.height, hit: true
          };
        }
        if (r.smallest && (!fallback || r.smallest.size < fallback.size)) {
          fallback = r.smallest;
          fallbackMeta = { quality: r.smallestQ, scale: scale, width: r.width, height: r.height };
        }
        await nextFrame();
      }
    }

    log('target unreachable \u2014 returning smallest achievable', 'amber');
    return {
      blob: fallback, quality: fallbackMeta.quality, scale: fallbackMeta.scale,
      passes: totalPasses, width: fallbackMeta.width, height: fallbackMeta.height, hit: false
    };
  }

  /* ============================================================
     PDF PIPELINE — rasterise pages, then rebuild under the limit
     ============================================================ */
  async function renderPdfPages(file) {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    const RENDER_SCALE = 1.6;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      pages.push(c);
      log('rasterised page ' + p + '/' + pdf.numPages);
      await nextFrame();
    }
    pdf.destroy();
    return pages;
  }

  /* Build a PDF from rasterised pages at a given jpeg quality + scale. */
  async function buildPdf(pages, quality, scale) {
    const { jsPDF } = window.jspdf;
    let doc = null;

    for (let i = 0; i < pages.length; i++) {
      const scaled = rescale(pages[i], scale);
      const dataUrl = scaled.toDataURL('image/jpeg', quality);
      const pw = scaled.width, ph = scaled.height;
      const orient = pw >= ph ? 'l' : 'p';

      if (!doc) {
        doc = new jsPDF({ orientation: orient, unit: 'pt', format: [pw, ph], compress: true });
      } else {
        doc.addPage([pw, ph], orient);
      }
      doc.addImage(dataUrl, 'JPEG', 0, 0, pw, ph);
    }
    return doc ? doc.output('blob') : null;
  }

  async function processPdf(file, limit) {
    if (!window.pdfjsLib || !window.jspdf) throw new Error('PDF engine failed to load');

    const pages = await renderPdfPages(file);
    if (!pages.length) throw new Error('PDF has no renderable pages');

    const scaleSteps = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.22, 0.15];
    let fallback = null, fallbackMeta = null, passes = 0;

    for (const scale of scaleSteps) {
      let lo = 0.05, hi = 0.92, best = null, bestQ = 0;

      for (let i = 0; i < 6; i++) {
        const q = (lo + hi) / 2;
        const blob = await buildPdf(pages, q, scale);
        passes++;
        if (!blob) break;

        log('scale ' + Math.round(scale * 100) + '% q' + q.toFixed(2) +
            ' \u2192 ' + fmtBytes(blob.size), blob.size <= limit ? null : 'dim');

        if (!fallback || blob.size < fallback.size) {
          fallback = blob;
          fallbackMeta = { quality: q, scale: scale };
        }
        if (blob.size <= limit) {
          if (!best || blob.size > best.size) { best = blob; bestQ = q; }
          lo = q;
        } else {
          hi = q;
        }
        if (hi - lo < 0.02) break;
        await nextFrame();
      }

      if (best) {
        return { blob: best, quality: bestQ, scale: scale, passes: passes,
                 pageCount: pages.length, hit: true };
      }
      await nextFrame();
    }

    log('target unreachable \u2014 returning smallest achievable', 'amber');
    return { blob: fallback, quality: fallbackMeta.quality, scale: fallbackMeta.scale,
             passes: passes, pageCount: pages.length, hit: false };
  }

  /* ============================================================
     PADDING — grow a file to an exact byte count without corrupting it.

     JPEG: filler appended after the EOI marker; decoders stop at EOI.
     PDF:  filler must NOT go after %%EOF — that moves the trailer and
           strict parsers then fail to locate `startxref`. Instead the
           bytes are injected into a PDF comment placed *before* the
           final trailer block, so the xref offset table stays valid.
     ============================================================ */
  async function padBlob(blob, want, kind) {
    const need = want - blob.size;
    if (need <= 0) return blob;

    if (kind !== 'pdf') {
      const filler = new Uint8Array(need).fill(0x20);
      filler[0] = 0x0a;
      return new Blob([await blob.arrayBuffer(), filler], { type: 'image/jpeg' });
    }

    // ---- PDF: pad inside a comment ahead of the trailer ----
    const buf = new Uint8Array(await blob.arrayBuffer());
    const marker = new TextEncoder().encode('startxref');
    let at = -1;
    for (let i = buf.length - marker.length; i >= 0; i--) {
      let hit = true;
      for (let j = 0; j < marker.length; j++) {
        if (buf[i + j] !== marker[j]) { hit = false; break; }
      }
      if (hit) { at = i; break; }
    }
    // No trailer found — fall back to a plain append rather than mangling it.
    if (at < 0) {
      const filler = new Uint8Array(need).fill(0x20);
      return new Blob([buf, filler], { type: 'application/pdf' });
    }

    /* Comment body: '%' + spaces + newline, wrapped every 72 cols so no
       single line grows unreasonably long. Written before `startxref`, and
       the stored xref offsets all point to earlier bytes, so they stay correct. */
    const pad = new Uint8Array(need);
    pad[0] = 0x25; // '%'
    for (let i = 1; i < need; i++) {
      pad[i] = (i % 72 === 71) ? 0x0a : 0x20;
    }
    if (need > 1) pad[need - 1] = 0x0a;
    if (need > 2 && pad[need - 2] === 0x0a) pad[need - 2] = 0x20;

    return new Blob([buf.subarray(0, at), pad, buf.subarray(at)], { type: 'application/pdf' });
  }

  /* ============================================================
     RESULT CARD
     ============================================================ */
  function addCard(o) {
    resultsWrap.hidden = false;
    const card = document.createElement('div');
    card.className = 'card' + (o.error ? ' fail' : '');

    const isImg = o.blob && o.kind === 'image';
    const thumbUrl = isImg ? URL.createObjectURL(o.blob) : null;
    const badge = o.error ? 'ERROR' : (o.hit ? (o.padded ? 'EXACT' : 'ON TARGET') : 'CLOSEST');
    const badgeCls = o.error ? 'err' : (o.hit ? '' : 'miss');

    card.innerHTML =
      '<div class="card-thumb">' +
        (thumbUrl ? '<img alt="">' : '<span class="ph">' + (o.error ? '!' : 'PDF') + '</span>') +
        '<span class="card-badge ' + badgeCls + '"></span>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-name"></div>' +
        (o.error ? '' :
          '<div class="card-nums">' +
            '<span class="n-from"></span><span class="n-arr">\u2192</span>' +
            '<span class="n-to' + (o.hit ? '' : ' miss') + '"></span>' +
            '<span class="n-pct"></span>' +
          '</div>' +
          '<div class="card-meta"></div>') +
        (o.error ? '<div class="card-meta err-msg"></div>' : '') +
      '</div>';

    if (thumbUrl) card.querySelector('img').src = thumbUrl;
    card.querySelector('.card-badge').textContent = badge;
    card.querySelector('.card-name').textContent = o.name;

    if (o.error) {
      card.querySelector('.err-msg').textContent = o.error;
    } else {
      card.querySelector('.n-from').textContent = fmtBytes(o.origSize);
      card.querySelector('.n-to').textContent = fmtBytes(o.blob.size);
      const pct = Math.round((1 - o.blob.size / o.origSize) * 100);
      card.querySelector('.n-pct').textContent = (pct >= 0 ? '\u2212' + pct : '+' + -pct) + '%';

      const bits = ['quality ' + Math.round(o.quality * 100) + '%',
                    'scale ' + Math.round(o.scale * 100) + '%'];
      if (o.dims) bits.push(o.dims);
      if (o.pageCount) bits.push(o.pageCount + ' page' + (o.pageCount > 1 ? 's' : ''));
      if (o.padded) bits.push('padded to exact');
      card.querySelector('.card-meta').textContent = bits.join(' \u00b7 ');

      const a = document.createElement('a');
      a.className = 'dl';
      a.href = URL.createObjectURL(o.blob);
      a.download = o.outName;
      a.innerHTML = '<span>DOWNLOAD</span><span aria-hidden="true">\u2193</span>';
      card.querySelector('.card-body').appendChild(a);

      /* If the frame can't save, don't leave a dead-looking button:
         try the File System Access API, then fall back to guidance. */
      a.addEventListener('click', async (ev) => {
        if (!downloadsBlocked()) return;         // normal tab — let the browser handle it
        ev.preventDefault();

        if (typeof window.showSaveFilePicker === 'function') {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: o.outName });
            const w = await handle.createWritable();
            await w.write(o.blob);
            await w.close();
            a.querySelector('span').textContent = 'SAVED';
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return;   // user cancelled
          }
        }
        showFrameWarning();
        document.getElementById('frameWarn')
          .scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    results.prepend(card);
  }

  /* ============================================================
     RUN
     ============================================================ */
  async function run() {
    const limit = targetBytes();
    if (busy || !queue.length || limit === null) return;

    busy = true;
    runBtn.disabled = true;
    runBtn.classList.add('busy');
    runBtn.querySelector('.run-lab').textContent = 'SCANNING\u2026';
    document.body.classList.add('scanning');
    clearLog();

    const batch = queue.slice();
    let done = 0;

    for (const file of batch) {
      const kind = ext(file.name) === 'pdf' ? 'pdf' : 'image';
      hint.className = 'hint';
      hint.textContent = 'Processing ' + (done + 1) + ' of ' + batch.length + ' \u2014 ' + file.name;

      log('\u2014\u2014 ' + file.name + ' (' + fmtBytes(file.size) + ') \u2014\u2014', 'amber');
      sOrig.textContent = fmtBytes(file.size);
      sTarget.textContent = fmtBytes(limit);

      try {
        if (kind === 'image' && file.size <= limit && !padToggle.checked) {
          log('already under target \u2014 passing through unchanged');
          addCard({
            name: file.name, outName: file.name, kind: kind, blob: file,
            origSize: file.size, quality: 1, scale: 1, hit: true, padded: false
          });
          setGauge(file.size, limit);
          sFinal.textContent = fmtBytes(file.size);
          sDelta.textContent = '0%';
          sQual.textContent = '100%';
          sIter.textContent = '0';
          done++;
          continue;
        }

        const res = kind === 'pdf'
          ? await processPdf(file, limit)
          : await processImage(file, limit);

        if (!res || !res.blob) throw new Error('Engine produced no output');

        let out = res.blob;
        let padded = false;
        if (padToggle.checked && out.size < limit) {
          const before = out.size;
          out = await padBlob(out, limit, kind);
          padded = out.size > before;
          if (padded) log('padded ' + fmtBytes(before) + ' \u2192 ' + fmtBytes(out.size) + ' (exact)');
        }

        const outName = baseName(file.name) + '-resized.' + (kind === 'pdf' ? 'pdf' : 'jpg');
        log('final ' + fmtBytes(out.size) + ' in ' + res.passes + ' passes',
            res.hit ? null : 'amber');

        addCard({
          name: file.name, outName: outName, kind: kind, blob: out,
          origSize: file.size, quality: res.quality, scale: res.scale,
          hit: res.hit, padded: padded, pageCount: res.pageCount,
          dims: res.width ? res.width + '\u00d7' + res.height + ' px' : null
        });

        setGauge(out.size, limit);
        sFinal.textContent = fmtBytes(out.size);
        const red = Math.round((1 - out.size / file.size) * 100);
        sDelta.textContent = (red >= 0 ? '\u2212' + red : '+' + -red) + '%';
        sDelta.className = red >= 0 ? 'good' : 'bad';
        sFinal.className = res.hit ? 'good' : 'bad';
        sQual.textContent = Math.round(res.quality * 100) + '%';
        sIter.textContent = String(res.passes);
      } catch (err) {
        log('FAILED: ' + (err && err.message ? err.message : err), 'red');
        addCard({ name: file.name, error: (err && err.message) || 'Unknown error' });
      }
      done++;
      await nextFrame();
    }

    busy = false;
    document.body.classList.remove('scanning');
    runBtn.classList.remove('busy');
    runBtn.querySelector('.run-lab').textContent = 'SCAN & RESIZE';
    log('batch complete \u2014 ' + done + ' file' + (done > 1 ? 's' : '') + ' processed', 'amber');
    syncRun();
  }

  /* ============================================================
     EVENTS
     ============================================================ */
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // Page-level guards so a stray drop never navigates away.
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); }));

  document.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) {
      addFiles(files.map((f, i) =>
        f.name && f.name !== 'image.png'
          ? f
          : new File([f], 'pasted-' + Date.now() + '-' + i + '.png', { type: f.type })));
    }
  });

  sizeInput.addEventListener('input', syncRun);

  document.querySelectorAll('.unit').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.unit').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      unit = btn.dataset.unit;
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      syncRun();
    });
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sizeInput.value = chip.dataset.v;
      const target = Array.from(document.querySelectorAll('.unit'))
        .find((u) => u.dataset.unit === chip.dataset.u);
      if (target && !target.classList.contains('active')) target.click();
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      syncRun();
    });
  });

  padToggle.addEventListener('change', syncRun);
  runBtn.addEventListener('click', run);

  clearBtn.addEventListener('click', () => {
    results.innerHTML = '';
    resultsWrap.hidden = true;
    setGauge(null);
    [sOrig, sTarget, sFinal, sDelta, sQual, sIter].forEach((el) => {
      el.textContent = '\u2014';
      el.className = '';
    });
    clearLog();
    log('engine idle', 'dim');
  });

  /* ---------- boot ---------- */
  setGauge(null);
  syncRun();
  if (downloadsBlocked()) showFrameWarning();
})();
