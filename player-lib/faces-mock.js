/* TEMPORARY DEV MOCK. DO NOT SHIP. Remove together with its loader line in
   db-viewer.html once the real people API (FACES_PEOPLE_SPEC section 3) is
   merged into this branch.

   Loaded only when localStorage.vaultFacesMock === '1'. Answers the frozen
   people API from the face groups of the faces-lib test library (clustered
   offline at 0.50, like the spike), passes everything else to the server.
   Crops are the real ones (/api/faces/crop/:groupId).

   Console knobs: facesMock.queue = { running: true, paused: false, done: 3, total: 9 }
   (fakes the checking strip), facesMock.reset(). */
(function () {
  // [groupId, mediaId, isVideo, appearances, firstTimeS, detScore]
  const G = [[23,13,1,10,0,0.949],[18,9,0,1,null,0.949],[31,15,1,4,21,0.947],[27,13,1,2,11,0.944],[4,7,0,1,null,0.944],[19,2,0,1,null,0.943],[11,4,0,1,null,0.942],[29,13,1,2,46,0.94],[34,15,1,3,52.5,0.94],[24,13,1,3,35.1,0.94],[5,5,0,1,null,0.94],[9,4,0,1,null,0.94],[37,15,1,3,52.5,0.939],[33,15,1,3,10.5,0.938],[38,15,1,3,52.5,0.937],[39,15,1,3,52.5,0.937],[20,1,0,1,null,0.937],[13,4,0,1,null,0.937],[35,15,1,3,52.5,0.936],[30,15,1,6,52.5,0.936],[16,4,0,1,null,0.936],[21,6,0,1,null,0.934],[6,5,0,1,null,0.934],[12,4,0,1,null,0.934],[15,4,0,1,null,0.934],[10,4,0,1,null,0.933],[43,15,1,2,84,0.933],[42,15,1,2,45.5,0.933],[25,13,1,3,35.1,0.932],[17,4,0,1,null,0.931],[36,15,1,3,52.5,0.93],[7,5,0,1,null,0.928],[40,15,1,3,52.5,0.927],[8,5,0,1,null,0.927],[32,15,1,3,0,0.927],[26,13,1,3,35.1,0.925],[44,15,1,2,84,0.925],[14,4,0,1,null,0.925],[45,15,1,2,84,0.923],[22,6,0,1,null,0.918],[2,11,0,1,null,0.916],[28,13,1,2,29,0.909],[1,3,0,1,null,0.907],[3,11,0,1,null,0.906],[41,15,1,3,52.5,0.901]];
  const P = [[23,18,31,5],[27,19,42],[4,29,33],[11,37],[34,15],[24,6,43],[9,40],[38,13],[39,12],[35,10],[30,17,22],[16,36],[21,14,41],[25,8,45],[7,26,44],[32,1],[28,3],[2],[20]];
  const NAMES = { 1: 'Barack Obama', 2: 'Joe Biden', 3: 'Kamala Harris', 6: 'Michelle Obama', 11: 'Butch Wilmore', 13: 'Suni Williams' };
  const SUGG = [[1, 18, 0.48], [2, 19, 0.47], [2, 16, 0.468]];
  const INTERVAL = 3.5;

  let groups, people, nextId, decided, mock;
  function reset() {
    groups = new Map(G.map(([id, mediaId, v, appearances, firstTimeS, det]) =>
      [id, { id, mediaId, video: !!v, appearances, firstTimeS, det }]));
    people = new Map();
    P.forEach((gs, i) => {
      const id = i + 1;
      people.set(id, { id, name: NAMES[id] || null, favorite: id === 1 || id === 2, hidden: id === 17,
        coverGroupId: null, groups: new Set(gs), addedAt: new Date(Date.now() - (30 - id) * 3600e3).toISOString() });
    });
    nextId = P.length + 1;
    decided = new Set();
    mock = { intervalS: null, maxFrames: 2000 };
  }
  reset();

  function stats(p) {
    const files = new Map();
    let screenS = 0;
    for (const gid of p.groups) {
      const g = groups.get(gid);
      if (!g) continue;
      files.set(g.mediaId, g.video);
      if (g.video) screenS += g.appearances * INTERVAL;
    }
    const videos = [...files.values()].filter(Boolean).length;
    return { files: files.size, videos, photos: files.size - videos, screenS };
  }
  function cover(p) {
    if (p.coverGroupId && p.groups.has(p.coverGroupId)) return p.coverGroupId;
    return [...p.groups].map(id => groups.get(id)).sort((a, b) => b.det - a.det)[0]?.id;
  }
  function pub(p) {
    return { id: p.id, name: p.name, favorite: p.favorite, hidden: p.hidden, ...stats(p),
      coverUrl: `/api/faces/crop/${cover(p)}`, addedAt: p.addedAt };
  }
  const visible = () => [...people.values()].filter(p => p.groups.size);
  const key = (s) => String(s || '').trim().toLowerCase();

  function list(q) {
    const all = visible();
    const st = new Map(all.map(p => [p.id, stats(p)]));
    const counts = {
      all: all.filter(p => !p.hidden).length,
      named: all.filter(p => !p.hidden && p.name).length,
      unnamed: all.filter(p => !p.hidden && !p.name).length,
      favorites: all.filter(p => !p.hidden && p.favorite).length,
      single: all.filter(p => !p.hidden && st.get(p.id).files === 1).length,
      hidden: all.filter(p => p.hidden).length,
    };
    const f = q.get('filter') || 'all';
    let rows = all.filter(p => f === 'hidden' ? p.hidden : !p.hidden && (
      f === 'named' ? p.name : f === 'unnamed' ? !p.name : f === 'favorites' ? p.favorite
        : f === 'single' ? st.get(p.id).files === 1 : true));
    const text = key(q.get('q'));
    if (text) rows = rows.filter(p => key(p.name).includes(text));
    const sort = q.get('sort') || 'files';
    const byName = (a, b) => (a.name || '￿').localeCompare(b.name || '￿');
    rows.sort(sort === 'name' ? byName
      : sort === 'recent' ? (a, b) => b.addedAt.localeCompare(a.addedAt)
      : sort === 'screen' ? (a, b) => st.get(b.id).screenS - st.get(a.id).screenS || byName(a, b)
      : (a, b) => (b.favorite - a.favorite) || (st.get(b.id).files - st.get(a.id).files) || byName(a, b));
    const offset = Number(q.get('offset') || 0);
    const limit = Number(q.get('limit') || 200);
    return { total: rows.length, counts, people: rows.slice(offset, offset + limit).map(pub) };
  }

  function filesOf(p, kind) {
    const byMedia = new Map();
    for (const gid of p.groups) {
      const g = groups.get(gid);
      const e = byMedia.get(g.mediaId) || { video: g.video, firstTimeS: null, appearances: 0, groupIds: [] };
      e.appearances += g.appearances;
      e.groupIds.push(g.id);
      if (g.firstTimeS != null) e.firstTimeS = e.firstTimeS == null ? g.firstTimeS : Math.min(e.firstTimeS, g.firstTimeS);
      byMedia.set(g.mediaId, e);
    }
    let ids = [...byMedia.keys()].filter(id => kind === 'video' ? byMedia.get(id).video : kind === 'photo' ? !byMedia.get(id).video : true);
    ids.sort((a, b) => {
      const A = byMedia.get(a), B = byMedia.get(b);
      if (A.video !== B.video) return A.video ? -1 : 1;
      return (B.video ? B.appearances - A.appearances : 0) || a - b;
    });
    const files = {};
    for (const id of ids) { const e = byMedia.get(id); files[id] = { firstTimeS: e.firstTimeS, appearances: e.appearances, groupIds: e.groupIds }; }
    return { ids, files };
  }

  function mergeInto(ids, into) {
    const t = people.get(into);
    for (const id of ids) {
      if (id === into) continue;
      const p = people.get(id);
      if (!p) continue;
      p.groups.forEach(g => t.groups.add(g));
      if (p.favorite) t.favorite = true;
      people.delete(id);
    }
    return pub(t);
  }

  function personPayload(p) {
    const mine = new Set(filesOf(p, 'all').ids);
    const oftenWith = visible().filter(o => o.id !== p.id && !o.hidden).map(o => ({
      id: o.id, name: o.name, coverUrl: pub(o).coverUrl,
      shared: filesOf(o, 'all').ids.filter(m => mine.has(m)).length,
    })).filter(o => o.shared).sort((a, b) => b.shared - a.shared).slice(0, 6);
    return { ...pub(p), oftenWith };
  }

  function review(limit) {
    const pairs = SUGG.filter(([a, b]) => people.get(a)?.groups.size && people.get(b)?.groups.size && !decided.has(`${a}-${b}`))
      .map(([a, b]) => ({ a: pub(people.get(a)), b: pub(people.get(b)),
        sample: { a: filesOf(people.get(a), 'all').ids.slice(0, 3), b: filesOf(people.get(b), 'all').ids.slice(0, 3) } }));
    return { total: pairs.length, pairs: pairs.slice(0, limit) };
  }

  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);

  async function route(url, method, body) {
    const path = url.pathname;
    let m;
    if (path === '/api/faces/status' && method === 'GET') {
      const s = await realFetch(url.href).then(r => r.json());
      return json(patchStatus(s));
    }
    if (path === '/api/faces/settings' && method === 'POST') {
      const b = { ...body };
      if (b.maxFrames !== undefined) { mock.maxFrames = b.maxFrames; delete b.maxFrames; }
      if (b.intervalS !== undefined && ![2, 3.5, 10].includes(b.intervalS)) { mock.intervalS = b.intervalS; delete b.intervalS; }
      else if (b.intervalS !== undefined) mock.intervalS = null;
      const r = await realFetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      const s = await r.json();
      return json(r.ok ? patchStatus(s) : s, r.status);
    }
    if ((m = path.match(/^\/api\/media\/(\d+)\/faces$/)) && method === 'GET') {
      const r = await realFetch(url.href);
      const info = await r.json();
      for (const g of info.groups || []) {
        const p = [...people.values()].find(x => x.groups.has(g.id));
        g.personId = p ? p.id : null;
        g.personName = p ? p.name : null;
      }
      return json(info, r.status);
    }
    if (path === '/api/faces/people' && method === 'GET') return json(list(url.searchParams));
    if (path === '/api/faces/people/merge' && method === 'POST') {
      const ids = (body.ids || []).map(Number);
      if (ids.length < 2 || !ids.includes(body.into)) return json({ code: 'BAD_REQUEST', error: 'bad merge' }, 400);
      return json(mergeInto(ids, body.into));
    }
    if ((m = path.match(/^\/api\/faces\/people\/(\d+)(\/.*)?$/))) {
      const p = people.get(Number(m[1]));
      if (!p) return json({ code: 'NOT_FOUND', error: 'no such person' }, 404);
      const sub = m[2] || '';
      if (!sub && method === 'GET') return json(personPayload(p));
      if (sub === '/files') return json(filesOf(p, url.searchParams.get('kind') || 'all'));
      if (sub === '/faces') {
        const f = filesOf(p, 'all');
        return json(f.ids.slice(0, Number(url.searchParams.get('limit') || 8)).map(mid => {
          const gid = f.files[mid].groupIds[0];
          return { groupId: gid, mediaId: mid, cropUrl: `/api/faces/crop/${gid}` };
        }));
      }
      if (sub === '/not-in' && method === 'POST') {
        const gids = [...p.groups].filter(g => groups.get(g).mediaId === body.mediaId);
        for (const g of gids) {
          p.groups.delete(g);
          people.set(nextId, { id: nextId, name: null, favorite: false, hidden: false, coverGroupId: null, groups: new Set([g]), addedAt: new Date().toISOString() });
          nextId++;
        }
        return json(pub(p));
      }
      if (!sub && method === 'POST') {
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          const other = name && [...people.values()].find(o => o.id !== p.id && key(o.name) === key(name));
          if (other && !body.mergeIfTaken) return json({ code: 'NAME_TAKEN', error: 'name taken', otherId: other.id, other: pub(other) }, 409);
          if (other) return json(mergeInto([p.id, other.id], other.id));
          p.name = name || null;
        }
        if (body.favorite !== undefined) p.favorite = !!body.favorite;
        if (body.hidden !== undefined) p.hidden = !!body.hidden;
        if (body.coverGroupId !== undefined) p.coverGroupId = body.coverGroupId;
        return json(pub(p));
      }
    }
    if (path === '/api/faces/review' && method === 'GET') return json(review(Number(url.searchParams.get('limit') || 50)));
    if (path === '/api/faces/review' && method === 'POST') {
      const a = people.get(body.a), b = people.get(body.b);
      if (!a || !b) return json({ code: 'NOT_FOUND' }, 404);
      decided.add(`${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`);
      decided.add(`${a.id}-${b.id}`); decided.add(`${b.id}-${a.id}`);
      if (body.answer === 'same') {
        const into = a.name ? a : b.name ? b : (stats(a).files >= stats(b).files ? a : b);
        return json(mergeInto([a.id, b.id], into.id));
      }
      return json({ ok: true });
    }
    return null;
  }

  function patchStatus(s) {
    const out = { ...s, maxFrames: mock.maxFrames, people: { sorting: false, pending: 0, total: visible().length } };
    if (mock.intervalS != null) out.intervalS = mock.intervalS;
    if (window.facesMock.queue) out.queue = { ...(s.queue || {}), ...window.facesMock.queue };
    return out;
  }

  window.fetch = async function (input, init = {}) {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, location.origin);
    if (url.origin === location.origin && (url.pathname.startsWith('/api/faces') || /^\/api\/media\/\d+\/faces$/.test(url.pathname))) {
      const method = (init.method || 'GET').toUpperCase();
      let body = {};
      try { body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch {}
      const r = await route(url, method, body);
      if (r) return r;
    }
    return realFetch(input, init);
  };
  window.facesMock = { queue: null, reset };
  console.warn('[faces-mock] TEMPORARY people API mock is active (localStorage.vaultFacesMock = "1").');
})();
