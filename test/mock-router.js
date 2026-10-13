// Fake Camnex CNP4000A web UI for tests. Shaped from the real router's pages
// (field names, form actions, checksum check). Login: admin / secret!pw
const https = require('https'); const fs = require('fs');
const F = require('../lib/form');
const dir = process.env.MOCK_CERT_DIR || __dirname;
let session = false; const log = [];
let wlan = [{ disabled: false, ssid: 'AKASH 5G' }, { disabled: false, ssid: 'AKASH' }]; let curIdx = 1;
let parental = { on: false, rules: [] }, pf = { on: false, rules: [] }, url = { on: false, fqdn: [], kw: [] };
const page = b => `<html><body>${b}</body></html>`;
const flagOk = (body) => {
  const i = body.lastIndexOf('postSecurityFlag='); const inputVal = body.slice(0, i); const flag = +body.slice(i + 17);
  return F.checksum(inputVal) === flag;
};
const parse = b => { const o={}; for (const kv of b.split('&').filter(Boolean)) { const [k,v]=kv.split('=').map(x => decodeURIComponent(x.replace(/\+/g, ' '))); if (!(k in o)) o[k]=v; } return o; };
const multi = (b, n) => b.split('&').filter(kv => kv.startsWith(encodeURIComponent(n).replace(/%5B/g,'%5B') + '=') || kv.startsWith(n.replace('[','%5B').replace(']','%5D') + '=')).map(kv => decodeURIComponent(kv.split('=')[1].replace(/\+/g,' ')));
const wlanPage = () => { const w = wlan[curIdx]; return page(`<form name="wlanSetup" action="/boaform/admin/formWlanSetup" method="POST">
 <input type="checkbox" name="wlanDisabled" value="OFF" ${w.disabled?'checked':''} onclick="updateState(document.wlanSetup)">
 <input type="checkbox" name="wlan6gSupport"><select name="band"><option value="0">2.4 GHz (B+G+N)</option><option value="75" selected>5 GHz (A+N+AC)</option></select>
 <select name="mode"><option value="0" selected>AP</option></select><input type="text" name="ssid" value="${w.ssid}">
 <select name="chan"><option value="0" selected>Auto</option><option value="44">44</option></select>
 <input type="hidden" name="submit-url" value="/admin/wlbasic.asp"><input type="submit" name="save" value="Apply Changes" onclick="return saveChanges(this)">
 <input type="hidden" name="basicrates" value="15"><input type="hidden" name="operrates" value="4095"><input type="hidden" name="wlan_idx" value="${curIdx}"><input type="hidden" name="postSecurityFlag" value=""></form>`); };
const pcPage = () => page(`<form action="/boaform/admin/formParentCtrl" method="POST" name="formParentCtrl"><input type="radio" name="parental_ctrl_on" value="0" ${parental.on?'':'checked'}>Disable<input type="radio" name="parental_ctrl_on" value="1" ${parental.on?'checked':''}>Enable<input type="submit" name="parentalCtrlSet" value="Apply Changes"><input type="hidden" name="submit-url" value="/parental-ctrl.asp"><input type="hidden" name="postSecurityFlag"></form>
<form action="/boaform/admin/formParentCtrl" method="POST" name="formParentCtrlAdd"><input name="usrname"><input name="mac">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<input type="checkbox" name="${d}">`).join('')}<input name="starthr"><input name="startmin"><input name="endhr"><input name="endmin"><input type="submit" name="addfilterMac" value="Add"><input type="hidden" name="submit-url" value="/parental-ctrl.asp"><input type="hidden" name="postSecurityFlag"></form>
<form action="/boaform/admin/formParentCtrl" method="POST" name="formParentCtrlDel"><table><tr><td>Name</td><td>MAC Address</td><td>Sun</td><td>Mon</td><td>Tue</td><td>Wed</td><td>Thu</td><td>Fri</td><td>Sat</td><td>Start</td><td>End</td><td>Select</td></tr>
${parental.rules.map((r,i)=>`<tr><td>${r.name}</td><td>${r.mac}</td>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<td>${r.days.includes(d)?'V':''}</td>`).join('')}<td>${r.s}</td><td>${r.e}</td><td><input type="checkbox" name="select${i}" value="ON"></td></tr>`).join('')}</table>
<input type="submit" name="deleteSelFilterMac" value="Delete Selected"><input type="submit" name="deleteAllFilterMac" value="Delete All"><input type="hidden" name="submit-url" value="/parental-ctrl.asp"><input type="hidden" name="postSecurityFlag"></form>`);
const pfPage = () => page(`<form action="/boaform/formPortFw" method="POST" name="formPortFwAdd"><input type="radio" name="portFwcap" value="0" ${pf.on?'':'checked'}>Disable<input type="radio" name="portFwcap" value="1" ${pf.on?'checked':''}>Enable<input type="submit" name="apply" value="Apply Changes" onclick="return on_submit(this)">
<input type="checkbox" name="fw_enable"><select name="app"><option>Active Worlds</option></select>
${[0,1,2].map(()=>`<input name="comment[]"><input name="localIPaddr[]"><input name="localFromPort[]"><input name="localToPort[]"><select name="protocol[]"><option value="1">TCP</option><option value="2">UDP</option><option value="3">Both</option></select><input name="remoteIPaddr[]"><input name="remoteFromPort[]"><input name="remoteToPort[]"><select name="interface[]"><option value="65535">Any</option></select><input type="hidden" name="select_id[]">`).join('')}
<input type="submit" name="addPortFw" value="Add" onclick="return addClick(this)"><input type="hidden" name="submit-url" value="/fw-portfw.asp"><input type="hidden" name="postSecurityFlag"></form>
<form action="/boaform/formPortFw" method="POST" name="formPortFwDel"><table><tr><th>Select</th><th>Comment</th><th>Local IP Address</th><th>Protocol</th><th>Local Port</th><th>Enable</th><th>Remote Host</th><th>Public Port</th><th>Interface</th></tr>
${pf.rules.map((r,i)=>`<tr><td><input type="checkbox" name="select${i}" value="ON"></td><td>${r.c}</td><td>${r.ip}</td><td>${r.p}</td><td>${r.lp}</td><td>Enable</td><td></td><td>${r.pp}</td><td>Any</td></tr>`).join('')}</table>
<input type="submit" name="deleteSelPortFw" value="Delete Selected"><input type="submit" name="deleteAllPortFw" value="Delete All"><input type="hidden" name="submit-url" value="/fw-portfw.asp"><input type="hidden" name="postSecurityFlag"></form>`);
const urlPage = () => page(`<form action="/boaform/formURL" method="POST" name="url"><input type="radio" name="urlcap" value="0" ${url.on?'':'checked'}><input type="radio" name="urlcap" value="1" ${url.on?'checked':''}><input type="submit" name="apply" value="Apply Changes">
<input name="urlFQDN"><input type="submit" name="addFQDN" value="Add"><input type="submit" name="delFQDN" value="Delete Selected"><input type="submit" name="delFAllQDN" value="Delete All">
<table>${url.fqdn.map((f,i)=>`<tr><td><input type="checkbox" name="select${i}" value="ON"></td><td>${f}</td></tr>`).join('')}</table>
<input name="Keywd"><input type="submit" name="addKeywd" value="Add"><input type="submit" name="delKeywd" value="Delete Selected"><input type="submit" name="delAllKeywd" value="Delete All">
<table>${url.kw.map((f,i)=>`<tr><td><input type="checkbox" name="selectkey${i}" value="ON"></td><td>${f}</td></tr>`).join('')}</table>
<input type="hidden" name="submit-url" value="/url_blocking.asp"><input type="hidden" name="postSecurityFlag"></form>`);

let resv = [], qosOn = 0, tc = [], tcId = 1;
const macPage = () => page(`<form action="/boaform/formmacBase" method="POST" name="macBase"><input type="hidden" name="lan_ip" value="192.168.1.1"><input type="checkbox" name="enable" checked><input name="hostMac"><input name="hostIp"><input type="submit" name="addIP" value="Assign IP"><input type="submit" name="delIP" value="Delete Assigned IP"><input type="submit" name="modIP" value="Modify IP"><input type="hidden" name="submit-url" value="/macIptbl.asp">
<table><tr><td>Select</td><td>Enable</td><td>MAC Address</td><td>Assigned IP Address</td></tr>${resv.map((r,i)=>`<tr><td><input type="radio" name="select" value="s${i}"></td><td>Enable</td><td>${r.mac}</td><td>${r.ip}</td></tr>`).join('')}</table><input type="hidden" name="postSecurityFlag"></form>`);
const qosPage = () => page(`<form action="/boaform/admin/formQosPolicy" method="POST"><input type="radio" name="qosen" value="0"><input type="radio" name="qosen" value="1"><input type="radio" name="queuepolicy" value="prio"><input type="radio" name="queuepolicy" value="wrr"><input type="radio" name="bandwidth_defined" value="0"><input type="radio" name="bandwidth_defined" value="1"><input name="totalbandwidth" value="1005"><input type="hidden" name="lst"><input type="hidden" name="submit-url" value="/net_qos_imq_policy.asp"><input type="hidden" name="postSecurityFlag"></form><script>var rules = new Array(); userDefinedBandwidth = 0; totalBandwidth = 100000; qosEnable = ${qosOn}; policy = 0;</script>`);
const tcPage = () => page(`<form action="/boaform/admin/formQosTraffictl" method="POST"><input type="hidden" name="lst"><input type="hidden" name="submit-url" value="/net_qos_traffictl.asp"><input type="hidden" name="postSecurityFlag"></form><script>var protos = new Array(); var traffictlRules = new Array(); totalBandwidth = 100000;
${tc.map(r=>`traffictlRules.push(new it_nr("${r.id}", new it("id", ${r.id}), new it("inf", "ppp0"), new it("proto", 0), new it("sport", "0"), new it("dport", "0"), new it("IpProtocolType", "1 "), new it("srcip", "${r.srcip||'0.0.0.0'}"), new it("dstip", "${r.dstip||'0.0.0.0'}"), new it("rate", ${r.rate}), new it("direction", ${r.direction})));`).join('\n')}
function on_chkdel(index) {}</script>`);
const tcEdit = () => page(`<form action="/boaform/admin/formQosTraffictlEdit" method="POST"><select name="IpProtocolType"><option value="1">IPv4</option><option value="2">IPv6</option></select><select name="direction"><option value="0">Upstream</option><option value="1">Downstream</option></select><input name="vlanID"><select name="ssid"></select><select name="protolist"><option value="0">NONE</option><option value="1">TCP</option></select><input name="srcip"><input name="srcnetmask"><input name="dstip"><input name="dstnetmask"><input name="sip6"><input name="sip6PrefixLen"><input name="dip6"><input name="dip6PrefixLen"><input name="sport"><input name="dport"><input name="rate"><select id="inflist"><option value="65536">ppp0_nas0_0</option></select><input type="button" name="return" value="Close"><input type="button" name="apply" value="Apply Changes"><input type="hidden" name="lst"><input type="hidden" name="submit-url" value="/net_qos_traffictl.asp"><input type="hidden" name="postSecurityFlag"></form>`);

let tx = 3091476336, rx = 54103703;
const loginPage = page(`<form action="/boaform/admin/formLogin" method="post" name="cmlogin"><input type="hidden" name="challenge"><input type="text" name="username"><input type="password" name="password"><input type="submit" name="save" value="Login" onclick="setpass(this)"><input type="hidden" name="encodePassword"><input type="hidden" name="submit-url" value="/admin/login.asp"><input type="hidden" name="postSecurityFlag"></form>`);
https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const u = new URL(req.url, 'https://x'); const p = u.pathname;
    const out = (s, code = 200, h = {}) => { res.writeHead(code, { 'Content-Type': 'text/html', ...h }); res.end(s); };
    if (p === '/admin/login.asp') return out(loginPage);
    if (req.method === 'POST') { const ok = flagOk(b); log.push({ p, ok, b: b.replace(/encodePassword=[^&]+/, 'encodePassword=***') }); fs.writeFileSync(dir+'/posts.json', JSON.stringify(log,null,1)); if (!ok) return out(page('<b>ERROR: bad security flag</b>')); }
    if (p === '/boaform/admin/formLogin') { const f = parse(b); session = f.username === 'admin' && Buffer.from(f.encodePassword, 'base64').toString() === 'secret!pw' && !('password' in f); return out('', 302, { Location: session ? '/' : '/admin/login.asp' }); }
    if (!session) return out(loginPage);
    if (p === '/__log') return out(JSON.stringify({ log, wlan, parental, pf, url, resv, qosOn, tc }, null, 1));
    if (p === '/status.asp') return out(page(`<table><tr><td>Device Name</td><td>CNP4000A</td></tr><tr><td>Uptime</td><td>23 days, 13:46</td></tr><tr><td>Firmware Version</td><td>GTPL_V4.0.1-260626</td></tr><tr><td>CPU Usage</td><td>10%</td></tr><tr><td>Memory Usage</td><td>47%</td></tr><tr><td>Name Servers</td><td>182.237.9.10, 8.8.8.8</td></tr><tr><td>IP Address</td><td>192.168.1.1</td></tr><tr><td>DHCP Server</td><td>Enabled</td></tr><tr><td>MAC Address</td><td>f4979d62c817</td></tr>
<tr><td>Interface</td><td>VLAN ID</td><td>Connection Type</td><td>Protocol</td><td>IP Address</td><td>Gateway</td><td>Status</td></tr><tr><td>ppp0_nas0_0</td><td>1380</td><td>INTERNET_TR069</td><td>PPPoE</td><td>10.130.213.154</td><td>10.130.192.1</td><td>up
 22days,22:07:00 / 22days,22:07:00</td></tr></table>`));
    if (p === '/wlstatbl.asp') { tx += 2_500_000; rx += 300_000; const i = u.searchParams.get('wlan_idx');
      const H = '<tr><td>MAC Address</td><td>Tx Rate (Mbps)</td><td>Rx Rate (Mbps)</td><td>Tx Packets</td><td>Rx Packets</td><td>TXBYTES</td><td>RXBYTES</td><td>RSSI</td><td>SNR</td><td>Channel</td><td>MCS_INDEX(Tx)</td><td>MCS_INDEX(Rx)</td><td>Antenna_type</td><td>Uptime</td><td>Power Saving</td><td>Expired Time (sec)</td></tr>';
      const r = (m, a, b2, rs, ch, up) => `<tr><td>${m}</td><td>780</td><td>24</td><td>1</td><td>1</td><td>${a}</td><td>${b2}</td><td>${rs}</td><td>36</td><td>${ch}</td><td>x</td><td>x</td><td>2x2</td><td>${up}</td><td>yes</td><td>300</td></tr>`;
      return out(page('<table>' + H + (i === '0' ? r('82:3d:a2:47:5b:f8', tx, rx, -55, 44, 40113) + r('12:ff:05:f5:c6:c1', 204365413, 37663809, -48, 44, 1877) : (wlan[1].disabled ? '' : r('86:9f:60:45:2e:78', 145378, 883788, -58, 11, 280))) + '</table>')); }
    if (p === '/dhcptbl.asp') return out(page('<table><tr><td>IP Address</td><td>MAC Address</td><td>Expired Time (sec)</td></tr><tr><td>192.168.1.2</td><td>82:3d:a2:47:5b:f8</td><td>46287</td></tr><tr><td>192.168.1.3</td><td>12:ff:05:f5:c6:c1</td><td>84523</td></tr><tr><td>192.168.1.7</td><td>86:9f:60:45:2e:78</td><td>86121</td></tr></table>'));
    if (p === '/arptable.asp') return out(page('<table><tr><td>IP Address</td><td>MAC Address</td></tr><tr><td>192.168.1.7</td><td>86-9f-60-45-2e-78</td></tr><tr><td>192.168.1.6</td><td>4e-e5-7b-ce-85-93</td></tr></table>'));
    if (p === '/boaform/formWlanRedirect') { curIdx = +u.searchParams.get('wlan_idx'); return out(wlanPage()); }
    if (p === '/boaform/admin/formWlanSetup') { const f = parse(b); wlan[curIdx].disabled = f.wlanDisabled === 'ON'; return out(wlanPage()); }
    if (p === '/parental-ctrl.asp') return out(pcPage());
    if (p === '/boaform/admin/formParentCtrl') { const f = parse(b);
      if ('parentalCtrlSet' in f) parental.on = f.parental_ctrl_on === '1';
      if ('addfilterMac' in f) parental.rules.push({ name: f.usrname, mac: f.mac, days: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].filter(d => f[d] === 'on'), s: f.starthr + ':' + f.startmin, e: f.endhr + ':' + f.endmin });
      if ('deleteSelFilterMac' in f) parental.rules = parental.rules.filter((r, i) => !f['select' + i]);
      return out(pcPage()); }
    if (p === '/fw-portfw.asp') return out(pfPage());
    if (p === '/boaform/formPortFw') { const f = parse(b);
      if ('addPortFw' in f) { pf.on = f.portFwcap === '1'; pf.rules.push({ c: f['comment[]'], ip: f['localIPaddr[]'], p: { 1: 'TCP', 2: 'UDP', 3: 'Both' }[f['protocol[]']], lp: f['localFromPort[]'], pp: f['remoteFromPort[]'] }); }
      if ('deleteSelPortFw' in f) pf.rules = pf.rules.filter((r, i) => !f['select' + i]);
      return out(pfPage()); }
    if (p === '/url_blocking.asp') return out(urlPage());
    if (p === '/boaform/formURL') { const f = parse(b);
      if ('apply' in f) url.on = f.urlcap === '1'; if ('addFQDN' in f) url.fqdn.push(f.urlFQDN); if ('addKeywd' in f) url.kw.push(f.Keywd);
      if ('delFQDN' in f) url.fqdn = url.fqdn.filter((x, i) => !f['select' + i]); if ('delKeywd' in f) url.kw = url.kw.filter((x, i) => !f['selectkey' + i]);
      return out(urlPage()); }

    if (p === '/macIptbl.asp') return out(macPage());
    if (p === '/boaform/formmacBase') { const f = parse(b); if ('addIP' in f) resv.push({ mac: f.hostMac, ip: f.hostIp }); if ('delIP' in f && f.select) resv.splice(+f.select.slice(1), 1); return out(macPage()); }
    if (p === '/net_qos_imq_policy.asp') return out(qosPage());
    if (p === '/boaform/admin/formQosPolicy') { const f = parse(b); qosOn = f.qosen === '1' ? 1 : 0; return out(qosPage()); }
    if (p === '/net_qos_traffictl.asp') return out(tcPage());
    if (p === '/net_qos_traffictl_edit.asp') return out(tcEdit());
    if (p === '/boaform/admin/formQosTraffictlEdit') { const f = parse(b); const l = Object.fromEntries(Buffer.from(f.lst, 'base64').toString().split('&').map(x => x.split('='))); tc.push({ id: tcId++, srcip: l.srcip, dstip: l.dstip, rate: +l.rate, direction: +l.direction }); return out(tcPage()); }
    if (p === '/boaform/admin/formQosTraffictl') { const f = parse(b); const ids = (f.lst.split('id=')[1] || '').split('|').map(Number); tc = tc.filter(r => !ids.includes(r.id)); return out(tcPage()); }
    if (p === '/reboot.asp') return out(page('<form action="/boaform/admin/formReboot" method="POST"><input type="submit" value="Commit and Reboot" onclick="return saveClick()"><input type="hidden" name="postSecurityFlag"></form>'));
    if (p === '/boaform/admin/formReboot') { session = false; return out('rebooting'); }
    out('nf', 404);
  });
}).listen(Number(process.env.MOCK_PORT || 8443), '127.0.0.1', () => console.log('mock up'));
