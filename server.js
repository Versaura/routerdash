#!/usr/bin/env node
// RouterDash by Versaura — a local dashboard for Realtek-based ISP fibre routers
// (verified on the Camnex CNP4000A supplied by GTPL).
// Runs on your Mac; open http://<mac-ip>:8686 from any phone on your Wi-Fi.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('./lib/router');
const { DnsRecorder, buildTimeline } = require('./lib/dns');
const { classify } = require('./lib/services');

const PORT = Number(process.env.PORT || 8686);
const DIR = process.env.ROUTERDASH_DIR || path.join(os.homedir(), '.routerdash');
const CFG = path.join(DIR, 'config.json');
const DATA = path.join(DIR, 'data.json');
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
// Keep running if something unexpected throws; the error is logged instead.
process.on('uncaughtException', e => log('unexpected error:', e && e.stack || e));
process.on('unhandledRejection', e => log('unexpected error:', e && e.stack || e));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

let config = readJSON(CFG, null);
let data = readJSON(DATA, { names: {}, schedules: [], lastRuns: {} });
data.names ||= {}; data.schedules ||= []; data.lastRuns ||= {};
data.limits ||= { enabled: false, downMbps: 10, upMbps: 3, fullSpeed: [], custom: {} };
data.limits.custom ||= {}; data.limits.fullSpeed ||= [];
data.activity ||= { enabled: true };
const saveData = () => writeJSON(DATA, data);

let router = config ? new Router({ host: config.host, username: config.username, password: config.password, log }) : null;
const sessions = new Map(); // token -> expiry
const lanPrefix = () => process.env.LAN_PREFIX || (config?.host || '192.168.1.1').split('.').slice(0, 3).join('.') + '.';

// ---------- live state, polled in the background ----------
const state = {
  status: null, radios: [], devices: [], history: [], totals: { down: 0, up: 0 },
  lastPoll: 0, error: null, selfMac: null, selfBand: null,
};
const prevBytes = new Map(); // mac -> {tx, rx, t}
let arpCache = [], dhcpCache = [];

const isRandomMac = m => /^.[26ae]/i.test(m);
function selfIdentity() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || [])
    if (i.family === 'IPv4' && !i.internal && i.address.startsWith(lanPrefix())) return { ip: i.address, mac: (i.mac || '').toLowerCase() };
  return null;
}

async function pollFast() {
  if (!router) return;
  const now = Date.now();
  const [w5, w24] = await Promise.all([router.wifiClients(0), router.wifiClients(1)]);
  const wifi = [...w5, ...w24];
  let down = 0, up = 0;
  for (const c of wifi) {
    const p = prevBytes.get(c.mac);
    c.downBps = 0; c.upBps = 0;
    if (p && now > p.t) {
      const wrap = v => (v < 0 ? v + 4294967296 : v);
      const dt = (now - p.t) / 1000;
      // Router's TX to the device = device download.
      c.downBps = Math.round(wrap(c.txBytes - p.tx) * 8 / dt);
      c.upBps = Math.round(wrap(c.rxBytes - p.rx) * 8 / dt);
      if (c.downBps > 2e9) c.downBps = 0; if (c.upBps > 2e9) c.upBps = 0; // counter reset
    }
    prevBytes.set(c.mac, { tx: c.txBytes, rx: c.rxBytes, t: now });
    down += c.downBps; up += c.upBps;
  }
  const self = selfIdentity();
  const seen = new Set();
  const devices = [];
  const ipOf = mac => (dhcpCache.find(d => d.mac === mac) || arpCache.find(a => a.mac === mac) || {}).ip || '';
  for (const c of wifi) {
    seen.add(c.mac);
    devices.push({ ...c, ip: ipOf(c.mac), kind: 'wifi' });
  }
  for (const a of arpCache) if (!seen.has(a.mac)) { seen.add(a.mac); devices.push({ mac: a.mac, ip: a.ip, kind: 'wired', band: 'Wired / idle', downBps: 0, upBps: 0 }); }
  for (const d of devices) {
    d.name = data.names[d.mac] || '';
    d.fullSpeed = data.limits.fullSpeed.includes(d.mac);
    d.limit = data.limits.enabled && !d.fullSpeed ? limitFor(d.mac) : null;
    d.reservedIp = (state.reservations || []).find(r => r.mac === d.mac)?.ip || '';
    d.privateMac = isRandomMac(d.mac);
    d.isThisMac = !!self && (d.mac === self.mac || d.ip === self.ip);
    d.blocked = !!(state.parental && state.parental.rules.find(r => r.mac.replace(/[^0-9a-f]/g, '') === d.mac.replace(/:/g, '') && r.name && r.name.startsWith('RD-block')));
  }
  devices.sort((a, b) => (b.downBps + b.upBps) - (a.downBps + a.upBps) || (a.kind === 'wifi' ? -1 : 1));
  const me = devices.find(d => d.isThisMac);
  state.selfBand = me ? me.band : (self ? 'Wired / unknown' : null);
  state.devices = devices;
  state.totals = { down, up };
  state.history.push({ t: now, down, up });
  if (state.history.length > 90) state.history.shift();
  state.lastPoll = now; state.error = null;
}

async function pollSlow() {
  if (!router) return;
  const [status, arp, dhcp, r0, r1, parental] = await Promise.all([
    router.status(), router.arp(), router.dhcpLeases(),
    router.wifiInfo(0).catch(() => null), router.wifiInfo(1).catch(() => null),
    router.parental().catch(() => null),
  ]);
  state.status = status; arpCache = arp; dhcpCache = dhcp;
  // Forward lookups to the ISP's own DNS (what the router uses), public DNS as backup.
  if (!process.env.DNS_UPSTREAMS) {
    const isp = String(status.dns || '').split(/[\s,]+/).filter(x => /^\d+\.\d+\.\d+\.\d+$/.test(x) && !x.startsWith(lanPrefix()));
    dns.upstreams = [...new Set([...isp.slice(0, 2), '1.1.1.1', '8.8.8.8'])];
  }
  state.radios = [r0, r1].filter(Boolean);
  if (parental) state.parental = parental;
  state.reservations = await router.reservations().catch(() => state.reservations || []);
  await reconcileLimits().catch(e => { state.limitsError = e.message; log('speed limits:', e.message); });
}

// ---------- speed limits ----------
// The router limits by IP address, one rule per device and direction.
// Every 30 s RouterDash compares what should be limited with the router's
// rule table and adds or removes rules so they match.
function limitFor(mac) {
  const c = data.limits.custom[mac];
  return { downMbps: c?.downMbps ?? data.limits.downMbps, upMbps: c?.upMbps ?? data.limits.upMbps };
}
async function reconcileLimits() {
  if (!router) return;
  const L = data.limits;
  if (!L.enabled && !L.managedOnce) return;
  const rules = await router.shapingRules();
  const managed = rules.filter(r => router.onLan(r.ip));
  const want = new Map();
  if (L.enabled) for (const d of state.devices) {
    if (!d.ip || L.fullSpeed.includes(d.mac)) continue;
    const lim = limitFor(d.mac);
    if (lim.downMbps > 0) want.set(d.ip + '|down', Math.round(lim.downMbps * 1000));
    if (lim.upMbps > 0) want.set(d.ip + '|up', Math.round(lim.upMbps * 1000));
  }
  const keep = new Set(); const del = [];
  for (const r of managed) {
    const k = r.ip + '|' + r.direction; const rate = want.get(k);
    if (rate && Math.abs(rate - r.rate) <= Math.max(2, rate * 0.01) && !keep.has(k)) keep.add(k);
    else del.push(r.id);
  }
  const add = [...want.entries()].filter(([k]) => !keep.has(k)).slice(0, 16);
  if (!del.length && !add.length) { state.limitRules = managed.length; state.limitsError = null; return; }
  if (add.length) {
    const q = await router.qos();
    if (!q.enabled) { await router.setQos(true); L.qosByUs = true; }
  }
  if (del.length) { log(`speed limits: removing ${del.length} rule(s)`); await router.deleteShapingRules(del); }
  for (const [k, kbps] of add) {
    const [ip, direction] = k.split('|');
    log(`speed limits: ${ip} ${direction} ${kbps} kb/s`);
    await router.addShapingRule({ ip, direction, kbps });
  }
  L.managedOnce = L.enabled || (managed.length - del.length) > 0;
  if (!L.enabled && L.qosByUs) { await router.setQos(false).catch(() => {}); L.qosByUs = false; }
  saveData();
  state.limitRules = (await router.shapingRules()).length; state.limitsError = null;
}

// ---------- activity history (DNS) ----------
const whoIs = (ip) => {
  const d = state.devices.find(x => x.ip === ip);
  if (d) return { mac: d.mac };
  const a = dhcpCache.find(x => x.ip === ip) || arpCache.find(x => x.ip === ip);
  return a ? { mac: a.mac } : null;
};
const dns = new DnsRecorder({
  dir: DIR, port: Number(process.env.DNS_PORT || 53), whoIs, log,
  upstreams: (process.env.DNS_UPSTREAMS || '1.1.1.1,8.8.8.8').split(',').map(s => s.trim()).filter(Boolean),
});
// Always forward lookups (devices may depend on it); only recording can be paused.
dns.paused = !data.activity.enabled;
dns.start();

let fastBusy = false, slowBusy = false;
setInterval(async () => {
  if (fastBusy || !router) return; fastBusy = true;
  try { await pollFast(); } catch (e) { state.error = e.message; log('poll error:', e.message); } finally { fastBusy = false; }
}, 4000);
setInterval(async () => {
  if (slowBusy || !router) return; slowBusy = true;
  try { await pollSlow(); } catch (e) { state.error = e.message; } finally { slowBusy = false; }
}, 30000);
const kick = () => { pollSlow().then(pollFast).catch(e => { state.error = e.message; log('initial poll:', e.message); }); };
if (router) kick();

// ---------- scheduler (runs while this Mac is awake) ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function runAction(s, what) {
  log(`schedule "${s.label || s.type}" -> ${what}`);
  if (s.type === 'wifi') for (const idx of s.bands) await router.setWifi(idx, what === 'on');
  if (s.type === 'reboot') await router.reboot();
  setTimeout(kick, 5000);
}
setInterval(async () => {
  if (!router) return;
  const d = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const day = DAYS[d.getDay()];
  const stamp = d.toDateString() + ' ' + hm;
  for (const s of data.schedules) {
    if (!s.enabled || !s.days.includes(day)) continue;
    const todo = s.type === 'wifi' ? [[s.off, 'off'], [s.on, 'on']] : [[s.at, 'reboot']];
    for (const [t, what] of todo) {
      const key = s.id + ':' + what;
      if (t === hm && data.lastRuns[key] !== stamp) {
        data.lastRuns[key] = stamp; saveData();
        try { await runAction(s, what); s.lastResult = `${what} at ${hm} ✓`; }
        catch (e) { s.lastResult = `${what} at ${hm} failed: ${e.message}`; log(s.lastResult); }
        saveData();
      }
    }
  }
}, 15000);

// ---------- HTTP ----------
const send = (res, code, obj, headers = {}) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const readBody = req => new Promise((ok, bad) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(new Error('Bad JSON')); } });
});
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const authed = req => {
  const m = /(?:^|;\s*)rd=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  const exp = m && sessions.get(m[1]);
  return !!exp && exp > Date.now();
};
const newSession = () => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 30 * 864e5); return `rd=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`; };
const fails = new Map();

const routes = {
  'GET /api/info': async (req) => ({ configured: !!config, authed: authed(req) }),

  'POST /api/setup': async (req, b) => {
    if (config && !authed(req)) throw Object.assign(new Error('Already set up'), { code: 403 });
    if (!b.username || !b.password || !/^\d{4,8}$/.test(b.pin || '')) throw new Error('Router username, password and a 4–8 digit app PIN are required');
    const host = b.host || '192.168.1.1';
    const test = new Router({ host, username: b.username, password: b.password, log });
    await test.run(() => test.login());
    const salt = crypto.randomBytes(16).toString('hex');
    config = { host, username: b.username, password: b.password, salt, pinHash: hashPin(b.pin, salt) };
    writeJSON(CFG, config);
    router = test; kick();
    return { ok: true, __cookie: newSession() };
  },

  'POST /api/login': async (req, b) => {
    const ip = req.socket.remoteAddress; const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw Object.assign(new Error('Too many attempts — wait a minute'), { code: 429 });
    if (!config || hashPin(b.pin || '', config.salt) !== config.pinHash) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(ip, f);
      throw Object.assign(new Error('Wrong PIN'), { code: 401 });
    }
    fails.delete(ip);
    return { ok: true, __cookie: newSession() };
  },

  'GET /api/state': async () => ({
    status: state.status, radios: state.radios, devices: state.devices, totals: state.totals,
    history: state.history, lastPoll: state.lastPoll, error: state.error, selfBand: state.selfBand,
    parentalOn: state.parental ? state.parental.enabled : null,
  }),

  'POST /api/device/name': async (req, b) => {
    const mac = String(b.mac || '').toLowerCase();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) throw new Error('Bad MAC');
    if (b.name) data.names[mac] = String(b.name).slice(0, 40); else delete data.names[mac];
    saveData(); return { ok: true };
  },

  // Block = a router-side parental-control rule covering all day, every day.
  // It lives on the router, so it keeps working when this Mac is off.
  'POST /api/device/block': async (req, b) => {
    const mac = String(b.mac || '').toLowerCase();
    const p = await router.parental();
    const hex = mac.replace(/:/g, '');
    if (b.blocked) {
      if (!p.enabled) await router.setParental(true);
      await router.addParental({ name: 'RD-block', mac: hex, days: DAYS, start: '00:00', end: '23:59' });
    } else {
      const mine = p.rules.filter(r => r.mac.replace(/[^0-9a-f]/g, '') === hex && (r.name || '').startsWith('RD-block'));
      if (mine.length) await router.deleteRows('/parental-ctrl.asp', 'deleteSelFilterMac', 'deleteSelFilterMac', mine.map(r => r.select));
    }
    state.parental = await router.parental();
    return { ok: true };
  },

  'GET /api/parental': async () => router.parental(),
  'POST /api/parental/enable': async (req, b) => { await router.setParental(!!b.enabled); return router.parental(); },
  'POST /api/parental/add': async (req, b) => {
    if (!b.mac || !b.start || !b.end || !b.days?.length) throw new Error('Pick a device, days and a time window');
    const p = await router.parental(); if (!p.enabled) await router.setParental(true);
    await router.addParental({ name: b.name || 'Bedtime', mac: b.mac, days: b.days, start: b.start, end: b.end });
    return (state.parental = await router.parental());
  },
  'POST /api/parental/delete': async (req, b) => {
    await router.deleteRows('/parental-ctrl.asp', 'deleteSelFilterMac', 'deleteSelFilterMac', b.selects || []);
    return (state.parental = await router.parental());
  },

  'GET /api/portfw': async () => ({ ...(await router.portForwards()), wanIp: state.status?.wan?.[0]?.ip }),
  'POST /api/portfw/add': async (req, b) => {
    if (!router.onLan(b.localIp)) throw new Error(`Local IP must be on ${lanPrefix()}x`);
    if (!/^\d+(-\d+)?$/.test(String(b.localPort || ''))) throw new Error('Port must be a number or range like 8000-8010');
    await router.addPortForward(b); return router.portForwards();
  },
  'POST /api/portfw/delete': async (req, b) => { await router.deleteRows('/fw-portfw.asp', 'deleteSelPortFw', 'deleteSelPortFw', b.selects || []); return router.portForwards(); },

  'GET /api/urlblock': async () => router.urlBlocks(),
  'POST /api/urlblock/enable': async (req, b) => { await router.setUrlBlocking(!!b.enabled); return router.urlBlocks(); },
  'POST /api/urlblock/add': async (req, b) => {
    if (b.domain) { if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(b.domain)) throw new Error('Enter a domain like youtube.com'); await router.addUrlBlock(b.domain.toLowerCase()); }
    else if (b.keyword) await router.addKeywordBlock(String(b.keyword).slice(0, 30));
    return router.urlBlocks();
  },
  'POST /api/urlblock/delete': async (req, b) => {
    const btn = b.kind === 'keyword' ? 'delKeywd' : 'delFQDN';
    await router.deleteRows('/url_blocking.asp', 'formURL', btn, b.selects || []); return router.urlBlocks();
  },

  'POST /api/wifi': async (req, b) => {
    const idx = Number(b.idx); if (![0, 1].includes(idx)) throw new Error('Bad radio');
    const band = idx === 0 ? '5 GHz' : '2.4 GHz';
    if (!b.enabled && state.selfBand === band && !b.force) throw new Error(`This Mac is connected over ${band}. Turning it off would disconnect the app, and it couldn't turn it back on.`);
    await router.setWifi(idx, !!b.enabled); setTimeout(kick, 3000); return { ok: true };
  },
  'POST /api/reboot': async () => { await router.reboot(); state.status = null; setTimeout(kick, 90000); return { ok: true }; },

  'GET /api/schedules': async () => ({ schedules: data.schedules, selfBand: state.selfBand }),
  'POST /api/schedules': async (req, b) => {
    const s = { id: b.id || crypto.randomBytes(4).toString('hex'), type: b.type, label: String(b.label || '').slice(0, 40), days: (b.days || []).filter(d => DAYS.includes(d)), enabled: b.enabled !== false };
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!s.days.length) throw new Error('Pick at least one day');
    if (b.type === 'wifi') {
      s.bands = (b.bands || []).map(Number).filter(n => n === 0 || n === 1);
      if (!s.bands.length) throw new Error('Pick a Wi-Fi band');
      if (!hm.test(b.off) || !hm.test(b.on)) throw new Error('Times must be HH:MM');
      const selfIdx = state.selfBand === '5 GHz' ? 0 : state.selfBand === '2.4 GHz' ? 1 : -1;
      if (s.bands.includes(selfIdx)) throw new Error(`This Mac uses ${state.selfBand}. Once that's off, the app can't turn it back on. Connect the Mac by cable or to the other band, or schedule only the other band.`);
      s.off = b.off; s.on = b.on;
    } else if (b.type === 'reboot') {
      if (!hm.test(b.at)) throw new Error('Time must be HH:MM'); s.at = b.at;
    } else throw new Error('Unknown schedule type');
    data.schedules = data.schedules.filter(x => x.id !== s.id).concat(s); saveData();
    return { schedules: data.schedules };
  },
  'POST /api/schedules/delete': async (req, b) => { data.schedules = data.schedules.filter(x => x.id !== b.id); saveData(); return { schedules: data.schedules }; },
  'POST /api/schedules/toggle': async (req, b) => { const s = data.schedules.find(x => x.id === b.id); if (s) s.enabled = !!b.enabled; saveData(); return { schedules: data.schedules }; },

  // ----- fixed IPs -----
  'GET /api/reservations': async () => ({ reservations: (state.reservations = await router.reservations()) }),
  'POST /api/reservations/add': async (req, b) => {
    const mac = String(b.mac || '').toLowerCase();
    const ip = String(b.ip || '').trim();
    const taken = (state.reservations || []).find(r => r.ip === ip && r.mac !== mac);
    if (taken) throw new Error(`${ip} is already reserved for ${data.names[taken.mac] || taken.mac}`);
    const mine = (state.reservations || []).filter(r => r.mac === mac);
    if (mine.length) await router.deleteReservations(mine.map(r => r.select));
    await router.addReservation(mac, ip);
    return { reservations: (state.reservations = await router.reservations()) };
  },
  'POST /api/reservations/delete': async (req, b) => {
    const mac = String(b.mac || '').toLowerCase();
    const mine = (state.reservations || []).filter(r => r.mac === mac);
    if (mine.length) await router.deleteReservations(mine.map(r => r.select));
    return { reservations: (state.reservations = await router.reservations()) };
  },

  // ----- speed limits -----
  'GET /api/limits': async () => ({ ...data.limits, ruleCount: state.limitRules ?? null, error: state.limitsError || null }),
  'POST /api/limits': async (req, b) => {
    const L = data.limits;
    if (b.enabled != null) {
      L.enabled = !!b.enabled;
      if (L.enabled) {
        L.managedOnce = true;
        // This Mac runs RouterDash; keep it at full speed unless told otherwise.
        const me = state.devices.find(d => d.isThisMac);
        if (me && !L.fullSpeed.includes(me.mac) && !L.touchedSelf) L.fullSpeed.push(me.mac);
      }
    }
    const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Speed must be between ${lo} and ${hi} Mbps`); return Math.round(n * 10) / 10; };
    if (b.downMbps != null) L.downMbps = num(b.downMbps, 0.5, 1000);
    if (b.upMbps != null) L.upMbps = num(b.upMbps, 0.5, 1000);
    saveData(); reconcileLimits().catch(e => { state.limitsError = e.message; });
    return { ...L };
  },
  'POST /api/limits/device': async (req, b) => {
    const mac = String(b.mac || '').toLowerCase(); const L = data.limits;
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) throw new Error('Bad MAC');
    if (state.devices.find(d => d.isThisMac)?.mac === mac) L.touchedSelf = true;
    L.fullSpeed = L.fullSpeed.filter(m => m !== mac);
    if (b.fullSpeed) L.fullSpeed.push(mac);
    if (b.downMbps || b.upMbps) L.custom[mac] = { downMbps: Number(b.downMbps) || L.downMbps, upMbps: Number(b.upMbps) || L.upMbps };
    else delete L.custom[mac];
    saveData(); reconcileLimits().catch(e => { state.limitsError = e.message; });
    return { ...L };
  },

  // ----- activity history -----
  'GET /api/activity/status': async () => ({
    enabled: data.activity.enabled, running: dns.stats.running, error: dns.stats.error,
    queries: dns.stats.queries, lastQuery: dns.stats.lastQuery,
    devicesSeen: [...dns.stats.clients].filter(ip => ip.startsWith(lanPrefix())).length,
    macIp: selfIdentity()?.ip || null, days: dns.days(),
    ispDns: (dns.upstreams || []).find(x => x !== '1.1.1.1' && x !== '8.8.8.8') || '1.1.1.1',
  }),
  'GET /api/activity': async (req) => {
    const u = new URL(req.url, 'http://x');
    const day = /^\d{4}-\d\d-\d\d$/.test(u.searchParams.get('day') || '') ? u.searchParams.get('day') : DnsRecorder.day(Date.now());
    const mac = (u.searchParams.get('mac') || '').toLowerCase();
    const entries = dns.read(day);
    const label = m => data.names[m] || (state.devices.find(d => d.mac === m)?.isThisMac ? 'This Mac' : '');
    if (mac) {
      const dev = state.devices.find(d => d.mac === mac);
      const mine = entries.filter(e => e.mac ? e.mac === mac : (dev && e.ip === dev.ip));
      return { day, mac, name: label(mac), ...buildTimeline(mine, classify) };
    }
    // overview: every device that looked something up that day
    const by = new Map();
    for (const e of entries) { const k = e.mac || e.ip; (by.get(k) || by.set(k, []).get(k)).push(e); }
    const devices = [...by.entries()].map(([k, es]) => {
      const tl = buildTimeline(es, classify);
      const active = tl.top.reduce((n, t) => n + t.minutes, 0);
      const last = es.reduce((m, e) => Math.max(m, e.t), 0);
      return { mac: k.includes(':') ? k : '', ip: es[es.length - 1].ip, name: label(k), top: tl.top.slice(0, 4), activeMinutes: active, last, lookups: es.length };
    }).sort((a, b) => b.last - a.last);
    return { day, devices };
  },
  'POST /api/activity/enable': async (req, b) => {
    data.activity.enabled = !!b.enabled; saveData();
    dns.paused = !data.activity.enabled;
    if (!dns.stats.running) await dns.start();
    return { enabled: data.activity.enabled, running: dns.stats.running, error: dns.stats.error };
  },
  'POST /api/activity/clear': async () => { dns.clear(); return { ok: true }; },
};
const PUBLIC = new Set(['GET /api/info', 'POST /api/setup', 'POST /api/login']);

const indexHtml = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, indexHtml(), { 'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      if (url.pathname === '/manifest.json') return send(res, 200, { name: 'RouterDash', short_name: 'Router', display: 'standalone', start_url: '/', background_color: '#0e1116', theme_color: '#0e1116' });
      return send(res, 404, { error: 'Not found' });
    }
    const h = routes[key]; if (!h) return send(res, 404, { error: 'Not found' });
    if (!PUBLIC.has(key) && !authed(req)) return send(res, 401, { error: 'Login required' });
    if (!PUBLIC.has(key) && !router) return send(res, 409, { error: 'Not set up yet' });
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return send(res, 415, { error: 'JSON only' });
    const b = req.method === 'POST' ? await readBody(req) : {};
    const out = await h(req, b);
    const cookie = out && out.__cookie; if (cookie) delete out.__cookie;
    send(res, 200, out, cookie ? { 'Set-Cookie': cookie } : {});
  } catch (e) {
    log(key, 'error:', e.message);
    const code = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 400;
    if (!res.headersSent) send(res, code, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`\n  RouterDash is running.\n  On this Mac:  http://localhost:${PORT}\n${ips.map(ip => `  On your phone: http://${ip}:${PORT}`).join('\n')}\n`);
});
