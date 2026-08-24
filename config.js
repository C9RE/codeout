// daemon/config.js — Persistent daemon configuration & server-authoritative agent management.
// Stores ~/.codeout/config.json with mode 0600 using atomic writes.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { detectAgents } from './agents.js';

const CODEOUT_HOME = process.env.CODEOUT_HOME || join(homedir(), '.codeout');
const CONFIG_FILE = join(CODEOUT_HOME, 'config.json');

function writeAtomic(path, data, mode = 0o600) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, data, { mode });
	renameSync(tmp, path);
}

// ---- Password Hashing & Verification via native scrypt ----
export function hashPassword(pw) {
	if (!pw || typeof pw !== 'string') throw new Error('Password must be a non-empty string');
	const salt = randomBytes(16).toString('hex');
	const hash = scryptSync(pw, salt, 64).toString('hex');
	return `${salt}:${hash}`;
}

export function verifyPassword(storedHash, candidatePw) {
	if (!storedHash || !candidatePw || typeof storedHash !== 'string' || typeof candidatePw !== 'string') return false;
	const [salt, key] = storedHash.split(':');
	if (!salt || !key) return false;
	const candidateHash = scryptSync(candidatePw, salt, 64);
	const keyBuf = Buffer.from(key, 'hex');
	if (candidateHash.length !== keyBuf.length) return false;
	return timingSafeEqual(candidateHash, keyBuf);
}

// ---- Default Configuration ----
function defaultAgents() {
	return {
		claude: {
			enabled: true,
			chat: true,
			name: 'Claude Code',
			authMode: 'subscription', // 'subscription' | 'apiKey'
			apiKey: null,
			baseUrl: null,
			defaultModel: 'claude-3-7-sonnet',
			allowedModels: ['claude-3-7-sonnet', 'claude-3-5-haiku', 'claude-3-opus'],
			hasEffort: true,
			efforts: ['low', 'medium', 'high', 'max']
		},
		codex: {
			enabled: true,
			chat: true,
			name: 'OpenAI Codex',
			authMode: 'subscription', // 'subscription' | 'apiKey'
			apiKey: null,
			baseUrl: null,
			defaultModel: 'o3-mini',
			allowedModels: ['o3-mini', 'gpt-4o', 'o1'],
			hasEffort: true,
			efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
		},
		gemini: {
			enabled: true,
			chat: true,
			name: 'Gemini (Antigravity)',
			authMode: 'subscription', // 'subscription' | 'apiKey'
			apiKey: null,
			baseUrl: null,
			defaultModel: 'gemini-2.5-pro',
			allowedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
			hasEffort: false,
			efforts: []
		}
	};
}

function defaultConfig() {
	return {
		version: 2,
		server: {
			port: 8400,
			exposure: 'tunnel', // 'tunnel' | 'local'
			passwordHash: null,
			allowedRoots: []
		},
		agents: defaultAgents()
	};
}

let configCache = null;

export function loadConfig() {
	if (configCache) return configCache;
	try {
		if (existsSync(CONFIG_FILE)) {
			const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
			configCache = {
				version: 2,
				token: parsed.token || undefined,
				server: { ...defaultConfig().server, ...(parsed.server || {}) },
				agents: { ...defaultAgents(), ...(parsed.agents || {}) }
			};
			return configCache;
		}
	} catch (e) {
		console.error('[codeout] config read error, using defaults:', e?.message ?? e);
	}
	configCache = defaultConfig();
	return configCache;
}

export function saveConfig(cfg) {
	configCache = cfg;
	try {
		mkdirSync(CODEOUT_HOME, { recursive: true, mode: 0o700 });
		let token = cfg.token;
		if (!token && existsSync(CONFIG_FILE)) {
			try {
				const existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
				if (existing?.token) token = existing.token;
			} catch { /* ignore */ }
		}
		const toWrite = { ...cfg };
		if (token) toWrite.token = token;
		writeAtomic(CONFIG_FILE, JSON.stringify(toWrite, null, 2), 0o600);
	} catch (e) {
		console.error('[codeout] config persist failed:', e?.message ?? e);
	}
}

export function setMasterPassword(plainPassword) {
	const cfg = loadConfig();
	if (!plainPassword) {
		cfg.server.passwordHash = null;
	} else {
		cfg.server.passwordHash = hashPassword(plainPassword);
	}
	saveConfig(cfg);
}

export function checkMasterPassword(candidate) {
	const cfg = loadConfig();
	if (!cfg.server.passwordHash) return true; // no password configured
	return verifyPassword(cfg.server.passwordHash, candidate);
}

export function hasMasterPassword() {
	const cfg = loadConfig();
	return Boolean(cfg.server.passwordHash);
}

// Mask secret keys for UI display: e.g. "sk-ant-api03-••••••••••••3a8f"
export function maskApiKey(key) {
	if (!key || typeof key !== 'string') return null;
	if (key.length <= 8) return '••••••••';
	const prefix = key.slice(0, Math.min(8, Math.floor(key.length / 3)));
	const suffix = key.slice(-4);
	return `${prefix}••••••••••••${suffix}`;
}

// Returns config suitable for admin UI (API keys masked)
export function getAdminConfig(env) {
	const cfg = loadConfig();
	const detected = detectAgents(env || process.env);
	const agentsOut = {};

	for (const [id, agent] of Object.entries(cfg.agents)) {
		const det = detected[id] || { installed: false, version: null };
		agentsOut[id] = {
			...agent,
			id,
			chat: true,
			installed: det.installed,
			version: det.version,
			apiKeyMasked: agent.apiKey ? maskApiKey(agent.apiKey) : null,
			hasApiKey: Boolean(agent.apiKey)
		};
	}

	return {
		server: {
			port: cfg.server.port,
			exposure: cfg.server.exposure,
			hasPassword: Boolean(cfg.server.passwordHash),
			allowedRoots: cfg.server.allowedRoots
		},
		agents: agentsOut
	};
}

// Update specific agent's configuration
export function updateAgentConfig(agentId, patch) {
	const cfg = loadConfig();
	if (!cfg.agents[agentId]) {
		cfg.agents[agentId] = {
			enabled: true,
			name: agentId,
			authMode: 'subscription',
			apiKey: null,
			baseUrl: null,
			defaultModel: null,
			allowedModels: [],
			hasEffort: false,
			efforts: []
		};
	}
	const target = cfg.agents[agentId];
	if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
	if (patch.authMode === 'subscription' || patch.authMode === 'apiKey') target.authMode = patch.authMode;
	if (patch.apiKey !== undefined) {
		// Only update if not null/empty or if explicitly set to null/empty string to clear
		target.apiKey = patch.apiKey ? String(patch.apiKey).trim() : null;
	}
	if (patch.baseUrl !== undefined) target.baseUrl = patch.baseUrl ? String(patch.baseUrl).trim() : null;
	if (patch.defaultModel !== undefined) target.defaultModel = patch.defaultModel;
	if (Array.isArray(patch.allowedModels)) target.allowedModels = patch.allowedModels;

	saveConfig(cfg);
	return target;
}

// Returns unmasked API key / auth config for execution
export function getAgentAuth(agentId) {
	const cfg = loadConfig();
	const agent = cfg.agents[agentId];
	if (!agent) return { authMode: 'subscription', apiKey: null, baseUrl: null };
	return {
		enabled: agent.enabled !== false,
		authMode: agent.authMode || 'subscription',
		apiKey: agent.apiKey || null,
		baseUrl: agent.baseUrl || null,
		defaultModel: agent.defaultModel || null
	};
}

// Client-facing agent roster for /api/agents (only enabled & ready-to-run agents)
export function getClientAgentsList(env) {
	const cfg = loadConfig();
	const detected = detectAgents(env || process.env);
	const list = [];

	for (const [id, agent] of Object.entries(cfg.agents)) {
		if (agent.enabled === false) continue;
		const det = detected[id] || { installed: false, version: null };
		// An agent is selectable if installed (for subscription) OR if it has an API key configured
		const ready = det.installed || (agent.authMode === 'apiKey' && Boolean(agent.apiKey));
		list.push({
			id,
			name: agent.name || id,
			enabled: true,
			installed: det.installed,
			ready,
			version: det.version,
			authMode: agent.authMode,
			defaultModel: agent.defaultModel,
			models: agent.allowedModels || [],
			hasEffort: Boolean(agent.hasEffort),
			efforts: agent.efforts || []
		});
	}

	return list;
}
