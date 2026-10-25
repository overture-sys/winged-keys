// Minimal zero-dependency WebSocket client (RFC 6455), enough for Stream Dock's local JSON messages.
// Text frames only, client frames masked, handles ping/pong, close and fragmented messages.
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WS extends EventEmitter {
  constructor(url) {
    super();
    this.OPEN = 1;
    this.readyState = 0;
    const u = new URL(url);
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.upgraded = false;
    const key = crypto.randomBytes(16).toString('base64');
    this.expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.sock = net.connect(Number(u.port) || 80, u.hostname, () => {
      this.sock.write(`GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('close', () => { this.readyState = 3; this.emit('close'); });
    this.sock.on('error', () => { try { this.sock.destroy(); } catch {} });
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > WS.MAX_FRAME + 16) { this.sock.destroy(); return; }
    if (!this.upgraded) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buf.length > 16384) this.sock.destroy(); return; }
      const head = this.buf.slice(0, end).toString();
      const accept = (head.match(/^sec-websocket-accept:\s*(\S+)/im) || [])[1];
      if (!/^HTTP\/1\.1 101/.test(head) || accept !== this.expectAccept) { this.sock.destroy(); return; }
      this.upgraded = true;
      this.readyState = 1;
      this.buf = this.buf.slice(end + 4);
      this.emit('open');
    }
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = (b[1] & 0x80) !== 0;
      if (len > WS.MAX_FRAME) { this.sock.destroy(); return; }
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      if (masked) { const m = b.slice(off - 4, off); payload = Buffer.from(payload.map((v, i) => v ^ m[i % 4])); }
      this.buf = b.slice(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      this.frag.push(payload);
      this.fragSize = (this.fragSize || 0) + payload.length;
      if (this.fragSize > WS.MAX_FRAME) { this.sock.destroy(); return; }
      if (fin) {
        const msg = Buffer.concat(this.frag); this.frag = []; this.fragSize = 0;
        try { this.emit('message', msg); } catch (e) { process.emitWarning('message handler failed: ' + (e && e.message)); }
      }
    }
  }
  _frame(op, payload) {
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) head = Buffer.from([0x80 | op, 0x80 | payload.length]);
    else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
    const body = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, body]));
  }
  send(text) { if (this.readyState === 1) this._frame(0x1, Buffer.from(text)); }
  close() { if (this.readyState === 1) { try { this._frame(0x8, Buffer.alloc(0)); } catch {} } this.readyState = 2; this.sock.end(); }
  on(ev, fn) { return super.on(ev, fn); }
}
WS.OPEN = 1;
WS.MAX_FRAME = 16 * 1024 * 1024;
module.exports = WS;
