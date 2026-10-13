// Turns raw DNS lookups into things a person recognises.
//   kind: 'app'  — something a person opens on purpose (YouTube, WhatsApp, a bank)
//         'site' — a website not in the catalog (shown by its domain)
//         'bg'   — background: OS services, app telemetry, ads, CDNs, updates
'use strict';

// [name, category, kind, ...domain suffixes]
const CATALOG = [
  // Video & streaming
  ['YouTube', 'Video', 'app', 'youtube.com', 'googlevideo.com', 'ytimg.com', 'youtu.be', 'youtubei.googleapis.com', 'youtube-nocookie.com', 'yt3.ggpht.com'],
  ['Netflix', 'Video', 'app', 'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxext.com', 'nflxso.net'],
  ['Prime Video', 'Video', 'app', 'primevideo.com', 'aiv-cdn.net', 'aiv-delivery.net', 'pv-cdn.net', 'atv-ps.amazon.com'],
  ['JioHotstar', 'Video', 'app', 'hotstar.com', 'hotstarext.com', 'jiocinema.com', 'jiohotstar.com', 'hses.akamaized.net'],
  ['SonyLIV', 'Video', 'app', 'sonyliv.com'],
  ['ZEE5', 'Video', 'app', 'zee5.com'],
  ['MX Player', 'Video', 'app', 'mxplayer.in'],
  ['Twitch', 'Video', 'app', 'twitch.tv', 'ttvnw.net', 'jtvnw.net'],
  ['Disney+', 'Video', 'app', 'disneyplus.com', 'bamgrid.com', 'dssott.com'],
  ['Apple TV', 'Video', 'app', 'tv.apple.com'],
  // Music
  ['Spotify', 'Music', 'app', 'spotify.com', 'scdn.co', 'spotifycdn.com', 'spotify.map.fastly.net'],
  ['JioSaavn', 'Music', 'app', 'jiosaavn.com', 'saavncdn.com', 'saavn.com'],
  ['Gaana', 'Music', 'app', 'gaana.com'],
  ['YouTube Music', 'Music', 'app', 'music.youtube.com'],
  ['Apple Music', 'Music', 'app', 'music.apple.com', 'aod.itunes.apple.com'],
  ['Wynk Music', 'Music', 'app', 'wynk.in'],
  // Social
  ['Instagram', 'Social', 'app', 'instagram.com', 'cdninstagram.com', 'ig.me'],
  ['Facebook', 'Social', 'app', 'facebook.com', 'fbcdn.net', 'fb.com', 'facebook.net', 'fbsbx.com'],
  ['WhatsApp', 'Messaging', 'app', 'whatsapp.com', 'whatsapp.net', 'wa.me'],
  ['Snapchat', 'Social', 'app', 'snapchat.com', 'sc-cdn.net', 'snap-dev.net', 'snapkit.com', 'sc-static.net', 'sc-gw.com'],
  ['X (Twitter)', 'Social', 'app', 'twitter.com', 'x.com', 'twimg.com', 't.co'],
  ['Threads', 'Social', 'app', 'threads.net', 'threads.com'],
  ['Reddit', 'Social', 'app', 'reddit.com', 'redd.it', 'redditmedia.com', 'redditstatic.com'],
  ['LinkedIn', 'Social', 'app', 'linkedin.com', 'licdn.com'],
  ['Pinterest', 'Social', 'app', 'pinterest.com', 'pinimg.com'],
  ['ShareChat / Moj', 'Social', 'app', 'sharechat.com', 'mojapp.in'],
  ['Josh', 'Social', 'app', 'myjosh.in'],
  ['Telegram', 'Messaging', 'app', 'telegram.org', 't.me', 'telegram.me', 'telesco.pe'],
  ['Signal', 'Messaging', 'app', 'signal.org', 'whispersystems.org'],
  ['Discord', 'Messaging', 'app', 'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'],
  ['Truecaller', 'Messaging', 'app', 'truecaller.com', 'tcapi.in'],
  ['TikTok', 'Social', 'app', 'tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com'],
  // AI
  ['ChatGPT', 'AI', 'app', 'chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com'],
  ['Claude', 'AI', 'app', 'claude.ai', 'anthropic.com', 'claude.com'],
  ['Gemini', 'AI', 'app', 'gemini.google.com', 'bard.google.com'],
  ['Perplexity', 'AI', 'app', 'perplexity.ai'],
  ['Copilot', 'AI', 'app', 'copilot.microsoft.com'],
  // Work & productivity
  ['Gmail', 'Email', 'app', 'mail.google.com', 'gmail.com'],
  ['Outlook', 'Email', 'app', 'outlook.office.com', 'outlook.live.com', 'outlook.office365.com'],
  ['Google Drive & Docs', 'Work', 'app', 'drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com'],
  ['Google Meet', 'Calls', 'app', 'meet.google.com'],
  ['Zoom', 'Calls', 'app', 'zoom.us', 'zoom.com', 'zoomgov.com'],
  ['Microsoft Teams', 'Calls', 'app', 'teams.microsoft.com', 'teams.live.com', 'skype.com'],
  ['Slack', 'Work', 'app', 'slack.com', 'slack-edge.com', 'slack-msgs.com'],
  ['Notion', 'Work', 'app', 'notion.so', 'notion.com'],
  ['GitHub', 'Developer', 'app', 'github.com', 'githubusercontent.com', 'githubassets.com'],
  ['Stack Overflow', 'Developer', 'app', 'stackoverflow.com', 'sstatic.net', 'stackexchange.com'],
  ['AWS Console', 'Developer', 'app', 'console.aws.amazon.com', 'awsapps.com'],
  ['Figma', 'Work', 'app', 'figma.com'],
  ['Canva', 'Work', 'app', 'canva.com'],
  ['Dropbox', 'Work', 'app', 'dropbox.com', 'dropboxapi.com'],
  ['Google Search', 'Search', 'app', 'www.google.com', 'google.co.in'],
  ['Bing', 'Search', 'app', 'bing.com'],
  ['DuckDuckGo', 'Search', 'app', 'duckduckgo.com'],
  ['Google Maps', 'Maps', 'app', 'maps.google.com', 'maps.googleapis.com', 'maps.gstatic.com'],
  ['Wikipedia', 'Reference', 'app', 'wikipedia.org', 'wikimedia.org'],
  // Shopping & food
  ['Amazon', 'Shopping', 'app', 'amazon.in', 'amazon.com', 'media-amazon.com', 'ssl-images-amazon.com', 'amazon-adsystem.com:bg'],
  ['Flipkart', 'Shopping', 'app', 'flipkart.com', 'flixcart.com', 'fkapi.net'],
  ['Myntra', 'Shopping', 'app', 'myntra.com', 'myntassets.com'],
  ['Meesho', 'Shopping', 'app', 'meesho.com', 'meeshosupplyassets.com'],
  ['Ajio', 'Shopping', 'app', 'ajio.com'],
  ['Nykaa', 'Shopping', 'app', 'nykaa.com'],
  ['Blinkit', 'Groceries', 'app', 'blinkit.com', 'grofers.com'],
  ['Zepto', 'Groceries', 'app', 'zeptonow.com', 'zepto.co.in'],
  ['BigBasket', 'Groceries', 'app', 'bigbasket.com', 'bbassets.com'],
  ['Swiggy', 'Food', 'app', 'swiggy.com', 'swiggy.in'],
  ['Zomato', 'Food', 'app', 'zomato.com', 'zmtcdn.com'],
  ['BookMyShow', 'Tickets', 'app', 'bookmyshow.com', 'bmscdn.com'],
  ['Uber', 'Travel', 'app', 'uber.com', 'ubr.to'],
  ['Ola', 'Travel', 'app', 'olacabs.com'],
  ['Rapido', 'Travel', 'app', 'rapido.bike'],
  ['IRCTC', 'Travel', 'app', 'irctc.co.in'],
  ['MakeMyTrip', 'Travel', 'app', 'makemytrip.com', 'mmtcdn.com'],
  // Money
  ['Google Pay', 'Payments', 'app', 'pay.google.com', 'gpay.app.goo.gl', 'payments.google.com'],
  ['PhonePe', 'Payments', 'app', 'phonepe.com'],
  ['Paytm', 'Payments', 'app', 'paytm.com', 'paytm.in', 'paytmbank.com'],
  ['CRED', 'Payments', 'app', 'cred.club'],
  ['SBI', 'Banking', 'app', 'onlinesbi.sbi', 'sbi.co.in', 'yonosbi.com', 'sbi'],
  ['HDFC Bank', 'Banking', 'app', 'hdfcbank.com'],
  ['ICICI Bank', 'Banking', 'app', 'icicibank.com'],
  ['Axis Bank', 'Banking', 'app', 'axisbank.com'],
  ['Kotak', 'Banking', 'app', 'kotak.com'],
  ['Zerodha', 'Investing', 'app', 'zerodha.com', 'kite.trade'],
  ['Groww', 'Investing', 'app', 'groww.in'],
  ['Upstox', 'Investing', 'app', 'upstox.com'],
  // News
  ['Google News', 'News', 'app', 'news.google.com'],
  ['Times of India', 'News', 'app', 'indiatimes.com', 'timesofindia.com'],
  ['NDTV', 'News', 'app', 'ndtv.com', 'ndtvimg.com'],
  ['Hindustan Times', 'News', 'app', 'hindustantimes.com'],
  ['The Hindu', 'News', 'app', 'thehindu.com'],
  ['Inshorts', 'News', 'app', 'inshorts.com'],
  ['Cricbuzz', 'Sports', 'app', 'cricbuzz.com'],
  ['ESPNcricinfo', 'Sports', 'app', 'espncricinfo.com'],
  ['Dream11', 'Games', 'app', 'dream11.com'],
  // Games
  ['BGMI / PUBG', 'Games', 'app', 'battlegroundsmobileindia.com', 'pubgmobile.com', 'igamecj.com', 'gcloudsdk.com'],
  ['Free Fire', 'Games', 'app', 'freefiremobile.com', 'garena.com', 'garenanow.com'],
  ['Roblox', 'Games', 'app', 'roblox.com', 'rbxcdn.com'],
  ['Minecraft', 'Games', 'app', 'minecraft.net', 'mojang.com', 'minecraftservices.com'],
  ['Steam', 'Games', 'app', 'steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com'],
  ['Epic Games', 'Games', 'app', 'epicgames.com', 'unrealengine.com', 'fortnite.com'],
  ['PlayStation', 'Games', 'app', 'playstation.com', 'playstation.net', 'sonyentertainmentnetwork.com'],
  ['Xbox', 'Games', 'app', 'xboxlive.com', 'xbox.com'],
  ['Clash / Supercell', 'Games', 'app', 'supercell.com', 'supercell.net', 'clashofclans.com'],
  ['Ludo King', 'Games', 'app', 'ludoking.com'],
  ['Candy Crush', 'Games', 'app', 'king.com'],
  // Education
  ['Byju\'s', 'Education', 'app', 'byjus.com'],
  ['Unacademy', 'Education', 'app', 'unacademy.com'],
  ['Physics Wallah', 'Education', 'app', 'pw.live', 'physicswallah.live'],
  ['Khan Academy', 'Education', 'app', 'khanacademy.org'],
  ['Duolingo', 'Education', 'app', 'duolingo.com'],
  ['Coursera', 'Education', 'app', 'coursera.org'],
  ['Udemy', 'Education', 'app', 'udemy.com', 'udemycdn.com'],
  // Adult content gets one label; no domains listed.

  // ---- background ----
  ['Apple system services', 'System', 'bg', 'apple.com', 'icloud.com', 'icloud-content.com', 'mzstatic.com', 'apple-dns.net', 'aaplimg.com', 'cdn-apple.com', 'apple.news', 'itunes.apple.com', 'push.apple.com', 'me.com', 'apple-cloudkit.com', 'apple-livephotoskit.com', 'appattest.apple.com'],
  ['Google system services', 'System', 'bg', 'googleapis.com', 'gstatic.com', 'gvt1.com', 'gvt2.com', 'gvt3.com', 'ggpht.com', 'googleusercontent.com', 'google.com', 'android.com', 'googlezip.net', 'gmodules.com', 'withgoogle.com', 'goog', 'googlesyndication.com:ads', 'gstaticadssl.l.google.com'],
  ['Microsoft & Windows', 'System', 'bg', 'microsoft.com', 'windows.com', 'windowsupdate.com', 'msftconnecttest.com', 'msedge.net', 'live.com', 'office.com', 'office.net', 'microsoftonline.com', 'msn.com', 'azureedge.net', 'azure.com', 'bing.net', 'skype.net', 'visualstudio.com'],
  ['Samsung system', 'System', 'bg', 'samsung.com', 'samsungcloud.com', 'samsungapps.com', 'samsungosp.com', 'samsungqbe.com', 'samsungelectronics.com'],
  ['Xiaomi / Redmi system', 'System', 'bg', 'xiaomi.com', 'miui.com', 'mi.com', 'xiaomi.net', 'mi-img.com', 'intl.miui.com'],
  ['OnePlus / Oppo / Vivo / Realme', 'System', 'bg', 'oneplus.com', 'oneplus.net', 'oppo.com', 'heytapmobi.com', 'heytapmobile.com', 'vivo.com', 'vivoglobal.com', 'realme.com', 'coloros.com'],
  ['Smart TV / streaming stick', 'System', 'bg', 'lgtvsdp.com', 'lgsmartad.com', 'samsungcloudsolution.com', 'roku.com', 'amazonvideo.com', 'firetvcaptiveportal.com', 'device-metrics-us.amazon.com', 'mitv', 'tcl.com'],
  ['Amazon Alexa / devices', 'System', 'bg', 'amazonalexa.com', 'alexa.com', 'amazon-dss.com', 'a2z.com', 'amcs-tachyon.com'],
  ['Antivirus & security', 'System', 'bg', 'avast.com', 'avg.com', 'mcafee.com', 'norton.com', 'quickheal.com', 'kaspersky.com', 'bitdefender.com', 'malwarebytes.com', 'sophos.com', 'crowdstrike.com'],
  ['Time & connectivity checks', 'System', 'bg', 'ntp.org', 'time.apple.com', 'time.google.com', 'time.windows.com', 'captive.apple.com', 'connectivitycheck.gstatic.com', 'clients3.google.com', 'detectportal.firefox.com', 'nmcheck.gnome.org'],
  ['Certificate checks', 'System', 'bg', 'digicert.com', 'letsencrypt.org', 'lencr.org', 'sectigo.com', 'globalsign.com', 'godaddy.com', 'entrust.net', 'pki.goog', 'usertrust.com', 'comodoca.com', 'amazontrust.com', 'identrust.com'],
  ['App analytics & crash reports', 'Analytics', 'bg', 'app-measurement.com', 'crashlytics.com', 'firebaseio.com', 'firebase.googleapis.com', 'firebaselogging-pa.googleapis.com', 'sentry.io', 'bugsnag.com', 'mixpanel.com', 'amplitude.com', 'segment.io', 'segment.com', 'clevertap-prod.com', 'wzrkt.com', 'moengage.com', 'braze.com', 'onesignal.com', 'newrelic.com', 'nr-data.net', 'datadoghq.com', 'hotjar.com', 'clarity.ms', 'statsig.com', 'launchdarkly.com', 'optimizely.com', 'branch.io', 'app.link', 'appsflyer.com', 'appsflyersdk.com', 'adjust.com', 'adjust.net.in', 'kochava.com', 'singular.net'],
  ['Ads & trackers', 'Ads', 'bg', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'adservice.google.com', 'admob.com', 'applovin.com', 'unity3d.com', 'unityads.unity3d.com', 'ironsrc.com', 'ironsrc.mobi', 'vungle.com', 'chartboost.com', 'inmobi.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'moatads.com', 'scorecardresearch.com', 'quantserve.com', 'adsrvr.org', 'casalemedia.com', 'amazon-adsystem.com', 'facebook.net:ads', 'ads-twitter.com', 'tiqcdn.com', 'bidswitch.net', 'smaato.net', 'mintegral.net', 'pangle.io', 'liftoff.io', 'appier.net'],
  ['Content delivery (CDN)', 'CDN', 'bg', 'akamai.net', 'akamaiedge.net', 'akamaihd.net', 'akamaized.net', 'edgekey.net', 'edgesuite.net', 'cloudfront.net', 'fastly.net', 'fastlylb.net', 'cloudflare.com', 'cloudflare.net', 'cloudflare-dns.com', 'jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'llnwd.net', 'edgecastcdn.net', 'azurefd.net', 'b-cdn.net', 'bunnycdn.com', 'stackpathdns.com', 'cdn77.org', 'amazonaws.com', 'awsdns', 'gcdn.co', 'imgix.net', 'kxcdn.com', 'trafficmanager.net'],
  ['Software updates', 'System', 'bg', 'update.googleapis.com', 'dl.google.com', 'swcdn.apple.com', 'swscan.apple.com', 'mesu.apple.com', 'download.windowsupdate.com', 'delivery.mp.microsoft.com', 'brew.sh', 'npmjs.org', 'npmjs.com', 'pypi.org', 'pythonhosted.org', 'docker.io', 'docker.com', 'jetbrains.com', 'vscode-cdn.net', 'gallerycdn.vsassets.io'],
  ['Browser services', 'System', 'bg', 'mozilla.com', 'mozilla.net', 'mozilla.org', 'firefox.com', 'brave.com', 'bravesoftware.com', 'opera.com', 'operacdn.com', 'safebrowsing.googleapis.com', 'chrome.google.com', 'clients1.google.com', 'clients2.google.com', 'clients4.google.com', 'clients6.google.com', 'safebrowsing.apple'],
  ['VPN & private relay', 'System', 'bg', 'mask.icloud.com', 'mask-h2.icloud.com', 'nordvpn.com', 'expressvpn.com', 'protonvpn.com', 'tailscale.com', 'tailscale.io', 'cloudflareclient.com', 'zscaler.net', 'zscaler.com'],
  ['Router & ISP', 'System', 'bg', 'gtpl.net', 'gtplkcbpl.com', 'bbrouter'],
];

// Turn the catalog into a suffix lookup. "suffix:bg" / "suffix:ads" overrides the kind.
const INDEX = new Map();
for (const [name, cat, kind, ...suffixes] of CATALOG) for (const s of suffixes) {
  const [suf, override] = s.split(':');
  INDEX.set(suf, { name, cat: override === 'ads' ? 'Ads' : cat, kind: override ? 'bg' : kind });
}

const MULTI = new Set(['co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in', 'res.in', 'nic.in', 'firm.in', 'gen.in', 'ind.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'com.sg', 'com.my', 'co.za', 'com.cn', 'com.hk', 'co.kr', 'com.tw', 'com.mx', 'com.tr', 'co.id', 'com.pk', 'com.bd', 'com.np', 'com.lk']);
function registrable(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return MULTI.has(last2) ? p.slice(-3).join('.') : last2;
}

const NOISE = /(^|[.-])(cdn\d*|static|assets?|img|images|media|edge|api\d*|gw|gateway|push|notify|telemetry|metrics?|analytics?|stats?|log(s|ging)?|track(ing|er)?|pixel|beacon|events?|collect(or)?|sdk|config|settings|ocsp|crl|ntp|time|update|updates|dl|download|mtalk|mqtt|socket|ws|rt|tracking|sentry|crash|monitor|health|ping|heartbeat|ads?|adserver|adsystem|doubleclick)([.-]|\d|$)/i;

// Hostnames apps use when nobody is looking at them. Everything else under a
// known app (www, api, media, cdn) counts as using the app.
const APP_BG = /(^|\.)(g|e\d+|edge-mqtt|edge-chat|mqtt\w*|push\w*|graph|b-graph|b-api|telemetry\w*|log|logs|logging|logger|metric\w*|analytic\w*|events?|stats?|ping|keepalive|heartbeat|notifications?|crash\w*|beacon|track\w*|pixel|remote-config|firebaselogging)$/i;

const cache = new Map();
function classify(qname) {
  let host = String(qname || '').toLowerCase().replace(/\.$/, '');
  if (cache.has(host)) return cache.get(host);
  let out;
  if (!host || !host.includes('.') || /\.(local|lan|home|arpa|internal|localdomain)$/.test(host) || /^_/.test(host)) {
    out = { name: 'Local network', cat: 'Local', kind: 'bg', domain: host };
  } else {
    // longest matching suffix wins (so music.youtube.com beats youtube.com)
    const parts = host.split('.');
    for (let i = 0; i < parts.length && !out; i++) {
      const suf = parts.slice(i).join('.');
      const hit = INDEX.get(suf);
      if (hit) {
        out = { ...hit, domain: registrable(host) };
        // Apps keep background connections open (chat sockets, push, sync,
        // analytics). Those lookups don't mean someone is using the app.
        const sub = host.slice(0, Math.max(0, host.length - suf.length - 1));
        if (hit.kind === 'app' && sub && APP_BG.test(sub)) out = { name: hit.name + ' (background)', cat: hit.cat, kind: 'bg', app: hit.name, domain: out.domain };
      }
    }
    if (!out) {
      const reg = registrable(host);
      const sub = host.slice(0, Math.max(0, host.length - reg.length - 1));
      const looksBg = NOISE.test(sub) || NOISE.test(reg.split('.')[0]) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
      out = looksBg ? { name: 'Other background', cat: 'Other', kind: 'bg', domain: reg }
                    : { name: reg, cat: 'Website', kind: 'site', domain: reg };
    }
  }
  if (cache.size > 20000) cache.clear();
  cache.set(host, out);
  return out;
}

module.exports = { classify, registrable, CATALOG };
