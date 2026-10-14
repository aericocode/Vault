/* =========================================================================
   TEMPORARY dev-only mock of the face model API (FACE_MODELS_SPEC). REMOVE
   this file and its loader line in db-viewer.html once the server side
   (branch faces) is merged.

   Loaded only when localStorage.vaultModelsMock === '1'. It wraps fetch and
   answers the parts the dev server does not have yet, on top of the real
   answers:
     GET  /api/faces/status            + facesModel, activeModel, needsModel,
                                         faceModels, download, modelSwitch
     POST /api/faces/settings          { model } handled here, the rest forwarded
     POST /api/faces/models/download   { model } handled here (consent, progress)
     GET/POST /api/settings/model-downloads   face:keeper-* consents kept here
     POST /api/faces/model-switch/pause|resume
   State lives in localStorage.vaultModelsMockState, so a reload keeps it.
   Console: vaultModelsMock.reset(), .state(), .set({...}), .failNext()
   ========================================================================= */
(() => {
  const STORE = 'vaultModelsMockState';
  const IDS = { ir50: 'adaface-ir50-webface4m', ir101: 'adaface-ir101-webface12m' };
  const BYTES = { ir50: 174e6, ir101: 261e6 };
  const DL_BPS = 30e6;          // 261 MB in about 9 s
  const SWITCH_FPS = 100;       // 4,300 files in about 43 s
  const nameOf = (id) => Object.keys(IDS).find(n => IDS[n] === id || n === id) || null;

  const fresh = () => ({
    chosen: 'ir50', active: 'ir50',
    present: { ir50: true, ir101: false },
    consent: { ir50: true, ir101: false },
    dl: null, sw: null, last: null, failNext: false, at: Date.now(),
  });
  let st;
  try { st = JSON.parse(localStorage.getItem(STORE)) || fresh(); } catch { st = fresh(); }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch {} };

  function startSwitch(from, to) {
    st.sw = { from: IDS[from], to: IDS[to], done: 0, total: 4300, namedDone: 0, namedTotal: 40, paused: false, startedAt: Date.now() };
  }

  /** Move the fake download and switch along by the time since the last call. */
  function tick() {
    const now = Date.now();
    const dt = Math.max(0, (now - (st.at || now)) / 1000);
    st.at = now;
    const dl = st.dl;
    if (dl && dl.running) {
      dl.received = Math.min(dl.total, dl.received + dt * DL_BPS);
      if (dl.fail && dl.received > dl.total * 0.4) {
        Object.assign(dl, { running: false, error: 'fetch failed' });
      } else if (dl.received >= dl.total) {
        dl.running = false;
        st.present[dl.model] = true;
        st.dl = null;
        if (st.chosen === dl.model && st.active !== dl.model && !st.sw) startSwitch(st.active, dl.model);
      }
    }
    const sw = st.sw;
    if (sw && !sw.paused) {
      sw.done = Math.min(sw.total, sw.done + dt * SWITCH_FPS);
      if (sw.done >= sw.total) {
        st.active = nameOf(sw.to);
        st.last = { from: sw.from, to: sw.to, finishedAt: now };
        st.sw = null;
      }
    }
    save();
  }

  function overlay(real) {
    tick();
    const sw = st.sw;
    const out = {
      ...real,
      facesModel: st.chosen,
      activeModel: IDS[st.active],
      needsModel: st.present[st.chosen] ? null : st.chosen,
      faceModels: Object.fromEntries(Object.keys(IDS).map(n => [n, {
        key: `face:keeper-${n}`, label: n === 'ir50' ? 'Standard' : 'Best', modelId: IDS[n],
        present: !!st.present[n], reason: st.present[n] ? null : 'absent', consent: !!st.consent[n],
        bytes: BYTES[n], downloading: !!(st.dl && st.dl.running && st.dl.model === n),
      }])),
      lastModelSwitch: st.last,
      modelSwitch: sw ? {
        from: sw.from, to: sw.to, total: sw.total, done: Math.floor(sw.done), paused: sw.paused,
        running: !sw.paused, startedAt: sw.startedAt,
        etaS: sw.paused ? null : Math.round((sw.total - sw.done) / SWITCH_FPS),
        // Named people's files are the first tenth of the run.
        namedTotal: sw.namedTotal,
        namedDone: Math.min(sw.namedTotal, Math.floor((sw.done / (sw.total * 0.1)) * sw.namedTotal)),
        current: [], fallbacks: 0, failed: 0,
      } : null,
    };
    if (st.dl) out.download = { running: st.dl.running, model: st.dl.model, received: st.dl.received, total: st.dl.total, error: st.dl.error || null };
    return out;
  }

  function choose(model) {
    if (!IDS[model] || model === st.chosen) return;
    st.chosen = model;
    const sw = st.sw;
    if (sw) {
      // Go back: the files already moved are the ones left to move now.
      st.sw = { ...sw, from: sw.to, to: sw.from, done: sw.total - sw.done, startedAt: Date.now() };
      if (nameOf(st.sw.to) === st.active && st.sw.done >= st.sw.total) st.sw = null;
    } else if (model !== st.active && st.present[model]) {
      startSwitch(st.active, model);
    }
    save();
  }

  const realFetch = window.fetch.bind(window);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const realStatus = async (headers) => (await realFetch('/api/faces/status', { headers })).json();
  const parse = (body) => { try { return JSON.parse(body || '{}'); } catch { return {}; } };

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname;
    const method = (init.method || 'GET').toUpperCase();
    tick();

    if (path === '/api/faces/status' && method === 'GET') {
      const r = await realFetch(input, init);
      if (!r.ok) return r;
      return json(overlay(await r.json()));
    }
    if (path === '/api/faces/settings' && method === 'POST') {
      const { model, facesModel, ...rest } = parse(init.body);
      const m = model ?? facesModel;
      if (m !== undefined) {
        if (!IDS[m]) return json({ error: 'model must be one of ir50, ir101', code: 'BAD_SETTING' }, 400);
        choose(m);
      }
      if (Object.keys(rest).length) {
        const r = await realFetch(input, { ...init, body: JSON.stringify(rest) });
        if (!r.ok) return r;
        return json(overlay(await r.json()));
      }
      return json(overlay(await realStatus(init.headers)));
    }
    if (path === '/api/faces/models/download' && method === 'POST') {
      const { model } = parse(init.body);
      if (model === undefined) return realFetch(input, init);
      if (!IDS[model]) return json({ error: 'bad model', code: 'BAD_SETTING' }, 400);
      if (!st.present[model] && !(st.dl && st.dl.running)) {
        if (!st.consent[model]) return json({ error: 'consent needed', code: 'CONSENT_NEEDED', keys: [`face:keeper-${model}`] }, 409);
        st.dl = { running: true, model, received: 0, total: BYTES[model], error: null, fail: st.failNext };
        st.failNext = false;
        save();
      }
      return json(overlay(await realStatus(init.headers)));
    }
    if (path === '/api/settings/model-downloads') {
      if (method === 'POST') {
        const { key, allow } = parse(init.body);
        const n = /^face:keeper-(ir50|ir101)$/.exec(key || '');
        if (n) { st.consent[n[1]] = !!allow; save(); return json({ ok: true, allowed: !!allow }); }
        return realFetch(input, init);
      }
      const r = await realFetch(input, init);
      if (!r.ok) return r;
      const d = await r.json();
      d.consents = { ...(d.consents || {}), 'face:keeper-ir50': !!st.consent.ir50, 'face:keeper-ir101': !!st.consent.ir101 };
      return json(d);
    }
    const sw = /^\/api\/faces\/model-switch\/(pause|resume)$/.exec(path);
    if (sw && method === 'POST') {
      if (st.sw) { st.sw.paused = sw[1] === 'pause'; save(); }
      return json(overlay(await realStatus(init.headers)));
    }
    return realFetch(input, init);
  };

  window.vaultModelsMock = {
    state: () => JSON.parse(JSON.stringify(st)),
    reset: () => { st = fresh(); save(); },
    set: (patch) => { Object.assign(st, patch); save(); },
    /** The next keeper download stops at 40% with an error. */
    failNext: () => { st.failNext = true; save(); },
  };
  console.warn('[Faces] model API mock is ON (localStorage.vaultModelsMock). Remove with: delete localStorage.vaultModelsMock');
})();
