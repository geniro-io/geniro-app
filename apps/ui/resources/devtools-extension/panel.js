/**
 * The Geniro DevTools panel — the daemon's log, inside the real DevTools.
 *
 * **Why this is plain DOM and not our React panel.** A DevTools panel is a
 * separate document in an extension origin: no preload, no `window.geniro`, no
 * bundler, no access to the renderer's module graph. Nothing of the app's
 * component layer can be reached from here, so reusing it would mean a second
 * build target emitting a second copy. What IS shared is the only thing that
 * matters — the daemon's HTTP and WS contract, which both consume directly.
 *
 * **How it finds the daemon.** The host, port and per-launch token are
 * negotiated per launch and known only to the renderer, so the panel asks the
 * page it is inspecting for them through `inspectedWindow.eval` — the standard
 * DevTools-extension channel. The renderer publishes them on
 * `window.__geniroDaemon` for exactly this reader.
 */

/** Channels the toolbar starts with; the daemon is told on first connect. */
const channels = new Set(['daemon', 'transcript', 'ui']);
/** Newest-last, capped — the FILE is the record, this is the live view. */
const CAPACITY = 3000;
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const filterEl = document.getElementById('filter');

let socket = null;
let handle = null;
let lastSeq = -1;

/** Ask the inspected page for the daemon it is talking to. */
function readHandle() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      'window.__geniroDaemon ? JSON.stringify(window.__geniroDaemon) : null',
      (result, error) => resolve(error || !result ? null : JSON.parse(result)),
    );
  });
}

function base() {
  return `http://${handle.host}:${handle.port}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${handle.token}` };
}

function matchesFilter(entry) {
  const needle = filterEl.value.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    entry.message.toLowerCase().includes(needle) ||
    entry.channel.includes(needle) ||
    JSON.stringify(entry.context ?? {}).toLowerCase().includes(needle)
  );
}

function render(entry) {
  if (!channels.has(entry.channel) || !matchesFilter(entry)) {
    return;
  }
  emptyEl.hidden = true;
  const row = document.createElement('div');
  row.className = `row lv-${entry.level}`;
  const at = document.createElement('span');
  at.className = 'at';
  at.textContent = entry.at.slice(11, 23);
  const ch = document.createElement('span');
  ch.className = 'ch';
  ch.textContent = entry.channel;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = entry.message;
  if (entry.context) {
    const ctx = document.createElement('span');
    ctx.className = 'ctx';
    ctx.textContent = ` ${Object.entries(entry.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`;
    msg.appendChild(ctx);
  }
  row.append(at, ch, msg);
  rowsEl.appendChild(row);
  while (rowsEl.childElementCount > CAPACITY) {
    rowsEl.removeChild(rowsEl.firstElementChild);
  }
  // Follow the tail only when the reader is already AT the tail — scrolling up
  // to read something is exactly when a forced scroll is most infuriating.
  const nearBottom =
    window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  if (nearBottom) {
    row.scrollIntoView({ block: 'end' });
  }
}

/** Re-render everything from scratch — used when a toolbar control changes. */
let all = [];
function repaint() {
  rowsEl.textContent = '';
  emptyEl.hidden = false;
  for (const entry of all) {
    render(entry);
  }
}

function remember(entry) {
  all.push(entry);
  while (all.length > CAPACITY) {
    all.shift();
  }
  render(entry);
}

async function backfill() {
  const res = await fetch(`${base()}/v1/diagnostics/logs?afterSeq=${lastSeq}`, {
    headers: authHeaders(),
  });
  const page = await res.json();
  for (const entry of page.entries) {
    lastSeq = Math.max(lastSeq, entry.seq);
    remember(entry);
  }
  if (page.dropped > 0) {
    remember({
      seq: -1,
      at: new Date().toISOString(),
      channel: 'daemon',
      level: 'warn',
      message: `${page.dropped} earlier entries scrolled out of the daemon's buffer — they are still in the log file.`,
      context: null,
    });
  }
}

async function pushChannels() {
  await fetch(`${base()}/v1/diagnostics/settings`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: [...channels] }),
  });
}

/**
 * Attach to the daemon's `/ws` debug room.
 *
 * Raw WebSocket rather than socket.io-client: the panel has no bundler, and
 * the daemon's engine.io speaks a framing simple enough to write out — a
 * `40` namespace-connect, then `42["debug_subscribe",…]`, with `42[...]`
 * frames coming back. Pulling a bundled client in here would mean a build step
 * for one file.
 */
function connect() {
  // The trailing slash after `/ws` is REQUIRED and was measured, not guessed:
  // engine.io mounts its handler at `<path>/`, so `/ws?EIO=4…` is refused at
  // the upgrade with no frames at all, while `/ws/?EIO=4…` opens.
  const url = `ws://${handle.host}:${handle.port}/ws/?EIO=4&transport=websocket`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    // engine.io handshake: `40` opens the default namespace, and the daemon's
    // gateway reads its token from the handshake `auth` payload.
    socket.send(`40${JSON.stringify({ token: handle.token })}`);
  });
  socket.addEventListener('message', (event) => {
    const data = String(event.data);
    if (data.startsWith('2')) {
      socket.send('3'); // ping → pong, or engine.io drops us
      return;
    }
    if (data.startsWith('40')) {
      statusEl.textContent = `connected · ${handle.host}:${handle.port}`;
      socket.send(`42${JSON.stringify(['debug_subscribe', { on: true }])}`);
      return;
    }
    if (!data.startsWith('42')) {
      return;
    }
    const [event_, payload] = JSON.parse(data.slice(2));
    if (event_ === 'debug' && payload && payload.seq > lastSeq) {
      lastSeq = payload.seq;
      remember(payload);
    }
  });
  socket.addEventListener('close', () => {
    statusEl.textContent = 'disconnected — reopen DevTools to retry';
  });
  socket.addEventListener('error', () => {
    statusEl.textContent = 'connection failed';
  });
}

for (const button of document.querySelectorAll('button[data-channel]')) {
  button.addEventListener('click', async () => {
    const channel = button.dataset.channel;
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    if (on) {
      channels.add(channel);
    } else {
      channels.delete(channel);
    }
    repaint();
    if (handle) {
      await pushChannels();
    }
  });
}
filterEl.addEventListener('input', repaint);
document.getElementById('clear').addEventListener('click', () => {
  all = [];
  repaint();
});

(async () => {
  handle = await readHandle();
  if (!handle) {
    statusEl.textContent = 'no daemon on the inspected page';
    emptyEl.textContent =
      'This page is not a Geniro window, or its daemon has not connected yet.';
    return;
  }
  await pushChannels();
  await backfill();
  connect();
})();
