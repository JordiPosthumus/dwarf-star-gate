import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import IPAddr from 'ipaddr.js';

// This callback supplies the exact checked addresses to the connecting socket.
// Preflight URL checks alone cannot cover a second DNS resolution.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    if (!addresses.length || addresses.some(({ address }) => IPAddr.parse(address).range() !== 'unicast')) {
      const blocked = Object.assign(new Error('Blocked: connection resolves to a private/internal address'), { code: 'EACCES' });
      return callback(blocked, '', 0);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};
