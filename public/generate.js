// Builds the Android (Trusted Web Activity) project for Pryme Quant from the live web manifest.
// Used by .github/workflows/build-apps.yml — you don't need to run this yourself.
const { TwaManifest, TwaGenerator, ConsoleLog } = require('@bubblewrap/core');
(async () => {
  const site = (process.argv[2] || 'https://pryme-analyser.onrender.com').replace(/\/+$/, '');
  const out = process.argv[3] || 'twa';
  const m = await TwaManifest.fromWebManifest(site + '/manifest.json');
  m.packageId = process.env.PACKAGE_ID || 'com.prymequant.app';
  m.name = 'Pryme Quant';
  m.launcherName = 'Pryme Quant';
  m.signingKey = { path: '../android.keystore', alias: 'prymequant' };
  m.appVersionName = process.env.APP_VERSION || '1.0.' + (process.env.GITHUB_RUN_NUMBER || '0');
  m.appVersionCode = +(process.env.GITHUB_RUN_NUMBER || 1);
  m.enableNotifications = false;
  m.fallbackType = 'customtabs';
  require('fs').mkdirSync(out, { recursive: true });
  await m.saveToFile(out + '/twa-manifest.json');
  await new TwaGenerator().createTwaProject(out, m, new ConsoleLog('pryme'));
  console.log('Android project ready for', m.host, '→', m.packageId, m.appVersionName);
})().catch(e => { console.error(e); process.exit(1); });
