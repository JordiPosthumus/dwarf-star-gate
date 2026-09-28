const THINKING_LEVELS=['none','minimal','low','medium','high','xhigh','max'];
export function safeGenieThinking(value){
  if(!value||!THINKING_LEVELS.includes(value.chat)||!THINKING_LEVELS.includes(value.reviewer))return null;
  const saved=value.saved&&typeof value.saved==='object'?Object.fromEntries(['chat','reviewer'].filter(key=>THINKING_LEVELS.includes(value.saved[key])).map(key=>[key,value.saved[key]])):null;
  return {chat:value.chat,reviewer:value.reviewer,saved,levels:[...THINKING_LEVELS]};
}
