/**
 * A stand-in mpv process for the Stage shutdown tests (test/stage-shutdown.test.js,
 * test/exit-vault-route.test.js). Run as `node fake-mpv.js <mpv's arguments>`.
 *
 * It opens the JSON IPC pipe named by --input-ipc-server, answers every
 * command (get_property pid with its own pid, window-id as unavailable so no
 * window is watched), and on `quit` answers, writes "quit" to its log and
 * ends with code 0. With FAKE_MPV_IGNORE_QUIT=1 it answers quit but stays,
 * so the caller has to kill it. Every line goes to the file FAKE_MPV_LOG:
 * "start <pid>", the command names, "quit", "exit <code>".
 */
const fs = require('fs');
const net = require('net');

const log = (line) => { if (process.env.FAKE_MPV_LOG) { try { fs.appendFileSync(process.env.FAKE_MPV_LOG, line + '\n'); } catch {} } };
const arg = process.argv.find(a => a.startsWith('--input-ipc-server='));
if (!arg) { log('no pipe'); process.exit(2); }
const pipe = arg.slice('--input-ipc-server='.length);

log(`start ${process.pid}`);
process.on('exit', (code) => log(`exit ${code}`));

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const cmd = Array.isArray(msg.command) ? msg.command : [];
      log(`cmd ${cmd[0]}${cmd[1] !== undefined ? ' ' + cmd[1] : ''}`);
      let answer = { request_id: msg.request_id, error: 'success', data: null };
      if (cmd[0] === 'get_property' && cmd[1] === 'pid') answer.data = process.pid;
      else if (cmd[0] === 'get_property' && cmd[1] === 'window-id') answer = { request_id: msg.request_id, error: 'property unavailable' };
      else if (cmd[0] === 'get_property' && cmd[1] === 'decoder-list') answer.data = [];
      sock.write(JSON.stringify(answer) + '\n');
      if (cmd[0] === 'quit') {
        log('quit');
        if (process.env.FAKE_MPV_IGNORE_QUIT !== '1') setTimeout(() => process.exit(0), 20);
      }
    }
  });
});
server.listen(pipe);
// mpv runs until it is told to stop.
setInterval(() => {}, 1 << 30);
