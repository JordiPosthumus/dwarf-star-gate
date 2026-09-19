import {timingSafeEqual} from 'node:crypto';
import net from 'node:net';

// Use the TCP peer only. Forwarded headers never grant LAN access.
export function trustedHomePeer(address,prefix='192.168.100.') {
  const ip=String(address??'').replace(/^::ffff:/i,'');
  return ip==='::1'||(net.isIP(ip)===4&&(ip.startsWith('127.')||(typeof prefix==='string'&&/^(?:\d{1,3}\.){3}$/.test(prefix)&&prefix.slice(0,-1).split('.').every(n=>Number(n)<=255)&&ip.startsWith(prefix))));
}
export function requestAuthorized(config,req) {
  if(config.lan_auth==='none'&&trustedHomePeer(req.socket?.remoteAddress,config.lan_auth_prefix))return true;
  if(typeof config.api_key!=='string'||!config.api_key)return false;
  const expected=Buffer.from(`Bearer ${config.api_key}`),actual=Buffer.from(req.headers.authorization??'');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
