// Prefix DSG-owned messages only. Upstream DS4 response bodies remain verbatim.
export function dsgReport(message) {
  const text=String(message);
  return text.startsWith('DSG Report: ')?text:`DSG Report: ${text}`;
}

export function invalidHttp(error,socket) {
  if(!socket.writable||error.code==='ECONNRESET')return;
  const status=error.code==='HPE_HEADER_OVERFLOW'?431:400;
  const body=JSON.stringify({error:{type:'gateway_error',code:'invalid_http',message:dsgReport('Invalid HTTP request; connection closed.')}});
  socket.end(`HTTP/1.1 ${status} ${status===431?'Request Header Fields Too Large':'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
