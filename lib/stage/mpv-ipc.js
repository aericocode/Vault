/**
 * mpv's JSON IPC, client side (Stage, PLAYLISTS_SPEC "Stage host, final").
 *
 * Transport: the named pipe mpv opens for --input-ipc-server
 * (\\.\pipe\<name> on Windows, a unix socket elsewhere). Node's net module
 * speaks both. One JSON object per line each way.
 *
 * Commands carry a request_id and get their answer matched back (or time out);
 * every line without a request_id is an event (property-change, start-file,
 * end-file, client-message ...) and is emitted as 'event'. Properties watched
 * with observe() are watched again after a reconnect.
 *
 * The connection is retried while the pipe is not there yet (mpv takes a
 * moment to open it), and after an unexpected drop for as long as
 * opts.shouldReconnect() says the process is still there. Waiting requests
 * fail at once on a drop (MpvDisconnected), never hang.
 *
 * Nothing here logs what goes over the pipe: it carries file paths.
 */

const net = require('net');
const { EventEmitter } = require('events');

const MAX_LINE = 1024 * 1024;   // mpv's longest answer (a playlist of two) is far smaller

class MpvError extends Error {
  constructor(message, code = 'MPV_ERROR') { super(message); this.name = 'MpvError'; this.code = code; }
}
class MpvDisconnected extends MpvError {
  constructor(message = 'mpv is not connected') { super(message, 'MPV_DISCONNECTED'); this.name = 'MpvDisconnected'; }
}
class MpvTimeout extends MpvError {
  constructor(message = 'mpv did not answer in time') { super(message, 'MPV_TIMEOUT'); this.name = 'MpvTimeout'; }
}

/**
 * @param {string} path  the pipe or socket path
 * @param {object} [opts]
 * @param {number} [opts.connectTimeoutMs]  how long to keep trying to reach the pipe
 * @param {number} [opts.requestTimeoutMs]  default per-request timeout
 * @param {() => boolean} [opts.shouldReconnect]  after a drop: is it worth trying again?
 * @param {number} [opts.reconnectTries]
 * @param {(path: string) => object} [opts.connect]  net.connect (tests)
 */
class MpvIpc extends EventEmitter {
  constructor(path, opts = {}) {
    super();
    this.path = path;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.shouldReconnect = opts.shouldReconnect || (() => false);
    this.reconnectTries = opts.reconnectTries ?? 5;
    this._connect = opts.connect || ((p) => net.connect(p));
    this.sock = null;
    this.closed = false;          // close() was called: never again
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();     // request_id -> { resolve, reject, timer }
    this.observed = new Map();    // observe id -> property name
    this.nextObserve = 1;
    this.buf = '';
  }

  /** Reach the pipe, retrying while it is not there yet. Resolves once connected. */
  connect() {
    const deadline = Date.now() + this.connectTimeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.closed) { reject(new MpvDisconnected('closed')); return; }
        const sock = this._connect(this.path);
        let settled = false;
        const onError = (err) => {
          if (settled) return;
          settled = true;
          try { sock.destroy(); } catch {}
          // Not there yet (ENOENT), or busy: try again until the deadline.
          if (Date.now() < deadline && ['ENOENT', 'ECONNREFUSED', 'EBUSY', 'EAGAIN', 'EPIPE'].includes(err && err.code)) {
            const t = setTimeout(attempt, 60);
            if (t.unref) t.unref();
            return;
          }
          reject(new MpvDisconnected(`the mpv pipe could not be reached (${err && err.code ? err.code : 'error'})`));
        };
        sock.once('error', onError);
        sock.once('connect', () => {
          if (settled) return;
          settled = true;
          sock.removeListener('error', onError);
          this._attach(sock);
          resolve();
        });
      };
      attempt();
    });
  }

  _attach(sock) {
    this.sock = sock;
    this.connected = true;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => this._data(d));
    sock.on('error', () => {});
    sock.on('close', () => this._dropped(sock));
  }

  _data(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE && this.buf.indexOf('\n') === -1) {
      // Not mpv talking: drop the connection rather than buffer without end.
      this.buf = '';
      try { this.sock.destroy(); } catch {}
      return;
    }
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== 'object') continue;
      this._message(msg);
    }
  }

  _message(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'request_id') && !msg.event) {
      const p = this.pending.get(msg.request_id);
      if (!p) return;
      this.pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.error === 'success') p.resolve(msg.data === undefined ? null : msg.data);
      else p.reject(new MpvError(String(msg.error || 'mpv refused the command')));
      return;
    }
    if (typeof msg.event !== 'string') return;
    if (msg.event === 'property-change' && typeof msg.name === 'string') this.emit('property', msg.name, msg.data, msg.id);
    this.emit('event', msg);
  }

  _failPending(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async _dropped(sock) {
    if (this.sock !== sock) return;
    this.sock = null;
    this.connected = false;
    this._failPending(new MpvDisconnected('the mpv pipe closed'));
    if (this.closed) { this.emit('close', { reconnected: false }); return; }
    for (let i = 0; i < this.reconnectTries; i++) {
      if (this.closed || !this.shouldReconnect()) break;
      await new Promise((r) => { const t = setTimeout(r, 150 * (i + 1)); if (t.unref) t.unref(); });
      if (this.closed || !this.shouldReconnect()) break;
      try {
        const keep = this.connectTimeoutMs;
        this.connectTimeoutMs = 1000;
        try { await this.connect(); } finally { this.connectTimeoutMs = keep; }
        // Watch again what was watched (mpv forgets it with the connection).
        for (const [id, name] of this.observed) {
          this.command(['observe_property', id, name]).catch(() => {});
        }
        this.emit('reconnect');
        return;
      } catch { /* the next try */ }
    }
    this.emit('close', { reconnected: false });
  }

  /**
   * Send a command (an array, mpv's positional form) or a named command
   * (an object with a name, mpv's named-arguments form). Resolves mpv's data.
   */
  command(cmd, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.connected || !this.sock) return Promise.reject(new MpvDisconnected());
    const id = this.nextId++;
    if (this.nextId > 2 ** 31) this.nextId = 1;
    const line = `${JSON.stringify({ command: cmd, request_id: id })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new MpvTimeout());
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sock.write(line);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new MpvDisconnected());
      }
    });
  }

  get(name, opts) { return this.command(['get_property', name], opts); }
  set(name, value, opts) { return this.command(['set_property', name, value], opts); }

  /** Watch a property: its changes come as 'property' events. Returns the observe id. */
  async observe(name) {
    const id = this.nextObserve++;
    this.observed.set(id, name);
    await this.command(['observe_property', id, name]);
    return id;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._failPending(new MpvDisconnected('closed'));
    const s = this.sock;
    if (s) { try { s.destroy(); } catch {} }
    else this.emit('close', { reconnected: false });
  }
}

module.exports = { MpvIpc, MpvError, MpvDisconnected, MpvTimeout, MAX_LINE };
