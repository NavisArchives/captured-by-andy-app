// The storage page. Plain HTML and a little script, no build step. Keys are
// user-supplied, so they are only ever written with textContent, never innerHTML.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CapturedByAndy · Storage</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --fg: #1a1a1a; --muted: #6d6a65; --line: #e2dfd8;
    --card: #fff; --danger: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #ececec; --muted: #9b9892; --line: #2a2a2a;
    --card: #191919; --danger: #f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; }
  .sub { color: var(--muted); margin: 2px 0 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
    background: transparent; color: inherit; min-width: 220px; }
  button { font: inherit; padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px;
    background: transparent; color: inherit; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button.armed { color: var(--danger); border-color: var(--danger); }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); font-size: 13px; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.key { word-break: break-all; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions button { margin-left: 4px; }
  a { color: inherit; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 13px; }
  #status { min-height: 1.5em; color: var(--muted); }
  .overflow { overflow-x: auto; }
</style>
</head>
<body>
<main>
  <h1>CapturedByAndy</h1>
  <p class="sub">Storage · local R2 bucket <code>PHOTOS</code></p>
  <p id="status" role="status"></p>

  <section>
    <h2>Upload</h2>
    <form id="upload">
      <label>Folder <input id="folder" type="text" value="galleries/demo"></label>
      <input id="files" type="file" multiple>
      <button>Upload</button>
    </form>
  </section>

  <section>
    <h2>Files</h2>
    <form id="filter">
      <label>Prefix <input id="prefix" type="text" placeholder="galleries/"></label>
      <button>Filter</button>
    </form>
    <div class="overflow">
      <table>
        <thead><tr><th>Key</th><th>Size</th><th>Type</th><th>Uploaded</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p id="empty">No files yet.</p>
    <button id="more" hidden>Load more</button>
  </section>

  <section>
    <h2>Details</h2>
    <pre id="out">Choose Info or Link on a file.</pre>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const enc = (key) => key.split('/').map(encodeURIComponent).join('/');
  const size = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const say = (msg) => { $('status').textContent = msg; };
  let cursor = null;

  async function api(path, init) {
    const res = await fetch(path, init);
    if (!res.ok && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.status + ' ' + res.statusText);
    }
    return res;
  }

  async function load(append) {
    const q = new URLSearchParams({ prefix: $('prefix').value });
    if (append && cursor) q.set('cursor', cursor);
    const data = await (await api('/api/files?' + q)).json();
    if (!append) $('rows').replaceChildren();
    for (const f of data.items) $('rows').append(row(f));
    cursor = data.cursor;
    $('more').hidden = !cursor;
    $('empty').hidden = $('rows').children.length > 0;
  }

  function row(f) {
    const tr = document.createElement('tr');
    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
      return td;
    };
    const key = cell('', 'key');
    const a = document.createElement('a');
    a.href = '/api/files/' + enc(f.key);
    a.target = '_blank';
    a.textContent = f.key;
    key.append(a);
    cell(size(f.size), 'num');
    cell(f.contentType || '—');
    cell(new Date(f.uploadedAt).toLocaleString(), 'num');
    const actions = cell('', 'actions');
    for (const [label, fn] of [['Info', info], ['Link', sign], ['Delete', remove]]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => fn(f.key, b).catch((e) => say(e.message));
      actions.append(b);
    }
    return tr;
  }

  async function info(key) {
    const res = await api('/api/meta/' + enc(key));
    $('out').textContent = res.status === 404 ? 'No longer there: ' + key : JSON.stringify(await res.json(), null, 2);
  }

  async function sign(key) {
    const res = await fetch('/api/sign/' + enc(key) + '?expiresIn=900', { method: 'POST' });
    const body = await res.json();
    $('out').textContent = res.ok
      ? 'Signed download link, valid 15 minutes:\\n' + body.url
      : 'Signed link unavailable (' + res.status + '):\\n' + body.error;
  }

  // Two clicks to delete: the first arms the button, the second deletes.
  async function remove(key, button) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm';
      setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete'; }, 3000);
      return;
    }
    await api('/api/files/' + enc(key), { method: 'DELETE' });
    const still = await fetch('/api/files/' + enc(key), { method: 'HEAD' });
    say(still.status === 404 ? 'Deleted ' + key : 'Delete did not stick: ' + key);
    await load(false);
  }

  $('upload').onsubmit = async (e) => {
    e.preventDefault();
    const files = [...$('files').files];
    if (!files.length) return say('Choose a file first.');
    const folder = $('folder').value.trim().replace(/^\\/+|\\/+$/g, '');
    try {
      for (const [i, file] of files.entries()) {
        say('Uploading ' + (i + 1) + '/' + files.length + ': ' + file.name);
        await api('/api/files/' + enc((folder ? folder + '/' : '') + file.name),
          { method: 'PUT', body: file, headers: file.type ? { 'content-type': file.type } : {} });
      }
      say('Uploaded ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '.');
      $('files').value = '';
      await load(false);
    } catch (err) { say(err.message); }
  };
  $('filter').onsubmit = (e) => { e.preventDefault(); load(false).catch((err) => say(err.message)); };
  $('more').onclick = () => load(true).catch((err) => say(err.message));
  load(false).catch((err) => say(err.message));
</script>
</body>
</html>`;
