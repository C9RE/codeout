// One-off: provision the BAKED demo device on the demo daemon's CODEOUT_HOME and print the material
// to bake into the iOS app. Run once: CODEOUT_HOME=~/.codeout-demo node scripts/provision-demo-device.mjs
// Generates a crypto_kx device keypair, registers it + mints a permanent (non-expiring) device token,
// and reads the demo daemon's server pubkey. The app holds the device private key + token; the daemon
// holds the public key. A leaked key only grants demo access (chat-only, rate-limited) — secrecy isn't
// the protection. Re-running mints a NEW identity; run ONCE and keep the output stable.
import sodium from 'libsodium-wrappers';
import { initCrypto, registerDevice, mintDeviceToken, daemonPublicKeyB64, _b64 } from '../crypto.js';

await sodium.ready;
await initCrypto();
const kp = sodium.crypto_kx_keypair();
const devicePub = _b64(kp.publicKey);
const devicePriv = _b64(kp.privateKey);
const id = registerDevice(devicePub, 'Demo Visitor');
const token = mintDeviceToken(devicePub, 'Demo Visitor');
const serverPk = daemonPublicKeyB64();

console.log(JSON.stringify({
  note: 'Bake these into the iOS app for the "Try the live demo" button (paired-device identity).',
  host: 'demo.codeout.dev',
  daemonServerPk: serverPk,
  deviceToken: token,
  devicePublicKey: devicePub,
  devicePrivateKey: devicePriv,
  deviceId: id
}, null, 2));
