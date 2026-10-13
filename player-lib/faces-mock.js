/* =========================================================================
   TEMPORARY DEV-ONLY MOCK of the round 3 face API (FACES_FEEDBACK_SPEC E1-E6).
   REMOVE this file (and its loader line in db-viewer.html) once the real
   server half (Part E) is merged.

   Loaded only when localStorage.vaultFacesMock === '1'. It wraps fetch and
   answers the new routes from the routes that already exist, using the
   library's own face data:
     E1  similar           real answer + match / source / likelyPerson
     E2  people/:id/add    restore (moves the faces in, locks them)
     E3  POST people       names an unnamed person the faces are in
     E4  candidates        a wide search from the cover face, unnamed people only
     E5  status            queue.recent / withPeople, tracked between polls
     E6  not-a-face        hide (the group, or every face of the person)
   ========================================================================= */
(function () {
  const realFetch = window.fetch.bind(window);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  async function getJ(url, init) {
    const r = await realFetch(url, init);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status, body: d });
    return d;
  }
  const post = (url, body) => getJ(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const groupInfo = new Map();   // groupId -> { mediaId, personId, personName }
  async function facesOf(mediaId) {
    const info = await getJ(`/api/media/${mediaId}/faces`);
    for (const g of info.groups || []) groupInfo.set(g.id, { mediaId, personId: g.personId || null, personName: g.personName || null });
    return info;
  }

  const rejects = (() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('vaultFacesMockRejects') || '[]')); } catch { return new Set(); }
  })();
  const saveRejects = () => { try { sessionStorage.setItem('vaultFacesMockRejects', JSON.stringify([...rejects])); } catch {} };

  /* E1 */
  async function similar(url, init, groupId) {
    const resp = await realFetch(url, init);
    if (!resp.ok) return resp;
    const r = await resp.json();
    const infos = await Promise.all(r.ids.map(id => facesOf(id).catch(() => null)));
    let source = null;
    if (groupId != null) {
      for (const info of infos) {
        const g = info && (info.groups || []).find(x => x.id === groupId);
        if (g) { source = { personId: g.personId || null, personName: g.personName || null }; break; }
      }
      if (!source) source = { personId: null, personName: null };
    }
    // Which face in each file matched is not in the old answer: prefer the
    // source's person, then the clicked face, then the person most results share.
    const tally = new Map();
    infos.forEach(info => new Set((info && info.groups || []).map(g => g.personId).filter(Boolean)).forEach(p => tally.set(p, (tally.get(p) || 0) + 1)));
    const match = {};
    r.ids.forEach((id, i) => {
      const groups = (infos[i] && infos[i].groups) || [];
      if (!groups.length) return;
      let pick = (source && source.personId && groups.find(g => g.personId === source.personId))
        || (groupId != null && groups.find(g => g.id === groupId));
      if (!pick) pick = [...groups].sort((a, b) => (tally.get(b.personId) || 0) - (tally.get(a.personId) || 0))[0];
      match[id] = { groupId: pick.id, personId: pick.personId || null, personName: pick.personName || null };
    });
    const out = { ...r, match };
    if (groupId != null) out.source = source;
    else {
      const per = new Map();
      Object.values(match).forEach(m => { if (m.personId) per.set(m.personId, (per.get(m.personId) || 0) + 1); });
      const best = [...per].sort((a, b) => b[1] - a[1])[0];
      const m0 = match[r.ids[0]];
      out.likelyPerson = best && best[1] * 2 >= r.ids.length
        ? { id: best[0], name: Object.values(match).find(m => m.personId === best[0]).personName }
        : m0 && m0.personId && r.scores[0] >= 0.9 ? { id: m0.personId, name: m0.personName } : null;
    }
    return json(out);
  }

  /* E2 */
  async function addFaces(personId, body) {
    const ids = Array.isArray(body.groupIds) ? body.groupIds : [];
    const moved = [], skipped = [];
    for (const g of ids) {
      const info = groupInfo.get(g);
      if (info && info.personId === personId) { moved.push(g); continue; }
      if (info && info.personId && info.personName && !body.takeFromNamed) { skipped.push({ groupId: g, reason: 'other-named' }); continue; }
      moved.push(g);
    }
    for (let i = 0; i < moved.length; i += 500) {
      await post(`/api/faces/people/${personId}/restore`, { groupIds: moved.slice(i, i + 500) });
    }
    const person = await getJ(`/api/faces/people/${personId}`);
    moved.forEach(g => { const info = groupInfo.get(g); if (info) Object.assign(info, { personId, personName: person.name }); });
    return json({ person, moved, skipped });
  }

  /* E3 */
  async function newPerson(body) {
    const name = String(body.name || '').trim();
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
    if (name) {
      const qs = new URLSearchParams({ filter: 'named', q: name, sort: 'name', limit: '20' });
      const taken = ((await getJ(`/api/faces/people?${qs}`)).people || []).find(p => (p.name || '').toLowerCase() === name.toLowerCase());
      if (taken && !body.mergeIfTaken) return json({ error: 'name taken', code: 'NAME_TAKEN', other: taken }, 409);
      if (taken) {
        await addFaces(taken.id, { groupIds, takeFromNamed: false });
        return json(await getJ(`/api/faces/people/${taken.id}`));
      }
    }
    // The real route makes a new person; the old API cannot, so the faces'
    // own unnamed person takes the name and the rest move into it.
    const holder = groupIds.map(g => groupInfo.get(g)).find(i => i && i.personId && !i.personName);
    if (!holder) return json({ error: 'The mock cannot make a person for faces that are in no one.', code: 'BAD_REQUEST' }, 400);
    const pid = holder.personId;
    if (name) await post(`/api/faces/people/${pid}`, { name });
    const rest = groupIds.filter(g => (groupInfo.get(g) || {}).personId !== pid);
    if (rest.length) await addFaces(pid, { groupIds: rest });
    return json(await getJ(`/api/faces/people/${pid}`));
  }

  /* E4 */
  async function candidates(personId, qs) {
    const limit = Math.min(200, Number(qs.get('limit')) || 24);
    const offset = Number(qs.get('offset')) || 0;
    const person = await getJ(`/api/faces/people/${personId}`);
    if (!person.coverGroupId) return json({ total: 0, items: [] });
    const r = await post(`/api/faces/groups/${person.coverGroupId}/similar`, { width: 'wide' });
    const unnamed = new Map(((await getJ('/api/faces/people?filter=unnamed&limit=500')).people || []).map(p => [p.id, p]));
    const rows = new Map(((await post('/api/media/rows', { ids: r.ids })).rows || []).map(m => [m.id, m]));
    const seen = new Set();
    const items = [];
    for (let i = 0; i < r.ids.length; i++) {
      const info = await facesOf(r.ids[i]).catch(() => null);
      for (const g of (info && info.groups) || []) {
        const p = g.personId && unnamed.get(g.personId);
        if (!p || p.id === personId || seen.has(p.id) || rejects.has(`${personId}:${p.id}`)) continue;
        seen.add(p.id);
        items.push({
          personId: p.id, groupId: g.id, mediaId: r.ids[i], filename: (rows.get(r.ids[i]) || {}).filename || '',
          // File scores say nothing about one face: the first three stand in for the likely band.
          cropUrl: g.cropUrl, files: p.files, tier: items.length < 3 ? 'likely' : 'maybe',
        });
      }
    }
    return json({ total: items.length, items: items.slice(offset, offset + limit) });
  }

  async function answerCandidates(personId, body) {
    const accept = body.accept || [], reject = body.reject || [];
    for (const pid of reject) {
      rejects.add(`${personId}:${pid}`);
      await post('/api/faces/review', { a: personId, b: pid, answer: 'different' }).catch(() => {});
    }
    saveRejects();
    if (accept.length) await post('/api/faces/people/merge', { ids: [personId, ...accept], into: personId });
    return json({ person: await getJ(`/api/faces/people/${personId}`), merged: accept, rejected: reject });
  }

  /* E5: what finished between two polls goes to the front of `recent`. */
  const recent = [];
  let lastCurrent = new Map();
  let run = { key: null, withPeople: 0 };
  let lastRunWithPeople = null;
  async function status(url, init) {
    const resp = await realFetch(url, init);
    if (!resp.ok) return resp;
    const s = await resp.json();
    const q = s.queue || {};
    const now = new Map((q.current || []).map(c => [c.id, c]));
    if (q.running && q.startedAt !== run.key) run = { key: q.startedAt, withPeople: 0 };
    for (const [id, c] of lastCurrent) {
      if (now.has(id)) continue;
      const info = await facesOf(id).catch(() => null);
      const groups = (info && info.groups) || [];
      const names = [...new Set(groups.map(g => g.personName).filter(Boolean))].slice(0, 3);
      const entry = {
        mediaId: id, filename: c.filename, ok: !!(info && info.indexed && !info.error),
        faces: groups.length, people: new Set(groups.map(g => g.personId || `g${g.id}`)).size, names,
      };
      if (!entry.ok) entry.error = 'could not be read';
      recent.unshift(entry);
      if (entry.faces) run.withPeople++;
    }
    recent.length = Math.min(recent.length, 50);
    if (lastCurrent.size && !q.running) lastRunWithPeople = run.withPeople;
    lastCurrent = now;
    q.recent = recent.map(r => ({ ...r }));
    if (q.running) q.withPeople = run.withPeople;
    if (q.lastRun) q.lastRun.withPeople = lastRunWithPeople != null ? lastRunWithPeople : 0;
    s.queue = q;
    return json(s);
  }

  /* E6 */
  async function notAFacePerson(personId) {
    const faces = await getJ(`/api/faces/people/${personId}/faces?limit=500`);
    for (const f of faces) await post(`/api/faces/groups/${f.groupId}/hide`).catch(() => {});
    return json({ ok: true });
  }

  window.fetch = async function (input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const u = new URL(raw, location.origin);
    const method = String(init.method || 'GET').toUpperCase();
    const p = u.pathname;
    let m;
    try {
      if (method === 'GET' && p === '/api/faces/status') return await status(raw, init);
      if (method === 'POST' && (m = p.match(/^\/api\/faces\/groups\/(\d+)\/similar$/))) return await similar(raw, init, Number(m[1]));
      if (method === 'POST' && /^\/api\/faces\/query\/[^/]+\/similar$/.test(p)) return await similar(raw, init, null);
      const body = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };
      if (method === 'POST' && (m = p.match(/^\/api\/faces\/people\/(\d+)\/add$/))) return await addFaces(Number(m[1]), body());
      if (method === 'POST' && p === '/api/faces/people') return await newPerson(body());
      if ((m = p.match(/^\/api\/faces\/people\/(\d+)\/candidates$/))) {
        return method === 'GET' ? await candidates(Number(m[1]), u.searchParams) : await answerCandidates(Number(m[1]), body());
      }
      if (method === 'POST' && (m = p.match(/^\/api\/faces\/groups\/(\d+)\/not-a-face$/))) {
        return await realFetch(`/api/faces/groups/${m[1]}/hide`, { method: 'POST' });
      }
      if (method === 'POST' && (m = p.match(/^\/api\/faces\/people\/(\d+)\/not-a-face$/))) return await notAFacePerson(Number(m[1]));
    } catch (err) {
      return json(err.body || { error: err.message }, err.status || 500);
    }
    return realFetch(input, init);
  };
  console.info('[faces-mock] round 3 face API mock is ON (localStorage.vaultFacesMock). REMOVE when Part E lands.');
})();
