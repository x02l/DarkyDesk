'use strict';
const $ = (id) => document.getElementById(id);
let cloudflaredPath = null;
let current = null;

function render(s) {
  current = s;
  const active = s.website.status === 'running' || s.website.status === 'starting';
  $('web-dot').className = 'dot ' + s.website.status;
  $('web-text').textContent = s.website.message;
  $('tun-dot').className = 'dot ' + s.tunnel.status;
  $('tun-text').textContent = s.tunnel.message;
  $('port-text').textContent = s.port && active ? String(s.port) : '\u2014';
  $('lat-text').textContent = s.latencyMs == null ? '\u2014' : s.latencyMs + ' ms';
  $('url').value = s.publicUrl || '';
  $('copy').disabled = $('open').disabled = !s.publicUrl;
  $('open-local').disabled = !(s.website.status === 'running');
  $('start').disabled = active;
  $('stop').disabled = !active && s.tunnel.status === 'stopped';
  $('folder').disabled = $('port').disabled = $('pick').disabled = $('pick-cf').disabled = active;
  if (active && s.folder) { $('folder').value = s.folder; $('port').value = s.port; }

  const alert = $('alert');
  alert.hidden = !s.error;
  alert.textContent = s.error || '';
  const warn = $('warn');
  warn.hidden = !s.warning;
  warn.textContent = s.warning || '';
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = s.log.length ? s.log.join('\n') : 'No output yet.';
  if (stick) log.scrollTop = log.scrollHeight;
}

$('pick').addEventListener('click', async () => {
  const f = await window.darky.pickFolder();
  if (f) $('folder').value = f;
});
$('pick-cf').addEventListener('click', async () => {
  const p = await window.darky.pickCloudflared();
  if (p) { cloudflaredPath = p; $('cf-path').textContent = 'cloudflared: ' + p; }
});
$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  const r = await window.darky.start({ folder: $('folder').value, port: $('port').value, cloudflaredPath });
  if (!r.ok) { $('alert').hidden = false; $('alert').textContent = r.error; $('start').disabled = false; }
});
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  await window.darky.stop();
});
$('copy').addEventListener('click', async () => {
  if (current?.publicUrl && await window.darky.copyUrl(current.publicUrl)) {
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  }
});
$('open').addEventListener('click', () => current?.publicUrl && window.darky.openUrl(current.publicUrl));
$('open-local').addEventListener('click', () => current?.port && window.darky.openLocal(current.port));

window.darky.onState(render);
window.darky.getState().then(render);
