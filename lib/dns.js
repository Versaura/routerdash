// A small DNS forwarder for the home network. Devices ask it for names, it
// asks the ISP's DNS (with public DNS as a fallback), passes the answer back, and
// writes down which device asked for which name. It never changes answers.
'use strict';
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');

const QTYPES = { 1: 'A', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS' };

function readQuestion(buf) {
  if (buf.length < 17) return null;
  let off = 12; const labels = [];
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if (len > 63 || off + 1 + len > buf.length) return null;
    labels.push(buf.toString('latin1', off + 1, off + 1 + len));
    off += 1 + len;
  }
  if (off + 4 > buf.length) return null;
  return { name: labels.join('.').toLowerCase(), type: QTYPES[buf.readUInt16BE(off)] || String(buf.readUInt16BE(off)) };
}

function servfail(query) {
  const r = Buffer.from(query);
  if (r.length < 12) return r;
  r[2] = 0x81 | (query[2] & 0x01); // QR + RD copied
  r[3] = 0x82;                        // RA + SERVFAIL
  r.writeUInt16BE(0, 6); r.writeUInt16BE(0, 8); r.writeUInt16BE(0, 10);
  return r;
}

class DnsRecorder {
  constructor({ dir, upstreams = ['1.1.1.1', '8.8.8.8'], port = 53, whoIs = () => null, log = () => {} }) {
    this.dir = path.join(dir, 'activity'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.upstreams = upstreams; this.port = port; this.whoIs = whoIs; this.log = log;
    this.recent = new Map(); // ip|name -> last logged ms
    this.stats = { queries: 0, since: Date.now(), lastQuery: 0, clients: new Set(), error: null, running: false };
    this.buffer = [];
    this.flushTimer = setInterval(() => this.flush(), 5000);
    this.pruneTimer = setInterval(() => this.prune(), 6 * 3600e3);
    this.keepDays = 30;
  }

  start() {
    return new Promise((resolve) => {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udp.on('message', (msg, rinfo) => this.onUdp(udp, msg, rinfo));
      udp.on('error', (e) => {
        this.stats.error = e.code === 'EACCES'
          ? 'macOS refused port 53. Update macOS, or run RouterDash with sudo.'
          : e.code === 'EADDRINUSE' ? 'Port 53 is in use by another program on this Mac (another DNS app or Docker?).' : e.message;
        this.stats.running = false; this.log('DNS recorder:', this.stats.error); resolve(false);
      });
      udp.bind(this.port, '0.0.0.0', () => {
        this.udp = udp; this.stats.running = true; this.stats.error = null;
        // TCP is used for big answers; just relay it.
        this.tcp = net.createServer(sock => this.onTcp(sock)).on('error', () => {}).listen(this.port, '0.0.0.0');
        this.log(`DNS recorder listening on port ${this.port}`);
        resolve(true);
      });
    });
  }

  record(ip, q) {
    if (!q || !q.name) return;
    this.stats.queries++; this.stats.lastQuery = Date.now(); this.stats.clients.add(ip);
    if (q.type === 'PTR' || this.paused) return;
    const key = ip + '|' + q.name; const now = Date.now();
    if (now - (this.recent.get(key) || 0) < 60000) return; // same name from the same device within a minute
    this.recent.set(key, now);
    if (this.recent.size > 50000) this.recent.clear();
    const who = this.whoIs(ip) || {};
    this.buffer.push(JSON.stringify({ t: now, ip, mac: who.mac || '', q: q.name }));
  }

  ask(query, i = 0) {
    return new Promise((resolve) => {
      if (i >= this.upstreams.length) return resolve(null);
      const s = dgram.createSocket('udp4');
      const timer = setTimeout(() => { s.close(); this.ask(query, i + 1).then(resolve); }, 2500);
      s.on('message', (m) => { clearTimeout(timer); s.close(); resolve(m); });
      s.on('error', () => { clearTimeout(timer); try { s.close(); } catch {} this.ask(query, i + 1).then(resolve); });
      const [host, port] = this.upstreams[i].split(':');
      s.send(query, Number(port || 53), host);
    });
  }

  async onUdp(sock, msg, rinfo) {
    const q = readQuestion(msg);
    this.record(rinfo.address, q);
    const answer = await this.ask(msg);
    try { sock.send(answer || servfail(msg), rinfo.port, rinfo.address); } catch {}
  }

  onTcp(client) {
    const [uh, upPort] = this.upstreams[0].split(':');
    const up = net.connect(Number(upPort || 53), uh);
    let first = true;
    client.on('data', (d) => {
      if (first) { first = false; this.record(client.remoteAddress.replace(/^::ffff:/, ''), readQuestion(d.subarray(2))); }
      up.write(d);
    });
    up.on('data', d => client.write(d));
    const end = () => { client.destroy(); up.destroy(); };
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
    client.setTimeout(10000, end);
  }

  fileFor(day) { return path.join(this.dir, day + '.jsonl'); }
  static day(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  flush() {
    if (!this.buffer.length) return;
    const lines = this.buffer; this.buffer = [];
    const byDay = {};
    for (const l of lines) { const t = JSON.parse(l).t; (byDay[DnsRecorder.day(t)] ||= []).push(l); }
    for (const [d, ls] of Object.entries(byDay)) fs.appendFile(this.fileFor(d), ls.join('\n') + '\n', { mode: 0o600 }, () => {});
  }

  prune() {
    const cutoff = Date.now() - this.keepDays * 864e5;
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f);
      if (m && new Date(m[1] + 'T23:59:59').getTime() < cutoff) fs.unlinkSync(path.join(this.dir, f));
    }
  }

  read(day) {
    this.flush();
    const f = this.fileFor(day);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  days() { return fs.readdirSync(this.dir).map(f => (/^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f) || [])[1]).filter(Boolean).sort().reverse(); }

  clear() { this.flush(); for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f)); }
}

// Group lookups into "what was this device doing" sessions.
function buildTimeline(entries, classify, { gapMin = 10 } = {}) {
  const gap = gapMin * 60e3;
  const sessions = []; const open = new Map(); const background = new Map();
  for (const e of entries.sort((a, b) => a.t - b.t)) {
    const c = classify(e.q);
    if (c.kind === 'bg') {
      const b = background.get(c.name) || { name: c.name, cat: c.cat, hits: 0, domains: new Set(), first: e.t, last: e.t };
      b.hits++; b.domains.add(c.domain); b.last = e.t; background.set(c.name, b);
      continue;
    }
    const s = open.get(c.name);
    if (s && e.t - s.end <= gap) { s.end = e.t; s.hits++; s.domains.add(e.q); }
    else {
      const ns = { name: c.name, cat: c.cat, kind: c.kind, start: e.t, end: e.t, hits: 1, domains: new Set([e.q]) };
      sessions.push(ns); open.set(c.name, ns);
    }
  }
  const out = sessions.map(s => ({
    name: s.name, cat: s.cat, kind: s.kind, start: s.start, end: s.end,
    // a session covers at least a minute; a single lookup is shown as "briefly"
    minutes: Math.max(1, Math.round((s.end - s.start) / 60e3)), brief: s.hits < 2,
    hits: s.hits, domains: [...s.domains].slice(0, 12),
  }));
  const totals = {};
  for (const s of out) { const t = totals[s.name] ||= { name: s.name, cat: s.cat, kind: s.kind, minutes: 0, sessions: 0 }; t.minutes += s.brief ? 0 : s.minutes; t.sessions++; }
  return {
    sessions: out.reverse(),
    top: Object.values(totals).sort((a, b) => b.minutes - a.minutes || b.sessions - a.sessions).slice(0, 12),
    background: [...background.values()].map(b => ({ name: b.name, cat: b.cat, hits: b.hits, domains: [...b.domains].slice(0, 8), first: b.first, last: b.last })).sort((a, b) => b.hits - a.hits),
  };
}

module.exports = { DnsRecorder, buildTimeline, readQuestion };
