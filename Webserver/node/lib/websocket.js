'use strict';

// A small WebSocket server side (RFC 6455) for one use: the Android app's
// SignalR connection (lib/mobilechat.js), whose client tries WebSockets
// first and never falls back when the handshake is refused. Text frames,
// ping/pong and close; frames from the client are masked, ours are not.
//
//   const ws = websocket.accept(req, socket, head, { onText, onClose })   -> null if not a WebSocket request
//   ws.send(text)   ws.close()

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;
const PING_MS = 25 * 1000;

function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function accept(req, socket, head, { onText = () => {}, onClose = () => {} } = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!/websocket/i.test(String(req.headers.upgrade || '')) || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  const answer = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${answer}\r\n\r\n`);
  socket.setNoDelay(true);

  let buffered = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let pieces = [];
  let piecesLength = 0;
  let closed = false;

  const ws = {
    send(text) {
      if (closed) return false;
      socket.write(frame(0x1, Buffer.from(String(text), 'utf8')));
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(pinger);
      try { socket.end(frame(0x8, Buffer.from([0x03, 0xe8]))); } catch (error) { /* gone */ }
      onClose();
    },
    get open() { return !closed; },
  };

  const pinger = setInterval(() => {
    if (!closed) socket.write(frame(0x9, Buffer.alloc(0)));
  }, PING_MS);
  pinger.unref();

  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(pinger);
    onClose();
  }

  function read() {
    while (buffered.length >= 2) {
      const fin = (buffered[0] & 0x80) !== 0;
      const opcode = buffered[0] & 0x0f;
      const masked = (buffered[1] & 0x80) !== 0;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return ws.close();
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE || !masked) return ws.close();
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(offset + 4 + length);
      if (opcode === 0x8) return ws.close();
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        pieces.push(payload);
        piecesLength += payload.length;
        if (piecesLength > MAX_MESSAGE) return ws.close();
        if (fin) {
          const text = Buffer.concat(pieces).toString('utf8');
          pieces = [];
          piecesLength = 0;
          try { onText(text); } catch (error) { /* the handler's problem */ }
        }
      }
    }
  }

  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    read();
  });
  socket.on('close', finish);
  socket.on('error', finish);
  if (buffered.length) setImmediate(read);
  return ws;
}

module.exports = { accept };
