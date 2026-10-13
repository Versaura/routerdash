#!/usr/bin/env node
// Does RouterDash support my router? Read-only: it looks at the login page and
// a few public files, and never logs in or changes anything.
//   npm run check                 (uses 192.168.1.1)
//   npm run check -- 192.168.0.1
'use strict';
const { Router } = require('../lib/router');

const host = process.argv[2] || '192.168.1.1';
const r = new Router({ host, username: '', password: '' });
const ok = (b, msg) => console.log(`  ${b ? '✓' : '✗'} ${msg}`);

(async () => {
  console.log(`\nChecking ${host} …\n`);
  let login;
  try { login = await r.raw('GET', '/admin/login.asp'); }
  catch (e) { ok(false, `No HTTPS admin page (${e.message}). RouterDash needs https://${host}/admin/login.asp`); return done(-1); }

  const html = login.text;
  const checks = [
    [login.status < 400 && /<form/i.test(html), 'Admin login page at /admin/login.asp'],
    [/boaform\/admin\/formLogin/i.test(html), 'Realtek "boaform" login form'],
    [/postSecurityFlag/.test(html), 'Form checksum field (postSecurityFlag)'],
    [/encodePassword|encode64|base64/i.test(html), 'Base64 password encoding'],
  ];
  const common = await r.raw('GET', '/common.js').catch(() => null);
  checks.push([!!common && /postTableEncrypt/.test(common.text), 'postTableEncrypt() in common.js']);
  const menu = await r.raw('GET', '/adminMenu.js').catch(() => null);
  const pages = menu ? ['wlstatbl', 'parental-ctrl', 'macIptbl', 'net_qos_traffictl', 'fw-portfw', 'url_blocking'].filter(p => menu.text.includes(p + '.asp')) : [];
  for (const [b, m] of checks) ok(b, m);
  if (menu && menu.status < 400) ok(pages.length >= 4, `Feature pages in the menu: ${pages.join(', ') || 'none found (menu may need a login)'}`);

  const core = checks.filter(c => c[0]).length;
  done(core);
})();

function done(core) {
  console.log('');
  if (core < 0) console.log(`Couldn't reach a web admin page. Check you're on the router's Wi-Fi, that the address is right\n(find it with: route -n get default | grep gateway), and open https://${host} in a browser once.\n`);
  else if (core >= 5) console.log('Looks compatible. Run `npm start` and log in.\n');
  else if (core >= 3) console.log('Partly compatible. Login and reading should work; some controls may need adjusting.\nOpen an issue with this output and your router model.\n');
  else console.log("Not a match. This router uses a different web interface.\nOpen an issue with your router's brand and model and we'll look at adding it.\n");
}
