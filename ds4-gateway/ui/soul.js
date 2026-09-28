const editor = document.getElementById('soul-editor');
const save = document.getElementById('soul-save');
const reload = document.getElementById('soul-reload');
const message = document.getElementById('soul-message');
let loaded = null;
let busy = false;
const dirty = () => loaded !== null && editor.value !== loaded.content;
function controls() {
  save.disabled = busy || !dirty();
  reload.disabled = busy;
  document.getElementById('soul-dirty').textContent = dirty() ? 'Unsaved changes' : '';
}
async function request(options) {
  const response = await fetch('/api/soul', options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'SOUL could not be saved.');
  return data;
}
async function load() {
  if (busy || (dirty() && !window.confirm('Discard your unsaved draft and load SOUL from disk?'))) return;
  busy = true; controls();
  try {
    loaded = await request();
    editor.value = loaded.content;
    editor.disabled = false;
    document.getElementById('soul-path').textContent = loaded.path;
    document.getElementById('soul-backups').textContent = loaded.backups;
    message.textContent = 'Loaded saved SOUL.';
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; controls(); }
}
editor.addEventListener('input', controls);
reload.addEventListener('click', () => void load());
document.getElementById('soul-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !dirty()) return;
  busy = true; controls();
  const draft = editor.value;
  message.textContent = 'Saving…';
  try {
    loaded = await request({method:'PUT', headers:{'content-type':'application/json','x-dsg-csrf':loaded.csrf_token}, body:JSON.stringify({content:draft, revision:loaded.revision})});
    // Edits made while the save was pending remain in the textarea as a new draft.
    message.textContent = 'Saved to the Hermes profile. Previous version backed up.';
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; controls(); }
});
editor.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); if (!save.disabled) document.getElementById('soul-form').requestSubmit();
  }
});
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
void load();
