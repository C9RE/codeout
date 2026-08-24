import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, maskApiKey, getAdminConfig, updateAgentConfig, getAgentAuth, getClientAgentsList, loadConfig } from '../config.js';

test('hashPassword + verifyPassword scrypt verification', () => {
	const stored = hashPassword('correct-horse-battery-staple');
	assert.ok(stored.includes(':'));
	assert.equal(verifyPassword(stored, 'correct-horse-battery-staple'), true);
	assert.equal(verifyPassword(stored, 'wrong-password'), false);
	assert.equal(verifyPassword(stored, ''), false);
	assert.equal(verifyPassword(null, 'test'), false);
});

test('maskApiKey obfuscates secrets safely', () => {
	assert.equal(maskApiKey(null), null);
	assert.equal(maskApiKey(''), null);
	assert.equal(maskApiKey('12345678'), '••••••••');
	const masked = maskApiKey('sk-ant-api03-abcdef1234567890-xyz');
	assert.ok(masked.startsWith('sk-ant-a'));
	assert.ok(masked.endsWith('-xyz'));
	assert.ok(masked.includes('••••••••••••'));
});

test('getAdminConfig returns masked keys and detected agents', () => {
	const cfg = getAdminConfig();
	assert.ok(cfg.server);
	assert.ok(cfg.agents);
	assert.ok(cfg.agents.claude);
	assert.ok(cfg.agents.codex);
	assert.ok(cfg.agents.gemini);
});

test('updateAgentConfig updates agent fields and getAgentAuth reflects changes', () => {
	updateAgentConfig('claude', { authMode: 'apiKey', apiKey: 'sk-ant-test-key-1234', defaultModel: 'claude-3-7-sonnet' });
	const auth = getAgentAuth('claude');
	assert.equal(auth.authMode, 'apiKey');
	assert.equal(auth.apiKey, 'sk-ant-test-key-1234');
	assert.equal(auth.defaultModel, 'claude-3-7-sonnet');

	const admin = getAdminConfig();
	assert.equal(admin.agents.claude.hasApiKey, true);
	assert.ok(admin.agents.claude.apiKeyMasked.includes('••••••••••••'));
	assert.notEqual(admin.agents.claude.apiKeyMasked, 'sk-ant-test-key-1234');

	// Revert to subscription
	updateAgentConfig('claude', { authMode: 'subscription', apiKey: null });
	const authReverted = getAgentAuth('claude');
	assert.equal(authReverted.authMode, 'subscription');
	assert.equal(authReverted.apiKey, null);
});

test('getClientAgentsList returns enabled agents with model metadata', () => {
	const list = getClientAgentsList();
	assert.ok(Array.isArray(list));
	const claude = list.find((a) => a.id === 'claude');
	assert.ok(claude);
	assert.equal(claude.enabled, true);
	assert.ok(Array.isArray(claude.models));
});
