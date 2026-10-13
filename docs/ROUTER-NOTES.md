# Router notes: Realtek boa admin interface

Verified device: **Camnex CNP4000A (GTPL)**. Other Realtek ONTs with the same admin UI usually share these pages; differences go in a new section at the end.

What we learned from the real device, firmware `GTPL_V4.0.1-260626`, on 2026-10-13. Treat this as the source of truth for field names. Re-check it against the live router after a firmware update.

## Basics

| | |
|---|---|
| Admin URL | `https://192.168.1.1/admin/login.asp`. HTTPS only (443): port 80 refuses connections. The certificate is self-signed |
| Web server | Realtek `boa`. Replies are sloppy (bad lengths, junk after the body), so use `Router.raw()` |
| Session | Tied to the client IP; no cookies. One admin at a time |
| Menu | `/adminMenu.js` lists every page (about 70) |
| WAN | PPPoE on VLAN 1380, `ppp0_nas0_0`. WAN IP is `10.130.x.x`, which is **CGNAT**, so inbound port forwards can't work |
| Radios | `wlan_idx=0` is 5 GHz, `wlan_idx=1` is 2.4 GHz |

## Checksum (`postSecurityFlag`)

`common.js → postTableEncrypt(postobj, formobj)`:

1. Walk `form.elements` in order and skip `postSecurityFlag`, `csrftoken`, disabled elements, and buttons. The exception is the clicked button, which the page marks `obj.isclick = 1`.
2. Append `name=value&` for each one. Names get only `[`→`%5B` and `]`→`%5D`. Values get `encodeURIComponent`, then `! ' ( ) ~` are percent-encoded and `%20` becomes `+`. Radios and checkboxes count only when checked. For selects, use `value`, or the option text if the value is empty.
3. Sum the string in 4-byte big-endian words (a short tail is padded), fold to 16 bits, take the one's complement, and `& 0xffff`.
4. Post the same string followed by `postSecurityFlag=<csum>`.

Test vector, computed by the router's own JS: the parental-control add form with `usrname=Test Kid, mac=aabbccddeeff, Mon on, 22:00–06:30`, clicking `addfilterMac`, gives **40523**.

## Login

`/admin/login.asp`, form `cmlogin` → `POST /boaform/admin/formLogin`

`challenge` (empty), `username`, `password` (**disabled before submit, so not sent**), `save=Login` (clicked), `encodePassword = base64(password)`, `submit-url=/admin/login.asp`.

## Read-only pages

| Page | Contents |
|---|---|
| `/status.asp` | Device name, uptime, firmware, CPU %, memory %, DNS, LAN, and a WAN table (Interface, VLAN, Type, Protocol, IP, Gateway, Status) |
| `/wlstatbl.asp?wlan_idx=N` | Wi-Fi clients: MAC, Tx/Rx rate, packets, TXBYTES/RXBYTES (32-bit), RSSI, SNR, channel, MCS, uptime, power-save |
| `/dhcptbl.asp` | Leases: IP, MAC, expiry in seconds |
| `/arptable.asp` | IP and MAC, with MACs written `aa-bb-…` |
| `/stats.asp` | Per-interface packet counters only, no bytes |

## Writable pages

### Wi-Fi on/off: `/boaform/formWlanRedirect?redirect-url=/admin/wlbasic.asp&wlan_idx=N`
Form `wlanSetup` → `POST /boaform/admin/formWlanSetup`, clicking `save`.
- Off: tick `wlanDisabled` **and set its value to `ON`** (the HTML says `OFF`; `updateIputState()` rewrites it). `disableWLAN()` greys out `band, mode, ssid, chanwid, ctlband, chan, txpower, regdomain_demo`, so those aren't sent.
- On: untick it. `saveChanges()` recomputes `basicrates` and `operrates` from `band`; the algorithm is copied into `Router.setWifi`. The HTML default is `0`.

### Parental control (device bedtimes): `/parental-ctrl.asp`, action `/boaform/admin/formParentCtrl`
- Enable: radios `parental_ctrl_on` (0 = Disable, 1 = Enable), click `parentalCtrlSet`.
- Add: `usrname, mac (12 hex, no colons), Sun..Sat (checkbox "on"), starthr, startmin, endhr, endmin`, click `addfilterMac`. Start must be earlier than end on the same day.
- Delete: tick the row checkboxes, click `deleteSelFilterMac`.

### MAC-Based Assignment (fixed IP): `/macIptbl.asp`, form `macBase` → `/boaform/formmacBase`
`enable` (checkbox), `hostMac` (**`xx-xx-xx-xx-xx-xx`**, exactly 17 characters), `hostIp`. Click `addIP` to add; select a row and click `delIP` to delete. The DHCP pool is 192.168.1.2–254.

### IP QoS on/off: `/net_qos_imq_policy.asp` → `/boaform/admin/formQosPolicy`
`qosen` (0/1), `queuepolicy` (prio/wrr), `bandwidth_defined` (0/1), `totalbandwidth`, and `lst="policy=0"`. `on_save()` builds `lst`; no button name is posted. The script variables `qosEnable`, `totalBandwidth` and `userDefinedBandwidth` show the current state.

### Traffic shaping (speed limits)
- List: `/net_qos_traffictl.asp`. The data comes from script lines like `traffictlRules.push(new it_nr("i", new it("id",…), new it("srcip",…), new it("dstip",…), new it("rate",…), new it("direction",…)))`.
- Add: `/net_qos_traffictl_edit.asp` → `/boaform/admin/formQosTraffictlEdit`. Fields are `IpProtocolType=1, direction (0 up / 1 down), protolist=0, srcip, srcnetmask, dstip, dstnetmask, sport, dport, rate (kb/s)`, plus
  `lst = btoa("dummy=dummy&inf=<#inflist value>&proto=0&IPversion=1&srcip=…&srcnetmask=…&dstip=…&dstnetmask=…&sport=&dport=&rate=…&direction=…")`.
  `#inflist` has no name, so it isn't posted; its value (`65536`) only goes into `lst`. Buttons are `type=button`, so none is posted.
- Delete: `/boaform/admin/formQosTraffictl` with `lst="applysetting#id=1|2|3"`.

### Port forwarding: `/fw-portfw.asp` → `/boaform/formPortFw`
`portFwcap` (0/1), `fw_enable`, then about 8 rows of `comment[] localIPaddr[] localFromPort[] localToPort[] protocol[] remoteIPaddr[] remoteFromPort[] remoteToPort[] interface[] select_id[]`. Delete with `deleteSelPortFw`.

### URL blocking: `/url_blocking.asp` → `/boaform/formURL`
`urlcap` (0/1, click `apply`), `urlFQDN` + `addFQDN`, `Keywd` + `addKeywd`, and `delFQDN`/`delKeywd` for selected rows.

### DHCP / DNS handed to clients: `/dhcpd.asp` → `/boaform/formDhcpServer`
The server-mode fields are **injected by `showDhcpSvr()`**, so they aren't in the static HTML: `dhcpRangeStart, dhcpRangeEnd, dhcpSubnetMask, ltime, dname, ip, dhcpdns (0 = DNS proxy, 1 = manual), dns1, dns2, dns3`. RouterDash doesn't automate this page. Users set DNS1 by hand once (see README).

### Reboot: `/reboot.asp` → `/boaform/admin/formReboot`
Only `postSecurityFlag` is posted. The connection drops while the router restarts.

## Not touched on purpose

Firmware upgrade, backup/restore, admin password, TR-069, GPON/OMCI, WAN, ACL, and the factory-reset paths.
