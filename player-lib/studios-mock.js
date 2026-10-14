/* =========================================================================
   TEMPORARY DEV-ONLY MOCK of the Studios server routes (STUDIOS_SPEC
   section 2). REMOVE once server/studios-routes.js is merged.

   Loaded only when localStorage.vaultStudiosMock === '1' (the REMOVE line in
   db-viewer.html). Wraps window.fetch and answers the studio routes from an
   in-browser store (kept in localStorage 'vaultStudiosMockDb' so a reload
   keeps it; delete that key to start over). Everything else goes to the real
   server, with a few answers patched the way the real routes will be:
     POST /api/library/query     studioId -> onlyIds (the studio's files)
     POST /api/media/rows, GET /api/media/:id, query page rows: studio_id + studio
     GET/POST /api/faces/people/:id: the person details and their studios
     GET /api/faces/people?q=:   people found by their other names too
   Seed data fits the face test library (Vault-scratch/faces-lib).
   ========================================================================= */
(function () {
  const realFetch = window.fetch.bind(window);
  const KEY = 'vaultStudiosMockDb';
  const now = () => new Date().toISOString();

  function seed() {
    const t = '2026-10-01T10:00:00.000Z';
    return {
      nextId: 4,
      studios: [
        { id: 1, name: 'The White House', aliases: 'White House, WH', urls: 'https://www.whitehouse.gov',
          description: 'Official photos and video from the administration. Press briefings, portraits and events.',
          notes: 'Still missing the 2013 inauguration videos. Check the D:\\Media\\Archive drive.',
          yearStart: 2009, yearEnd: 2017, favorite: true, coverKind: 'frame', coverRef: '9:0', coverUrl: '/thumb/9', createdAt: t, updatedAt: t },
        { id: 2, name: 'NASA', aliases: 'ISS', urls: 'https://www.nasa.gov', description: 'Crew photos from the space station.',
          notes: '', yearStart: 2024, yearEnd: null, favorite: false, coverKind: 'frame', coverRef: '4:0', coverUrl: '/thumb/4', createdAt: '2026-10-05T10:00:00.000Z', updatedAt: t },
        { id: 3, name: 'Family videos', aliases: 'Home videos, imports', urls: '', description: '', notes: '',
          yearStart: null, yearEnd: null, favorite: false, coverKind: null, coverRef: null, coverUrl: null, createdAt: '2026-10-09T10:00:00.000Z', updatedAt: t },
      ],
      media: { 1: 1, 2: 1, 3: 1, 5: 1, 7: 1, 9: 1, 10: 1, 11: 1, 13: 1, 15: 1, 4: 2, 6: 2, 14: 2, 16: 3, 17: 3 },
      members: [
        { studioId: 1, personId: 1, yearStart: 2009, yearEnd: 2017 },
        { studioId: 1, personId: 2, yearStart: 2009, yearEnd: 2017 },
      ],
      people: {
        1: { aliases: 'Barry, President Obama', urls: 'https://www.obama.org', description: '44th President of the United States.',
          notes: 'Most photos are from the 2012 trip.', yearStart: 2005, yearEnd: 2017, born: '1961-08-04' },
      },
    };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (!db || !Array.isArray(db.studios)) db = seed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  save();

  /* ── What the real server knows: files, people, faces per file ── */
  let rows = null;                     // id -> { id, filepath, media_type, duration_seconds, user_trashed }
  let facesByMedia = null;             // id -> Set(personId)
  let peopleById = new Map();          // id -> { id, name, coverUrl }
  async function loadRows() {
    if (rows) return rows;
    const r = await realFetch('/api/library/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageSize: 500 }) }).then(x => x.json());
    rows = new Map();
    for (const m of (r.page && r.page.rows) || []) rows.set(m.id, m);
    return rows;
  }
  async function loadPeople() {
    try {
      const r = await realFetch('/api/faces/people?filter=all&sort=name&limit=1000').then(x => x.ok ? x.json() : { people: [] });
      peopleById = new Map((r.people || []).map(p => [p.id, p]));
    } catch { peopleById = new Map(); }
    return peopleById;
  }
  async function loadFaces() {
    if (facesByMedia) return facesByMedia;
    const map = new Map();
    await loadRows();
    const st = await realFetch('/api/faces/status').then(x => x.ok ? x.json() : {}).catch(() => ({}));
    if (st.enabled) {
      await Promise.all([...rows.keys()].map(async (id) => {
        try {
          const f = await realFetch(`/api/media/${id}/faces`).then(x => x.ok ? x.json() : null);
          map.set(id, new Set(((f && f.groups) || []).map(g => g.personId).filter(Boolean)));
        } catch {}
      }));
    }
    facesByMedia = map;
    return map;
  }

  /* ── Store helpers ── */
  const byId = (id) => db.studios.find(s => s.id === Number(id));
  const keyOf = (name) => String(name || '').trim().toLowerCase();
  const filesOf = (sid) => Object.entries(db.media).filter(([mid, s]) => s === sid && (!rows || (rows.has(Number(mid)) && !rows.get(Number(mid)).user_trashed))).map(([mid]) => Number(mid)).sort((a, b) => a - b);
  const isVideo = (mid) => rows && rows.get(mid) && rows.get(mid).media_type === 'video';
  const isPhoto = (mid) => rows && rows.get(mid) && ['image', 'gif'].includes(rows.get(mid).media_type);
  function coverUrl(s) {
    if (s.coverUrl) return s.coverUrl;
    const f = filesOf(s.id)[0];
    return f ? `/thumb/${f}` : null;                    // NULL cover = the first file's thumbnail
  }
  function peopleOf(s) {
    const out = new Map();
    for (const m of db.members.filter(x => x.studioId === s.id)) {
      const p = peopleById.get(m.personId);
      if (!p) continue;
      out.set(p.id, { id: p.id, name: p.name, cropUrl: p.coverUrl, yearStart: m.yearStart, yearEnd: m.yearEnd, explicit: true });
    }
    for (const mid of filesOf(s.id)) {
      for (const pid of (facesByMedia && facesByMedia.get(mid)) || []) {
        if (out.has(pid)) continue;
        const p = peopleById.get(pid);
        if (p && !p.hidden) out.set(pid, { id: p.id, name: p.name, cropUrl: p.coverUrl, yearStart: null, yearEnd: null, explicit: false });
      }
    }
    return [...out.values()];
  }
  function summary(s) {
    const files = filesOf(s.id);
    const people = peopleOf(s);
    return {
      id: s.id, name: s.name, yearStart: s.yearStart, yearEnd: s.yearEnd, favorite: !!s.favorite, coverUrl: coverUrl(s),
      files: files.length, videos: files.filter(isVideo).length, photos: files.filter(isPhoto).length,
      people: people.length, peoplePreview: people.slice(0, 5).map(p => ({ id: p.id, name: p.name, cropUrl: p.cropUrl })),
    };
  }
  function full(s) {
    return { ...summary(s), aliases: s.aliases || '', urls: s.urls || '', description: s.description || '', notes: s.notes || '',
      coverKind: s.coverKind || null, createdAt: s.createdAt, updatedAt: s.updatedAt, people: peopleOf(s) };
  }
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const bad = (error, code = 'BAD_INPUT') => json({ error, code }, 400);

  function checkYears(a, b) {
    for (const y of [a, b]) if (y != null && (!Number.isInteger(y) || y < 1800 || y > 2100)) return 'Years need to be between 1800 and 2100.';
    if (a != null && b != null && b < a) return 'The last year cannot be before the first.';
    return '';
  }
  function applyFields(s, b) {
    if (b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name || name.length > 200) return 'A studio needs a name (200 characters at most).';
      if (db.studios.some(x => x.id !== s.id && keyOf(x.name) === keyOf(name))) return { taken: true };
      s.name = name;
    }
    for (const k of ['aliases', 'urls', 'description', 'notes']) {
      if (b[k] === undefined) continue;
      if (String(b[k] || '').length > 5000) return 'Text fields hold 5,000 characters at most.';
      s[k] = String(b[k] || '');
    }
    const ys = b.yearStart !== undefined ? b.yearStart : s.yearStart;
    const ye = b.yearEnd !== undefined ? b.yearEnd : s.yearEnd;
    const e = checkYears(ys, ye);
    if (e) return e;
    s.yearStart = ys; s.yearEnd = ye;
    if (b.favorite !== undefined) s.favorite = !!b.favorite;
    s.updatedAt = now();
    return '';
  }

  /** Folder words: split on \ / space . _ - */
  const words = (t) => String(t).toLowerCase().split(/[\\/\s._-]+/).filter(Boolean);
  function folderMatches() {
    const byFolder = new Map();
    for (const m of rows.values()) {
      if (m.user_trashed) continue;
      const folder = m.filepath.replace(/[\\/][^\\/]*$/, '');
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(m.id);
    }
    const out = [];
    for (const [folder, ids] of byFolder) {
      const fw = words(folder);
      for (const s of db.studios) {
        const terms = [s.name, ...String(s.aliases || '').split(',')].map(words).filter(w => w.length);
        const hit = terms.some(tw => fw.some((_, i) => tw.every((w, j) => fw[i + j] === w)));
        if (!hit) continue;
        const already = ids.filter(id => db.media[id] != null).length;
        out.push({ folder, studioId: s.id, studioName: s.name, files: ids.length - already, alreadyInStudio: already });
      }
    }
    return out;
  }

  /* ── Person details ── */
  const PKEYS = ['aliases', 'urls', 'description', 'notes', 'yearStart', 'yearEnd', 'born'];
  function personExtras(pid) {
    const d = db.people[pid] || {};
    const studios = [];
    for (const m of db.members.filter(x => x.personId === pid)) {
      const s = byId(m.studioId);
      if (s) studios.push({ id: s.id, name: s.name, coverUrl: coverUrl(s), yearStart: m.yearStart, yearEnd: m.yearEnd, explicit: true });
    }
    for (const s of db.studios) {
      if (studios.some(x => x.id === s.id)) continue;
      if (filesOf(s.id).some(mid => facesByMedia && facesByMedia.get(mid) && facesByMedia.get(mid).has(pid))) {
        studios.push({ id: s.id, name: s.name, coverUrl: coverUrl(s), yearStart: null, yearEnd: null, explicit: false });
      }
    }
    return { aliases: d.aliases || '', urls: d.urls || '', description: d.description || '', notes: d.notes || '',
      yearStart: d.yearStart ?? null, yearEnd: d.yearEnd ?? null, born: d.born || null, studios };
  }

  function patchRow(r) {
    if (!r || r.id == null) return r;
    const sid = db.media[r.id];
    const s = sid != null ? byId(sid) : null;
    r.studio_id = s ? s.id : null;
    r.studio = s ? { id: s.id, name: s.name } : null;
    return r;
  }

  async function bodyOf(init) {
    if (!init || init.body == null) return {};
    if (typeof init.body === 'string') { try { return JSON.parse(init.body); } catch { return {}; } }
    return init.body;
  }

  async function handle(url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const p = url.pathname;
    let m;

    // ── Passthroughs the real routes will answer differently ──
    if (p === '/api/library/query' && method === 'POST') {
      const b = await bodyOf(init);
      if (b.studioId != null) {
        await loadRows();
        // onlyIds skips every other filter on the server, so the type switch is done here.
        const types = (b.filters && b.filters.mediaTypes) || [];
        const ids = filesOf(Number(b.studioId)).filter(id => !types.length || types.includes(rows.get(id).media_type));
        b.onlyIds = Array.isArray(b.onlyIds) ? b.onlyIds.filter(id => ids.includes(id)) : ids;
        if (!b.onlyIds.length) b.onlyIds = [-1];
      }
      delete b.studioId;
      const resp = await realFetch('/api/library/query', { ...init, body: JSON.stringify(b) });
      const data = await resp.json().catch(() => ({}));
      if (data.page && data.page.rows) data.page.rows.forEach(patchRow);
      return json(data, resp.status);
    }
    if (p === '/api/media/rows' && method === 'POST') {
      const resp = await realFetch(p, init);
      const data = await resp.json().catch(() => ({}));
      (data.rows || []).forEach(patchRow);
      return json(data, resp.status);
    }
    if ((m = /^\/api\/media\/(\d+)$/.exec(p)) && method === 'GET') {
      const resp = await realFetch(url.href, init);
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) patchRow(data);
      return json(data, resp.status);
    }
    if ((m = /^\/api\/faces\/people\/(\d+)$/.exec(p))) {
      const pid = Number(m[1]);
      await loadFaces();
      if (method === 'POST') {
        const b = await bodyOf(init);
        const d = { ...(db.people[pid] || {}) };
        let touched = false;
        for (const k of PKEYS) if (b[k] !== undefined) { d[k] = b[k]; touched = true; delete b[k]; }
        if (touched) {
          const e = checkYears(d.yearStart ?? null, d.yearEnd ?? null);
          if (e) return bad(e);
          if (d.born && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d.born)) return bad('Born needs to look like 1961, 1961-08 or 1961-08-04.');
        }
        let person;
        if (Object.keys(b).length) {
          const resp = await realFetch(url.href, { ...init, body: JSON.stringify(b) });
          person = await resp.json().catch(() => ({}));
          if (!resp.ok) return json(person, resp.status);
        } else {
          const resp = await realFetch(url.href);
          person = await resp.json().catch(() => ({}));
          if (!resp.ok) return json(person, resp.status);
        }
        if (touched) { db.people[pid] = d; save(); }
        return json({ ...person, ...personExtras(pid) });
      }
      const resp = await realFetch(url.href, init);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return json(data, resp.status);
      return json({ ...data, ...personExtras(pid) });
    }
    if (p === '/api/faces/people' && method === 'GET' && url.searchParams.get('q')) {
      const resp = await realFetch(url.href, init);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return json(data, resp.status);
      const q = url.searchParams.get('q').toLowerCase();
      const have = new Set((data.people || []).map(x => x.id));
      const limit = Number(url.searchParams.get('limit') || 200);
      const extra = Object.entries(db.people).filter(([pid, d]) => !have.has(Number(pid)) && String(d.aliases || '').toLowerCase().includes(q)).map(([pid]) => Number(pid));
      for (const pid of extra) {
        if ((data.people || []).length >= limit) break;
        const r = await realFetch(`/api/faces/people/${pid}`).then(x => x.ok ? x.json() : null).catch(() => null);
        if (r) { data.people.push(r); data.total = (data.total || 0) + 1; }
      }
      return json(data);
    }

    // ── Studio routes ──
    if (!p.startsWith('/api/studios') && p !== '/api/media/studio') return null;
    await Promise.all([loadRows(), loadFaces(), loadPeople()]);

    if (p === '/api/studios' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const sort = url.searchParams.get('sort') || 'files';
      const filter = url.searchParams.get('filter') || 'all';
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 200);
      let list = db.studios.filter(s => !q || s.name.toLowerCase().includes(q) || String(s.aliases || '').toLowerCase().includes(q));
      const counts = { all: list.length, favorites: list.filter(s => s.favorite).length, nophoto: list.filter(s => !s.coverKind).length };
      if (filter === 'favorites') list = list.filter(s => s.favorite);
      if (filter === 'nophoto') list = list.filter(s => !s.coverKind);
      let out = list.map(s => ({ s, sum: summary(s) }));
      const byName = (a, b) => a.s.name.localeCompare(b.s.name);
      if (sort === 'name') out.sort(byName);
      else if (sort === 'recent') out.sort((a, b) => String(b.s.createdAt).localeCompare(String(a.s.createdAt)));
      else if (sort === 'years') out.sort((a, b) => (a.s.yearStart ?? 99999) - (b.s.yearStart ?? 99999) || byName(a, b));
      else out.sort((a, b) => b.sum.files - a.sum.files || byName(a, b));
      return json({ total: out.length, counts, studios: out.slice(offset, offset + limit).map(x => x.sum) });
    }
    if (p === '/api/studios' && method === 'POST') {
      const b = await bodyOf(init);
      const s = { id: db.nextId, name: '', aliases: '', urls: '', description: '', notes: '', yearStart: null, yearEnd: null,
        favorite: false, coverKind: null, coverRef: null, coverUrl: null, createdAt: now(), updatedAt: now() };
      const e = applyFields(s, { name: b.name, ...b });
      if (e && e.taken) { const o = db.studios.find(x => keyOf(x.name) === keyOf(b.name)); return json({ error: 'There is already a studio with that name.', code: 'NAME_TAKEN', other: { id: o.id, name: o.name } }, 409); }
      if (e) return bad(e);
      db.nextId++;
      db.studios.push(s);
      save();
      return json(full(s));
    }
    if (p === '/api/media/studio' && method === 'POST') {
      const b = await bodyOf(init);
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
      if (!ids.length || ids.length > 5000) return bad('ids: 1 to 5000');
      const sid = b.studioId == null ? null : Number(b.studioId);
      if (sid != null && !byId(sid)) return json({ error: 'not found', code: 'NOT_FOUND' }, 404);
      let changed = 0;
      for (const id of ids) {
        if ((db.media[id] ?? null) === sid) continue;
        if (sid == null) delete db.media[id]; else db.media[id] = sid;
        changed++;
      }
      save();
      return json({ changed });
    }
    if (p === '/api/studios/auto/preview' && method === 'POST') return json({ matches: folderMatches() });
    if (p === '/api/studios/auto/apply' && method === 'POST') {
      const b = await bodyOf(init);
      let changed = 0;
      for (const pair of b.pairs || []) {
        if (!byId(pair.studioId)) continue;
        for (const r of rows.values()) {
          if (r.user_trashed || db.media[r.id] != null) continue;
          if (r.filepath.replace(/[\\/][^\\/]*$/, '') !== pair.folder) continue;
          db.media[r.id] = Number(pair.studioId);
          changed++;
        }
      }
      save();
      return json({ changed });
    }

    if (!(m = /^\/api\/studios\/(\d+)(\/.*)?$/.exec(p))) return json({ error: 'not found' }, 404);
    const s = byId(m[1]);
    const rest = m[2] || '';
    if (!s) return json({ error: 'not found', code: 'NOT_FOUND' }, 404);

    if (!rest && method === 'GET') return json(full(s));
    if (!rest && method === 'POST') {
      const e = applyFields(s, await bodyOf(init));
      if (e && e.taken) return json({ error: 'There is already a studio with that name.', code: 'NAME_TAKEN' }, 409);
      if (e) return bad(e);
      save();
      return json(full(s));
    }
    if ((!rest && method === 'DELETE') || (rest === '/delete' && method === 'POST')) {
      db.studios = db.studios.filter(x => x.id !== s.id);
      for (const k of Object.keys(db.media)) if (db.media[k] === s.id) delete db.media[k];
      db.members = db.members.filter(x => x.studioId !== s.id);
      save();
      return json({ ok: true });
    }
    if (rest === '/merge' && method === 'POST') {
      const into = byId((await bodyOf(init)).into);
      if (!into || into.id === s.id) return bad('into: another studio');
      for (const k of Object.keys(db.media)) if (db.media[k] === s.id) db.media[k] = into.id;
      for (const mem of db.members.filter(x => x.studioId === s.id)) {
        if (!db.members.some(x => x.studioId === into.id && x.personId === mem.personId)) db.members.push({ ...mem, studioId: into.id });
      }
      db.members = db.members.filter(x => x.studioId !== s.id);
      db.studios = db.studios.filter(x => x.id !== s.id);
      save();
      return json(full(into));
    }
    if (rest === '/files' && method === 'GET') {
      const kind = url.searchParams.get('kind') || 'all';
      const ids = filesOf(s.id).filter(id => kind === 'video' ? isVideo(id) : kind === 'photo' ? isPhoto(id) : true);
      return json({ ids });
    }
    if (rest === '/cover' && method === 'POST') {
      const body = init && init.body;
      if (body instanceof Blob) {
        if (body.size > 15 * 1024 * 1024) return json({ error: 'too big', code: 'TOO_LARGE' }, 413);
        const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(body); });
        Object.assign(s, { coverKind: 'upload', coverRef: 'mock', coverUrl: dataUrl });
      } else {
        const b = await bodyOf(init);
        if (b.clear) Object.assign(s, { coverKind: null, coverRef: null, coverUrl: null });
        else {
          const mid = Number(b.mediaId);
          if (!filesOf(s.id).includes(mid)) return bad('mediaId: one of the studio files');
          const r = rows.get(mid);
          let src = `/thumb/${mid}`;
          if (r && r.media_type === 'video' && r.duration_seconds >= 3 && b.timeS > 0) {
            const idx = Math.max(0, Math.min(4, Math.round((b.timeS / r.duration_seconds) * 6 - 1)));
            src = `/scrub/${mid}/${idx}`;
          }
          Object.assign(s, { coverKind: 'frame', coverRef: `${mid}:${b.timeS || 0}`, coverUrl: src });
        }
      }
      s.updatedAt = now();
      save();
      return json(full(s));
    }
    if (rest === '/people' && method === 'POST') {
      const b = await bodyOf(init);
      const pid = Number(b.personId);
      if (!pid) return bad('personId');
      const e = checkYears(b.yearStart ?? null, b.yearEnd ?? null);
      if (e) return bad(e);
      const mem = db.members.find(x => x.studioId === s.id && x.personId === pid);
      if (mem) { if (b.yearStart !== undefined) mem.yearStart = b.yearStart; if (b.yearEnd !== undefined) mem.yearEnd = b.yearEnd; }
      else db.members.push({ studioId: s.id, personId: pid, yearStart: b.yearStart ?? null, yearEnd: b.yearEnd ?? null });
      save();
      return json(full(s));
    }
    if ((m = /^\/people\/(\d+)\/remove$/.exec(rest)) && method === 'POST') {
      db.members = db.members.filter(x => !(x.studioId === s.id && x.personId === Number(m[1])));
      save();
      return json(full(s));
    }
    return json({ error: 'not found' }, 404);
  }

  window.fetch = async function (input, init) {
    const href = typeof input === 'string' ? input : input && input.url;
    let url;
    try { url = new URL(href, location.origin); } catch { return realFetch(input, init); }
    if (url.origin !== location.origin) return realFetch(input, init);
    try {
      const r = await handle(url, init);
      if (r) return r;
    } catch (err) {
      console.warn('[studios mock]', err);
      return json({ error: String(err && err.message || err) }, 500);
    }
    return realFetch(input, init);
  };
  console.info('[studios mock] on. localStorage.removeItem("vaultStudiosMock") and reload to turn it off.');
})();
