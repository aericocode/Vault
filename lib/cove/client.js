/**
 * Thin Cove REST client for `vault export-cove`.
 *
 * Routes and shapes were checked against Cove's source (Cove.Api/Controllers,
 * Cove.Core/DTOs). JSON is camelCase both ways; enums travel as camelCase
 * strings. List endpoints answer PaginatedResponse<T> { items, totalCount,
 * page, perPage } and cap perPage at 250.
 *
 * Every request goes through lib/net.js netFetch (purpose 'tool'): loopback is
 * always allowed, anything else is blocked under VAULT_OFFLINE like every other
 * user-triggered request. Auth is `Authorization: Bearer <token>`.
 *
 * A client made with { readOnly: true } (the dry run) refuses any method but
 * GET before a byte leaves the process, so a dry run cannot change Cove even
 * if the caller has a bug.
 */

const { netFetch } = require('../net');

const PER_PAGE = 250;
const RETRIES = 3;

class CoveError extends Error {
  constructor(message, { status = 0, method, path, body } = {}) {
    super(message);
    this.name = 'CoveError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A short, human message out of an error response body (ProblemDetails, {error}, {message} or text). */
function errorText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  return String(body.error || body.message || body.title || body.detail || JSON.stringify(body)).slice(0, 300);
}

class CoveClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   e.g. http://127.0.0.1:5073
   * @param {string} [o.token]   API token (COVE_TOKEN). Without one no
   *   Authorization header is sent: Cove with login off (its default) treats a
   *   local request as its owner.
   * @param {boolean} [o.readOnly]  refuse non-GET requests (dry run)
   * @param {number} [o.retryBaseMs]  first retry delay after a 5xx; tests shrink it
   * @param {number} [o.rateLimitWaitMs]  wait after a 429 with no Retry-After.
   *   Cove's interactions limiter is a fixed 1-minute window (240 requests)
   *   and sends no Retry-After, so anything shorter just gets refused again.
   * @param {Function} [o.fetch]  fetch-compatible function (defaults to netFetch)
   * @param {Function} [o.sleep]  ms -> Promise; tests record the waits
   */
  constructor({ baseUrl, token, readOnly = false, retryBaseMs = 1000, rateLimitWaitMs = 60000, fetch, sleep: sleepFn } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || null;
    this.readOnly = readOnly;
    this.retryBaseMs = retryBaseMs;
    this.rateLimitWaitMs = rateLimitWaitMs;
    this._fetch = fetch || ((url, opts) => netFetch(url, { ...opts, purpose: 'tool' }));
    this._sleep = sleepFn || sleep;
    this.writes = 0;     // mutating requests that got an answer
  }

  _url(path, query) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /**
   * One request with retries.
   *  - 429 is always retried (the request was refused, nothing happened):
   *    after Retry-After when Cove sends one, else after rateLimitWaitMs.
   *  - 5xx and a dropped connection are retried only for requests that are
   *    safe to repeat: GET, PUT, and POSTs marked `idempotent` (the bulk
   *    add-mode updates). A create that failed that way may have gone
   *    through, and repeating it could make a duplicate, so the error is
   *    returned instead; the next run picks the item up through its stamp.
   */
  async request(method, path, { query, body, idempotent } = {}) {
    method = method.toUpperCase();
    if (this.readOnly && method !== 'GET') {
      throw new CoveError(`Dry run tried to send ${method} ${path}. Nothing was sent.`, { method, path });
    }
    const repeatable = idempotent != null ? !!idempotent : method !== 'POST';
    const url = this._url(path, query);
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this._fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (err) {
        if (err && (err.code === 'NET_OFF' || err.code === 'TOO_MANY_REDIRECTS')) throw err;
        if (!repeatable || attempt >= RETRIES) {
          throw new CoveError(`Could not reach Cove at ${this.baseUrl} (${err && err.message ? err.message : err})`, { method, path });
        }
        await this._sleep(this.retryBaseMs * 2 ** attempt);
        continue;
      }

      if (res.status === 429 && attempt < RETRIES) {
        const ra = Number(res.headers.get('retry-after'));
        try { await res.arrayBuffer(); } catch {}
        await this._sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 300000) : this.rateLimitWaitMs);
        continue;
      }
      if (res.status >= 500 && repeatable && attempt < RETRIES) {
        try { await res.arrayBuffer(); } catch {}
        await this._sleep(this.retryBaseMs * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!res.ok) {
        throw new CoveError(`${method} ${path} failed (${res.status}${errorText(data) ? `: ${errorText(data)}` : ''})`,
          { status: res.status, method, path, body: data });
      }
      if (method !== 'GET') this.writes++;
      return data;
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, { idempotent } = {}) { return this.request('POST', path, { body, idempotent }); }
  put(path, body) { return this.request('PUT', path, { body }); }

  /** Every item of a paginated list, page by page until a short or empty page. */
  async listAll(path, query = {}) {
    const all = [];
    for (let page = 1; ; page++) {
      const res = await this.get(path, { ...query, page, perPage: PER_PAGE });
      const items = (res && res.items) || [];
      all.push(...items);
      const total = res && Number.isFinite(res.totalCount) ? res.totalCount : -1;
      if (items.length < PER_PAGE || (total >= 0 && all.length >= total)) return all;
    }
  }

  // --- preflight -----------------------------------------------------------
  me() { return this.get('/api/auth/me'); }
  status() { return this.get('/api/system/status'); }

  // --- media ---------------------------------------------------------------
  /** kind: 'video' | 'image' | 'audio'. Video lists skip their total count (Cove supports it there only). */
  listMedia(kind) {
    return this.listAll(`/api/${kind}s`, kind === 'video' ? { skipCount: true } : {});
  }
  getMedia(kind, id) { return this.get(`/api/${kind}s/${id}`); }
  /**
   * The item as it is right now. Cove output-caches GETs for a second, keyed
   * on the query string, so a throwaway parameter skips that cache.
   */
  getMediaFresh(kind, id) { return this.get(`/api/${kind}s/${id}`, { fresh: Date.now() + Math.random() }); }
  /** POST /api/{kind}s/bulk: tags and custom fields are merged per key, never replaced, so it is safe to repeat. */
  bulkUpdate(kind, body) { return this.post(`/api/${kind}s/bulk`, body, { idempotent: true }); }
  updateMedia(kind, id, body) { return this.put(`/api/${kind}s/${id}`, body); }

  // --- tags ----------------------------------------------------------------
  listTags() { return this.listAll('/api/tags', { includeCounts: false }); }
  getTag(id) { return this.get(`/api/tags/${id}`); }
  createTag(name, parentIds = []) { return this.post('/api/tags', { name, favorite: false, parentIds }); }
  /**
   * Add one parent to several tags. POST /api/tags/bulk with parentMode "add"
   * only ever adds the relation (the tag update would replace the whole
   * parent list, dropping any parent added meanwhile), so it is safe to repeat.
   */
  addTagParent(ids, parentId) {
    return this.post('/api/tags/bulk', { ids, parentIds: [parentId], parentMode: 'add' }, { idempotent: true });
  }

  // --- custom fields -------------------------------------------------------
  listFields() { return this.get('/api/custom-fields'); }
  createField(def) { return this.post('/api/custom-fields', def); }
  updateField(id, patch) { return this.put(`/api/custom-fields/${id}`, patch); }

  // --- engagement (hostType: video | image | audio) -----------------------
  getEngagement(kind, id) { return this.get(`/api/engagement/${kind}/${id}`); }
  setRating(kind, id, value) { return this.put(`/api/engagement/${kind}/${id}/rating`, { value, aspect: 'overall' }); }
  setFavorite(kind, id) { return this.put(`/api/engagement/${kind}/${id}/favorite`, { isFavorite: true }); }
  recordPlayback(body) { return this.post('/api/playback/intervals', body); }

  // --- groups --------------------------------------------------------------
  listGroups() { return this.listAll('/api/groups'); }
  /** customFields: the vault_collection_id stamp, written in the same request as the group. */
  createGroup(name, customFields) { return this.post('/api/groups', { name, kind: 'static', customFields }); }
  getGroupFresh(id) { return this.get(`/api/groups/${id}`, { fresh: Date.now() + Math.random() }); }
  updateGroup(id, body) { return this.put(`/api/groups/${id}`, body); }
  listGroupItems(groupId) { return this.get(`/api/groups/${groupId}/items`); }
  addGroupItem(groupId, kind, hostId, orderIndex) {
    return this.post(`/api/groups/${groupId}/items`, {
      orderIndex, kind, hostType: kind, hostId, videoId: kind === 'video' ? hostId : null,
    });
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep input
 * order; a rejection is returned as { error } in its slot, never thrown, so
 * one bad item does not stop the rest.
 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { value: await fn(items[i], i) }; } catch (error) { out[i] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { CoveClient, CoveError, pool, PER_PAGE };
