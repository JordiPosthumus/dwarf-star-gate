const $ = id => document.getElementById(id);
let documents = [], selected = 'memories/MEMORY.md', loading = false;
function show(id) {
  selected = id;
  const item = documents.find(document => document.id === id);
  if(!item) return;
  $('memory-title').textContent = item.label;
  $('memory-content').textContent = item.content || (item.present ? 'This file is empty.' : 'Nothing saved here yet.');
  $('memory-file').textContent = item.path;
  $('memory-updated').textContent = item.updated_at ? `Updated ${new Date(item.updated_at).toLocaleString()}` : 'Not saved yet';
  for(const button of $('memory-list').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.id === id));
}
function renderList() {
  const list = $('memory-list'); list.replaceChildren();
  const query=$('memory-search').value.trim().toLowerCase();
  for(const [kind,label] of [['memory','Saved memory'],['skill','Skills'],['note','Supporting notes']]) {
    const items=documents.filter(item=>item.kind===kind && (!query || `${item.label} ${item.id}`.toLowerCase().includes(query)));
    if(!items.length) continue;
    let group=list;
    if(kind==='memory') {
      const heading=document.createElement('h3');heading.textContent=label;list.append(heading);
    } else {
      group=document.createElement('details');group.open=!!query || items.some(item=>item.id===selected);
      const summary=document.createElement('summary');summary.textContent=`${label} · ${items.length}`;group.append(summary);list.append(group);
    }
    for(const item of items) {
      const button=document.createElement('button');button.type='button';button.dataset.id=item.id;
      button.textContent=item.label;button.setAttribute('aria-pressed',String(item.id===selected));
      button.addEventListener('click',()=>show(item.id));group.append(button);
    }
  }
  if(!list.children.length) list.textContent='No matching files.';
}
$('memory-search').addEventListener('input',renderList);
async function load() {
  if(loading) return; loading = true; $('memory-refresh').disabled = true;
  $('memory-status').textContent = 'Reading native files…';
  try {
    const response = await fetch('/api/memory', {signal:AbortSignal.timeout(10000)});
    const value = await response.json(); if(!response.ok) throw Error(value.error || 'Memory unavailable.');
    documents = value.documents;
    renderList();
    if(!documents.some(item=>item.id===selected)) selected=documents[0]?.id;
    show(selected);
    const saved=documents.filter(item=>item.kind==='memory' && item.content.trim()).length;
    const skills=documents.filter(item=>item.kind==='skill').length;
    $('memory-status').textContent = `${saved} saved memory files · ${skills} skill${skills===1?'':'s'} · Read directly from disk`;
  } catch(error) { $('memory-status').textContent = `${error.message} Previously displayed content may be stale.`; }
  finally { loading = false; $('memory-refresh').disabled = false; }
}
$('memory-refresh').addEventListener('click',()=>void load());
new MutationObserver(()=>{if(!$('view-memory').hidden)void load();}).observe($('view-memory'),{attributes:true,attributeFilter:['hidden']});
if(!$('view-memory').hidden)void load();
