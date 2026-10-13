// End-to-end test: RouterDash against a mock router and a fake DNS upstream.
// Run with: npm test   (needs `openssl` on PATH to make a throwaway cert)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');

const F = require('../lib/form');
const { classify } = require('../lib/services');
const { buildTimeline } = require('../lib/dns');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'routerdash-test-'));
const PORTS = { router: 18443, app: 18686, dns: 15300, upstream: 15353 };
const B = `http://127.0.0.1:${PORTS.app}`;
const kids = [];
let cookie = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function start(file, env) {
  const p = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', d => { p.log += d; }); p.stderr.on('data', d => { p.log += d; });
  kids.push(p); return p;
}
async function api(pathname, body) {
  const r = await fetch(B + pathname, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
const mock = async () => (await fetch(`https://127.0.0.1:${PORTS.router}/__log`)).json();

test.before(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem'), '-days', '1', '-subj', '/CN=router'], { stdio: 'ignore' });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // only for reading the mock's /__log in this test
  start('test/mock-router.js', { MOCK_PORT: PORTS.router, MOCK_CERT_DIR: TMP });
  start('test/fake-upstream-dns.js', { FAKE_DNS_PORT: PORTS.upstream });
  await sleep(600);
  start('server.js', { PORT: PORTS.app, ROUTER_PORT: PORTS.router, DNS_PORT: PORTS.dns, DNS_UPSTREAMS: `127.0.0.1:${PORTS.upstream}`, ROUTERDASH_DIR: path.join(TMP, 'data') });
  await sleep(1200);
});
test.after(() => { for (const k of kids) k.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('checksum matches the value the real router computed', () => {
  const html = `<form name="a"><input name="usrname"><input name="mac">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<input type="checkbox" name="${d}">`).join('')}<input name="starthr"><input name="startmin"><input name="endhr"><input name="endmin"><input type="submit" name="addfilterMac" value="Add"><input type="hidden" name="submit-url" value="/parental-ctrl.asp"><input type="hidden" name="postSecurityFlag"></form>`;
  const f = F.findForm(html, 'a');
  F.applyValues(f.controls, { usrname: 'Test Kid', mac: 'aabbccddeeff', Mon: true, starthr: '22', startmin: '00', endhr: '06', endmin: '30' });
  assert.equal(F.serialize(f.controls, 'addfilterMac').flag, 40523);
});

test('domains are classified into apps, sites and background', () => {
  assert.equal(classify('rr1---sn-x.googlevideo.com').name, 'YouTube');
  assert.equal(classify('g.whatsapp.net').kind, 'bg');
  assert.equal(classify('api.swiggy.com').kind, 'app');
  assert.equal(classify('www.somesite.com').kind, 'site');
  assert.equal(classify('app-measurement.com').kind, 'bg');
});

test('timeline joins lookups less than 10 minutes apart', () => {
  const t = 1e12, m = 60e3;
  const tl = buildTimeline([{ t, q: 'www.youtube.com' }, { t: t + 5 * m, q: 'i.ytimg.com' }, { t: t + 30 * m, q: 'www.youtube.com' }], classify);
  assert.equal(tl.sessions.length, 2);
});

test('setup logs in and state loads', async () => {
  await assert.rejects(api('/api/setup', { host: '127.0.0.1', username: 'admin', password: 'wrong', pin: '1234' }));
  await api('/api/setup', { host: '127.0.0.1', username: 'admin', password: 'secret!pw', pin: '1234' });
  await sleep(5000);
  const s = await api('/api/state');
  assert.equal(s.status.model, 'CNP4000A');
  assert.ok(s.devices.length >= 3);
});

test('wi-fi off/on, bedtime, url block, port forward reach the router signed correctly', async () => {
  await api('/api/wifi', { idx: 1, enabled: false });
  await api('/api/wifi', { idx: 1, enabled: true });
  await api('/api/parental/add', { mac: '12:ff:05:f5:c6:c1', name: 'Bed', days: ['Mon'], start: '22:00', end: '23:59' });
  await api('/api/urlblock/add', { domain: 'example.com' });
  await api('/api/portfw/add', { comment: 'NAS', localIp: '192.168.1.3', publicPort: '8080', localPort: '80', protocol: 'TCP' });
  const l = await mock();
  assert.ok(l.log.length > 5);
  assert.ok(l.log.every(x => x.ok), 'every POST carries a valid postSecurityFlag');
  assert.equal(l.parental.rules.length, 1);
  assert.equal(l.pf.rules[0].ip, '192.168.1.3');
});

test('fixed IP and speed limits reconcile with the router', async () => {
  await api('/api/reservations/add', { mac: '12:ff:05:f5:c6:c1', ip: '192.168.1.3' });
  await api('/api/limits/device', { mac: '12:ff:05:f5:c6:c1', fullSpeed: true });
  await api('/api/limits', { enabled: true, downMbps: 10, upMbps: 3 });
  await sleep(2500);
  let l = await mock();
  assert.equal(l.resv.length, 1);
  assert.equal(l.qosOn, 1);
  assert.ok(l.tc.length >= 2 && !l.tc.some(r => r.srcip === '192.168.1.3' || r.dstip === '192.168.1.3'), 'full-speed device has no rules');
  await api('/api/limits', { enabled: false });
  await sleep(2500);
  l = await mock();
  assert.equal(l.tc.length, 0);
});

test('dns lookups are forwarded and recorded', async () => {
  const q = Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...'www.youtube.com'.split('.').map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0, 0, 1, 0, 1])]);
  const answer = await new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('message', m => { s.close(); resolve(m); });
    setTimeout(() => { try { s.close(); } catch {} reject(new Error('no DNS answer. Server log:\n' + kids[2].log.slice(-800))); }, 3000);
    s.send(q, PORTS.dns, '127.0.0.1');
  });
  assert.equal(answer.readUInt16BE(0), 0x1234);
  await sleep(5500); // recorder flushes every 5 s
  const o = await api('/api/activity');
  assert.ok(o.devices.some(d => d.top.some(t => t.name === 'YouTube')));
});
