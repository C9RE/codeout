import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateAgentConfig, getAgentAuth } from '../config.js';
import { isLoopbackRequest, isLocalRequest, originOk } from '../auth.js';
import { isValidAvatar } from '../crypto.js';

test('prototype pollution attempts in updateAgentConfig and getAgentAuth are blocked', () => {
	assert.throws(() => {
		updateAgentConfig('__proto__', { pollutes: true });
	}, /Invalid agent ID/);

	assert.throws(() => {
		updateAgentConfig('constructor', { pollutes: true });
	}, /Invalid agent ID/);

	assert.throws(() => {
		updateAgentConfig('prototype', { pollutes: true });
	}, /Invalid agent ID/);

	assert.throws(() => {
		updateAgentConfig('', { enabled: true });
	}, /Invalid agent ID/);

	assert.throws(() => {
		updateAgentConfig('a'.repeat(50), { enabled: true });
	}, /Invalid agent ID/);

	const protoAuth = getAgentAuth('__proto__');
	assert.equal(protoAuth.enabled, false);
	assert.equal(protoAuth.apiKey, null);

	const ctorAuth = getAgentAuth('constructor');
	assert.equal(ctorAuth.enabled, false);
	assert.equal(ctorAuth.apiKey, null);

	const emptyAuth = getAgentAuth('');
	assert.equal(emptyAuth.enabled, false);

	const nullAuth = getAgentAuth(null);
	assert.equal(nullAuth.enabled, false);
});

test('isLoopbackRequest correctly identifies 127.0.0.1 and ::1', () => {
	const makeReq = (ip) => ({ socket: { remoteAddress: ip } });

	assert.equal(isLoopbackRequest(makeReq('127.0.0.1')), true);
	assert.equal(isLoopbackRequest(makeReq('::1')), true);
	assert.equal(isLoopbackRequest(makeReq('::ffff:127.0.0.1')), true);

	assert.equal(isLoopbackRequest(makeReq('192.168.1.50')), false);
	assert.equal(isLoopbackRequest(makeReq('10.0.0.5')), false);
	assert.equal(isLoopbackRequest(makeReq('8.8.8.8')), false);
	assert.equal(isLoopbackRequest(makeReq('')), false);
	assert.equal(isLoopbackRequest({}), false);
});

test('isLocalRequest correctly classifies local vs public networks', () => {
	const makeReq = (ip) => ({ socket: { remoteAddress: ip } });

	// Local: Loopback, RFC1918, CGNAT/Tailscale, Link-Local
	assert.equal(isLocalRequest(makeReq('127.0.0.1')), true);
	assert.equal(isLocalRequest(makeReq('::1')), true);
	assert.equal(isLocalRequest(makeReq('10.0.1.42')), true);
	assert.equal(isLocalRequest(makeReq('192.168.1.100')), true);
	assert.equal(isLocalRequest(makeReq('172.16.0.10')), true);
	assert.equal(isLocalRequest(makeReq('172.31.255.255')), true);
	assert.equal(isLocalRequest(makeReq('100.77.82.41')), true); // Tailscale 100.64/10
	assert.equal(isLocalRequest(makeReq('169.254.1.1')), true); // Link-local
	assert.equal(isLocalRequest(makeReq('fc00::1')), true); // IPv6 ULA
	assert.equal(isLocalRequest(makeReq('fe80::1')), true); // IPv6 link-local

	// Public non-local IPs
	assert.equal(isLocalRequest(makeReq('1.1.1.1')), false);
	assert.equal(isLocalRequest(makeReq('8.8.8.8')), false);
	assert.equal(isLocalRequest(makeReq('172.32.0.1')), false);
	assert.equal(isLocalRequest(makeReq('100.128.0.1')), false);
	assert.equal(isLocalRequest(makeReq('')), false);
});

test('originOk validates origins and prevents CSWSH', () => {
	assert.equal(originOk({ headers: {} }), true); // Absent origin (direct CLI/same-origin)
	assert.equal(originOk({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }), true);
	assert.equal(originOk({ headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } }), true);
	assert.equal(originOk({ headers: { origin: 'https://app.codeout.dev', host: 'test.codeout.dev' } }), true);

	// Malicious cross-site origins
	assert.equal(originOk({ headers: { origin: 'https://evil-attacker.com', host: '127.0.0.1:3000' } }), false);
	assert.equal(originOk({ headers: { origin: 'not-a-valid-url', host: '127.0.0.1:3000' } }), false);
});

test('isValidAvatar validates safe data URLs and rejects XSS vectors', () => {
	assert.equal(isValidAvatar('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), true);
	assert.equal(isValidAvatar('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), true);
	assert.equal(isValidAvatar(''), false);
	assert.equal(isValidAvatar(null), false);
	assert.equal(isValidAvatar('<script>alert(1)</script>'), false);
	assert.equal(isValidAvatar('data:image/svg+xml;base64,PHN2Zz4='), false); // SVG disallowed
	assert.equal(isValidAvatar('javascript:alert(1)'), false);
	assert.equal(isValidAvatar('A'.repeat(50)), false);
});
