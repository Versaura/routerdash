// Client for the Camnex CNP4000A (GTPL firmware, Realtek "boa" web server).
// Read pages = plain GETs. Writes = the router's own forms, filled and signed
// with the same checksum its web page uses.
'use strict';
const tls = require('tls');
const { parse } = require('node-html-parser');
const F = require('./form');

class Router {
  constructor({ host = '192.168.1.1', port = Number(process.env.ROUTER_PORT || 443), username, password, log = () => {} }) {
    this.host = host; this.port = port; this.username = username; this.password = password;
    this.cookies = {}; this.log = log;
    this.loggedIn = false; this.queue = Promise.resolve();
  }

  // Serialize all router calls: the web server is single-session and fragile.
  run(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }

  // The router's embedded web server (boa) sends replies that Node's strict
  // HTTP parser rejects (bad lengths, odd status lines, junk after the body).
  // So each request opens its own TLS connection, speaks plain HTTP/1.0, reads
  // until the router closes the connection, and parses the reply leniently.
  // The router's certificate is self-signed; checking is relaxed for this one
  // configured LAN address only.
  raw(method, path, body) {
    return new Promise((resolve, reject) => {
      const lines = [
        `${method} ${path} HTTP/1.0`,
        `Host: ${this.host}`,
        'User-Agent: Mozilla/5.0 (Macintosh) RouterDash',
        'Accept: text/html,*/*',
        `Referer: https://${this.host}/`,
        'Connection: close',
      ];
      const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      if (ck) lines.push(`Cookie: ${ck}`);
      if (body != null) {
        lines.push('Content-Type: application/x-www-form-urlencoded');
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      const req = lines.join('\r\n') + '\r\n\r\n' + (body != null ? body : '');
      const chunks = [];
      let done = false;
      const finish = (err) => {
        if (done) return; done = true; clearTimeout(timer);
        if (err && !chunks.length) return reject(err);
        try { resolve(this.parseReply(Buffer.concat(chunks))); } catch (e) { reject(e); }
      };
      const sock = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false, minVersion: 'TLSv1' }, () => sock.write(req));
      const timer = setTimeout(() => { sock.destroy(); finish(new Error('Router did not respond (timeout)')); }, 15000);
      sock.on('data', d => chunks.push(d));
      sock.on('end', () => finish());
      sock.on('close', () => finish());
      sock.on('error', e => finish(e.code === 'ECONNRESET' ? null : new Error(`Can't reach the router at ${this.host}: ${e.message}`)));
    });
  }

  parseReply(buf) {
    const text = buf.toString('latin1');
    let sep = text.indexOf('\r\n\r\n'), skip = 4;
    const lf = text.indexOf('\n\n');
    if (sep < 0 || (lf >= 0 && lf < sep)) { sep = lf; skip = 2; }
    const head = sep >= 0 ? text.slice(0, sep) : '';
    let bodyText = sep >= 0 ? text.slice(sep + skip) : text;
    const headLines = head.split(/\r?\n/);
    const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headLines[0] || '');
    const status = m ? Number(m[1]) : 200;
    const headers = {};
    for (const l of headLines.slice(1)) {
      const i = l.indexOf(':'); if (i <= 0) continue;
      const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
      if (k === 'set-cookie') {
        const [kv] = v.split(';'); const j = kv.indexOf('=');
        if (j > 0) this.cookies[kv.slice(0, j).trim()] = kv.slice(j + 1).trim();
      }
      headers[k] = headers[k] ? headers[k] + ', ' + v : v;
    }
    if (/chunked/i.test(headers['transfer-encoding'] || '')) {
      let out = '', rest = bodyText;
      for (;;) {
        const nl = rest.indexOf('\r\n'); if (nl < 0) break;
        const size = parseInt(rest.slice(0, nl), 16); if (!size) break;
        out += rest.slice(nl + 2, nl + 2 + size); rest = rest.slice(nl + 2 + size + 2);
      }
      bodyText = out;
    }
    return { status, headers, text: bodyText };
  }

  static looksLoggedOut(r) {
    const loc = r.headers.location || '';
    return /login\.asp/i.test(loc) || /formLogin/i.test(r.text) || /name=["']?cmlogin/i.test(r.text);
  }

  async login() {
    const page = await this.raw('GET', '/admin/login.asp');
    const f = F.findForm(page.text, x => /formLogin/i.test(x.getAttribute('action') || ''));
    // The page base64-encodes the password into encodePassword and disables the
    // clear-text field, so the plain password is never sent.
    F.applyValues(f.controls, {
      username: this.username,
      encodePassword: Buffer.from(this.password, 'latin1').toString('base64'),
    });
    for (const c of f.controls) if (c.name === 'password') c.disabled = true;
    const btn = f.controls.find(c => c.type === 'submit');
    const { body } = F.serialize(f.controls, btn && btn.name);
    const r = await this.raw('POST', f.action, body);
    const check = await this.raw('GET', '/status.asp');
    if (Router.looksLoggedOut(check)) {
      const msg = /(locked|too many|try again)/i.exec(r.text);
      throw new Error(msg ? 'Router refused login: ' + msg[0] : 'Router login failed — check username/password');
    }
    this.loggedIn = true;
    this.log('logged in to router');
  }

  async get(path) {
    return this.run(async () => {
      if (!this.loggedIn) await this.login();
      let r = await this.raw('GET', path);
      if (Router.looksLoggedOut(r)) { this.loggedIn = false; await this.login(); r = await this.raw('GET', path); }
      if (r.status >= 400) throw new Error(`Router returned ${r.status} for ${path}`);
      return r.text;
    });
  }

  // Load a page, fill one of its forms, click a button, post it.
  async submit(pagePath, formPred, values, clickName, mutate) {
    return this.run(async () => {
      if (!this.loggedIn) await this.login();
      let page = await this.raw('GET', pagePath);
      if (Router.looksLoggedOut(page)) { await this.login(); page = await this.raw('GET', pagePath); }
      const f = F.findForm(page.text, formPred);
      F.applyValues(f.controls, values);
      if (mutate) mutate(f.controls);
      const { body } = F.serialize(f.controls, clickName || f.controls.__click || null);
      this.log(`POST ${f.action} (${body.length} bytes)`);
      const r = await this.raw('POST', f.action, body);
      const err = /<[^>]*>\s*(Error|ERROR|Invalid|invalid)[^<]{0,200}/.exec(r.text);
      if (err && !/function|alert\(/.test(err[0])) throw new Error('Router said: ' + err[0].replace(/<[^>]+>/g, '').trim());
      return r;
    });
  }

  // ---------- reads ----------

  static rows(html) {
    return parse(html).querySelectorAll('tr').map(tr => tr.querySelectorAll('td,th').map(td => td.text.replace(/\s+/g, ' ').trim()));
  }

  static kv(html) {
    const out = {};
    for (const r of Router.rows(html)) if (r.length === 2 && r[0]) out[r[0]] = r[1];
    return out;
  }

  async status() {
    const html = await this.get('/status.asp');
    const kv = Router.kv(html);
    const rows = Router.rows(html);
    const hdr = rows.findIndex(r => r[0] === 'Interface' && r.includes('Status'));
    const wan = [];
    if (hdr >= 0) for (const r of rows.slice(hdr + 1)) {
      if (r.length < 7) break;
      const [iface, vlan, type, proto, ip, gw, st] = r;
      wan.push({ iface, vlan, type, proto, ip, gw, up: /^up/i.test(st), uptime: (st.split(/\s+/)[1] || '').split('/')[0] });
    }
    const pct = s => parseInt(s, 10) || 0;
    return {
      model: kv['Device Name'], uptime: kv['Uptime'], firmware: kv['Firmware Version'],
      cpu: pct(kv['CPU Usage']), mem: pct(kv['Memory Usage']), dns: kv['Name Servers'],
      lanIp: kv['IP Address'], dhcp: kv['DHCP Server'], mac: kv['MAC Address'], wan,
    };
  }

  async wifiClients(idx) {
    const html = await this.get(`/wlstatbl.asp?wlan_idx=${idx}`);
    const rows = Router.rows(html);
    const h = rows.findIndex(r => r[0] === 'MAC Address');
    if (h < 0) return [];
    const head = rows[h];
    const col = n => head.indexOf(n);
    return rows.slice(h + 1).filter(r => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(r[0])).map(r => ({
      mac: r[0].toLowerCase(),
      band: idx === 0 ? '5 GHz' : '2.4 GHz',
      txRate: parseFloat(r[col('Tx Rate (Mbps)')]) || 0,
      rxRate: parseFloat(r[col('Rx Rate (Mbps)')]) || 0,
      txBytes: Number(r[col('TXBYTES')]) || 0,
      rxBytes: Number(r[col('RXBYTES')]) || 0,
      rssi: parseInt(r[col('RSSI')], 10) || null,
      channel: r[col('Channel')],
      connectedSec: parseInt(r[col('Uptime')], 10) || 0,
      powerSave: /yes/i.test(r[col('Power Saving')] || ''),
    }));
  }

  async dhcpLeases() {
    const rows = Router.rows(await this.get('/dhcptbl.asp'));
    return rows.filter(r => /^\d+\.\d+\.\d+\.\d+$/.test(r[0])).map(r => ({ ip: r[0], mac: (r[1] || '').toLowerCase(), expires: parseInt(r[2], 10) || 0 }));
  }

  async arp() {
    const rows = Router.rows(await this.get('/arptable.asp'));
    return rows.filter(r => /^\d+\.\d+\.\d+\.\d+$/.test(r[0])).map(r => ({ ip: r[0], mac: (r[1] || '').toLowerCase().replace(/-/g, ':') }));
  }

  async lanPorts() {
    try { return Router.rows(await this.get('/lan_port_status.asp')).filter(r => r.length >= 2 && /LAN/i.test(r[0])).map(r => ({ port: r[0], status: r.slice(1).join(' ') })); }
    catch { return []; }
  }

  async wifiInfo(idx) {
    const html = await this.get(`/boaform/formWlanRedirect?redirect-url=/admin/wlbasic.asp&wlan_idx=${idx}`);
    const f = F.findForm(html, x => /formWlanSetup/i.test(x.getAttribute('action') || ''));
    const get = n => f.controls.find(c => c.name === n);
    return {
      idx, band: idx === 0 ? '5 GHz' : '2.4 GHz',
      enabled: !(get('wlanDisabled') && get('wlanDisabled').checked),
      ssid: get('ssid') ? get('ssid').value : '',
      channel: get('chan') ? (get('chan').options[get('chan').selectedIndex] || {}).text : '',
    };
  }

  // Generic table reader for the "Current ... Table" sections (parental control,
  // port forwarding, URL blocking). Returns rows + the select control for each.
  static tableWithSelects(html, formPred) {
    const f = F.findForm(html, formPred);
    const out = [];
    let headers = null;
    for (const tr of f.el.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll('td,th');
      const texts = cells.map(c => c.text.replace(/\s+/g, ' ').trim());
      const sel = tr.querySelector('input[type=checkbox],input[type=radio]');
      if (!sel && !headers && texts.some(Boolean)) { headers = texts; continue; }
      if (!sel) continue;
      out.push({ cells: texts, select: { name: sel.getAttribute('name'), value: sel.getAttribute('value') || 'on' } });
    }
    return { headers: headers || [], rows: out };
  }

  async parental() {
    const html = await this.get('/parental-ctrl.asp');
    const on = F.findForm(html, x => /formParentCtrl/i.test(x.getAttribute('action') || '') && /parental_ctrl_on/.test(x.toString()));
    const enabled = on.controls.some(c => c.name === 'parental_ctrl_on' && c.checked && c.value !== '0');
    const t = Router.tableWithSelects(html, x => /deleteSelFilterMac/.test(x.toString()));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const rules = t.rows.map(r => {
      const h = t.headers; const g = n => r.cells[h.indexOf(n)];
      return {
        name: g('Name'), mac: (g('MAC Address') || '').toLowerCase(),
        days: days.filter(d => /v|✓|yes|1|x/i.test(g(d) || '')),
        start: g('Start'), end: g('End'), select: r.select, cells: r.cells,
      };
    });
    return { enabled, rules };
  }

  async portForwards() {
    const html = await this.get('/fw-portfw.asp');
    const add = F.findForm(html, x => /formPortFw/i.test(x.getAttribute('action') || '') && /portFwcap/.test(x.toString()));
    const enabled = add.controls.some(c => c.name === 'portFwcap' && c.checked && c.value !== '0');
    const t = Router.tableWithSelects(html, x => /deleteSelPortFw/.test(x.toString()));
    const h = t.headers;
    const rules = t.rows.map(r => {
      const g = n => r.cells[h.indexOf(n)];
      return { comment: g('Comment'), localIp: g('Local IP Address'), protocol: g('Protocol'), localPort: g('Local Port'),
        enabled: g('Enable'), remoteHost: g('Remote Host'), publicPort: g('Public Port'), iface: g('Interface'), select: r.select };
    });
    const protoSel = add.controls.find(c => c.name === 'protocol[]');
    return { enabled, rules, protocols: protoSel ? protoSel.options.map(o => o.text) : ['TCP', 'UDP', 'Both'] };
  }

  async urlBlocks() {
    const html = await this.get('/url_blocking.asp');
    const f = F.findForm(html, x => /formURL/i.test(x.getAttribute('action') || ''));
    const enabled = f.controls.some(c => c.name === 'urlcap' && c.checked && c.value !== '0');
    const domains = [], keywords = [];
    for (const tr of f.el.querySelectorAll('tr')) {
      const sel = tr.querySelector('input[type=checkbox],input[type=radio]');
      if (!sel) continue;
      const txt = tr.querySelectorAll('td').map(td => td.text.trim()).filter(Boolean).join(' ');
      const item = { text: txt, select: { name: sel.getAttribute('name'), value: sel.getAttribute('value') || 'on' } };
      (/^(fqdn|sel_fqdn|select_fqdn|fqdn\d)/i.test(item.select.name) || /fqdn/i.test(item.select.name) ? domains : (/key/i.test(item.select.name) ? keywords : domains)).push(item);
    }
    return { enabled, domains, keywords };
  }

  // The QoS pages fill their tables from script data such as
  //   traffictlRules.push(new it_nr("0", new it("id",1), new it("srcip","192.168.1.5"), ...));
  // Run just that data block in a sandbox with stand-ins for it/it_nr.
  static scriptArray(html, arrayName) {
    const vm = require('vm');
    const scripts = parse(html).querySelectorAll('script').filter(s => !s.getAttribute('src')).map(s => s.text).join('\n');
    const start = scripts.indexOf(arrayName + ' = new Array');
    if (start < 0) return [];
    const fn = scripts.indexOf('function ', start);
    const block = scripts.slice(start, fn > start ? fn : undefined);
    function it(k, v) { this.key = k; this.value = v; }
    function it_nr(name, ...items) { this.__name = name; for (const i of items) if (i && i.key !== undefined) this[i.key] = i.value; }
    it_nr.prototype.add = function (i) { if (i && i.key !== undefined) this[i.key] = i.value; };
    const ctx = { it, it_nr, Array, document: {}, window: {} };
    ctx[arrayName] = [];
    try { vm.runInNewContext(block.replace(new RegExp('^' + arrayName + ' = new Array\\(\\);?'), ''), ctx, { timeout: 500 }); }
    catch { /* keep whatever was pushed before an unsupported statement */ }
    return Array.from(ctx[arrayName]).map(o => ({ ...o }));
  }

  // MAC-based IP assignment (DHCP reservation)
  async reservations() {
    const html = await this.get('/macIptbl.asp');
    const t = Router.tableWithSelects(html, 0);
    return t.rows.map(r => {
      const mac = (r.cells.find(c => /^([0-9a-f]{2}[-:]){5}[0-9a-f]{2}$/i.test(c)) || '').toLowerCase().replace(/-/g, ':');
      const ip = r.cells.find(c => /^\d+\.\d+\.\d+\.\d+$/.test(c)) || '';
      return { mac, ip, enabled: !/disable/i.test(r.cells.join(' ')), select: r.select };
    }).filter(r => r.mac);
  }
  async addReservation(mac, ip) {
    const m = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (m.length !== 12) throw new Error('MAC address must have 12 hex digits');
    if (!/^192\.168\.1\.(\d{1,3})$/.test(ip) || +ip.split('.')[3] < 2 || +ip.split('.')[3] > 254) throw new Error('Pick an address from 192.168.1.2 to 192.168.1.254');
    return this.submit('/macIptbl.asp', 0, { enable: true, hostMac: m.match(/../g).join('-'), hostIp: ip }, 'addIP');
  }
  async deleteReservations(selects) {
    return this.deleteRows('/macIptbl.asp', 'macBase', 'delIP', selects);
  }

  // IP QoS on/off (traffic shaping only works while it is on)
  async qos() {
    const html = await this.get('/net_qos_imq_policy.asp');
    const m = /qosEnable\s*=\s*(\d)/.exec(html);
    return { enabled: m ? m[1] === '1' : false };
  }
  async setQos(enabled) {
    const html = await this.get('/net_qos_imq_policy.asp');
    const bw = [...html.matchAll(/totalBandwidth\s*=\s*(\d+)/g)].pop();
    const userBw = /userDefinedBandwidth\s*=\s*(\d)/.exec(html);
    return this.submit('/net_qos_imq_policy.asp', 0, {
      qosen: enabled ? '1' : '0', queuepolicy: 'prio', bandwidth_defined: userBw ? userBw[1] : '0',
      totalbandwidth: bw ? bw[1] : '100000', lst: 'policy=0',
    }, null);
  }

  // Traffic shaping rules: one per device and direction, rate in kb/s.
  async shapingRules() {
    const html = await this.get('/net_qos_traffictl.asp');
    return Router.scriptArray(html, 'traffictlRules').map(r => ({
      id: String(r.id), direction: String(r.direction) === '1' ? 'down' : 'up',
      srcip: r.srcip && r.srcip !== '0.0.0.0' ? r.srcip : '', dstip: r.dstip && r.dstip !== '0.0.0.0' ? r.dstip : '',
      rate: Number(r.rate) || 0, raw: r,
    })).map(r => ({ ...r, ip: r.direction === 'down' ? (r.dstip || r.srcip) : (r.srcip || r.dstip) }));
  }
  async addShapingRule({ ip, direction, kbps }) {
    if (!/^192\.168\.1\.\d+$/.test(ip)) throw new Error('Bad device IP');
    const rate = Math.max(64, Math.round(kbps));
    const page = await this.get('/net_qos_traffictl_edit.asp');
    const inflist = parse(page).querySelector('#inflist option');
    const inf = inflist ? inflist.getAttribute('value') : '65536';
    const down = direction === 'down';
    // Device is the destination for downloads and the source for uploads.
    const f = { srcip: down ? '' : ip, srcnetmask: down ? '' : '255.255.255.255', dstip: down ? ip : '', dstnetmask: down ? '255.255.255.255' : '' };
    const lst = Buffer.from(`dummy=dummy&inf=${inf}&proto=0&IPversion=1&srcip=${f.srcip}&srcnetmask=${f.srcnetmask}&dstip=${f.dstip}&dstnetmask=${f.dstnetmask}&sport=&dport=&rate=${rate}&direction=${down ? 1 : 0}`, 'latin1').toString('base64');
    return this.submit('/net_qos_traffictl_edit.asp', 0, {
      IpProtocolType: '1', direction: down ? '1' : '0', protolist: '0', ...f, sport: '', dport: '', rate: String(rate), lst,
    }, null);
  }
  async deleteShapingRules(ids) {
    if (!ids.length) return;
    return this.submit('/net_qos_traffictl.asp', 0, { lst: 'applysetting#id=' + ids.join('|') }, null);
  }

  // ---------- writes ----------

  async setWifi(idx, enabled) {
    const page = `/boaform/formWlanRedirect?redirect-url=/admin/wlbasic.asp&wlan_idx=${idx}`;
    return this.submit(page, x => /formWlanSetup/i.test(x.getAttribute('action') || ''), { wlanDisabled: !enabled }, 'save', (controls) => {
      const get = n => controls.find(c => c.name === n);
      // Mirrors wlbasic.asp: updateIputState() sets the checkbox value to "ON"
      // when ticked, and disableWLAN() greys out these fields.
      const dis = get('wlanDisabled'); if (dis) dis.value = enabled ? 'OFF' : 'ON';
      const greyed = ['band', 'mode', 'ssid', 'chanwid', 'ctlband', 'chan', 'txpower', 'regdomain_demo', 'ssidpri'];
      for (const c of controls) if (greyed.includes(c.name)) c.disabled = !enabled;
      const rep = get('repeaterEnabled'), repS = get('repeaterSSID');
      if (rep && repS && !rep.checked) repS.disabled = true;
      if (enabled) {
        // saveChanges(): recompute basic/operational rate masks from the band.
        const bandSel = get('band');
        const band = parseInt(bandSel.value, 10) + 1;
        const opt = bandSel.options[bandSel.selectedIndex] || { text: '' };
        const b2g5g = opt.text.trim().charAt(0) === '2' ? 1 : 2;
        let basic = 0, oper = 0;
        if (band & 1) { basic |= 0xf; oper |= 0xf; }
        if (band & 2) { oper |= 0xff0; if (!(band & 1)) basic = 0xf; }
        if (band & 4) { oper |= 0xff0; basic = 0x1f0; }
        if (band & 8) {
          if (!(band & 3)) oper |= 0xff0;
          if ((band & 1) || (band & 2)) basic = 0xf; else if (band & 4) basic = 0x1f0; else basic = b2g5g === 1 ? 0xf : 0x1f0;
        }
        if ((band & 64) || (band & 128)) { basic = b2g5g === 1 ? 0xf : 0x1f0; oper |= 0xff0; }
        oper |= basic;
        const br = get('basicrates'), or = get('operrates');
        if (br) br.value = String(basic); if (or) or.value = String(oper);
      }
    });
  }

  async setParental(enabled) {
    return this.submit('/parental-ctrl.asp', x => /parentalCtrlSet/.test(x.toString()), { parental_ctrl_on: enabled ? '1' : '0' }, 'parentalCtrlSet', (controls) => {
      // value could be 1/0 or on/off depending on firmware; pick by position
      const radios = controls.filter(c => c.name === 'parental_ctrl_on');
      if (radios.length === 2) { radios[0].checked = !enabled; radios[1].checked = enabled; }
    });
  }

  async addParental({ name, mac, days, start, end }) {
    const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) throw new Error('MAC address must have 12 hex digits');
    const [sh, sm] = start.split(':'); const [eh, em] = end.split(':');
    const vals = { usrname: name.slice(0, 31), mac: hex, starthr: String(+sh), startmin: sm.padStart(2, '0'), endhr: String(+eh), endmin: em.padStart(2, '0') };
    for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) vals[d] = days.includes(d);
    return this.submit('/parental-ctrl.asp', x => /addfilterMac/.test(x.toString()), vals, 'addfilterMac', (controls) => {
      // "specPC" (specific PC by MAC) radio exists on some builds — select MAC mode.
      const sp = controls.filter(c => c.name === 'specPC');
      if (sp.length > 1) sp.forEach((c, i) => { c.checked = i === 1; });
    });
  }

  async deleteRows(pagePath, formMarker, deleteBtn, selects) {
    return this.submit(pagePath, x => x.toString().includes(formMarker), {}, deleteBtn, (controls) => {
      const want = new Set(selects.map(s => s.name + '\u0000' + s.value));
      for (const c of controls) if ((c.type === 'checkbox' || c.type === 'radio') && want.has(c.name + '\u0000' + c.value)) c.checked = true;
    });
  }

  async addPortForward({ comment, localIp, localPort, publicPort, protocol }) {
    const [lf, lt] = String(localPort).split('-'); const [pf, pt] = String(publicPort || localPort).split('-');
    return this.submit('/fw-portfw.asp', x => /portFwcap/.test(x.toString()), {
      'comment[]': [comment || ''], 'localIPaddr[]': [localIp], 'localFromPort[]': [lf], 'localToPort[]': [lt || lf],
      'protocol[]': [protocol || 'TCP'], 'remoteFromPort[]': [pf], 'remoteToPort[]': [pt || pf],
    }, null, (controls) => {
      // Turn the feature on, tick the first row's enable box.
      const cap = controls.filter(c => c.name === 'portFwcap'); if (cap.length === 2) { cap[0].checked = false; cap[1].checked = true; }
      const en = controls.find(c => c.name === 'fw_enable'); if (en) en.checked = true;
      const btn = controls.find(c => c.type === 'submit' && /add/i.test(c.name + c.value + c.onclick)) || controls.find(c => c.type === 'submit');
      controls.__click = btn && btn.name;
    });
  }

  async setUrlBlocking(enabled) {
    return this.submit('/url_blocking.asp', x => /formURL/i.test(x.getAttribute('action') || ''), {}, 'apply', (c) => {
      const r = c.filter(x => x.name === 'urlcap'); if (r.length === 2) { r[0].checked = !enabled; r[1].checked = enabled; }
    });
  }
  async addUrlBlock(domain) {
    return this.submit('/url_blocking.asp', x => /formURL/i.test(x.getAttribute('action') || ''), { urlFQDN: domain }, 'addFQDN');
  }
  async addKeywordBlock(word) {
    return this.submit('/url_blocking.asp', x => /formURL/i.test(x.getAttribute('action') || ''), { Keywd: word }, 'addKeywd');
  }

  async reboot() {
    return this.run(async () => {
      if (!this.loggedIn) await this.login();
      const page = await this.raw('GET', '/reboot.asp');
      const f = F.findForm(page.text, x => /formReboot/i.test(x.getAttribute('action') || ''));
      const { body } = F.serialize(f.controls, null);
      this.loggedIn = false;
      try { await this.raw('POST', f.action, body); } catch { /* router drops connection while rebooting */ }
      return { ok: true };
    });
  }
}

module.exports = { Router };
