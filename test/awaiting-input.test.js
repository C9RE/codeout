// awaitingInput on the sessions list.
//
// `working` is true from turn:start to turn:end, and a permission prompt happens
// MID-turn, so a session blocked on the user reported exactly the same status as one
// that was genuinely thinking. Clients could not tell the two apart and rendered a
// "busy" pulse on a session that was actually waiting for a tap.
//
// These tests pin the state machine the fix depends on: the flag rises when a prompt
// is emitted, falls when it is answered, and cannot be left stranded true when the
// turn dies with prompts still outstanding.

import test from 'node:test';
import assert from 'node:assert';

/** Minimal stand-in for the permission-gate half of sessions.js, same call order. */
function makeGate() {
	const s = {};
	const pendingPermissions = new Map();
	const allowedTools = new Set();
	const emitted = [];
	const emit = (e) => emitted.push(e);
	const syncAwaitingInput = () => { s.awaitingInput = pendingPermissions.size > 0; };
	syncAwaitingInput();   // mirrors sessions.js: the field exists from the start

	const failPendingPermissions = (reason) => {
		for (const [id, p] of pendingPermissions) {
			p.resolve({ behavior: 'deny', message: reason });
			emit({ t: 'permission-resolved', id, decision: 'deny', reason });
		}
		pendingPermissions.clear();
		syncAwaitingInput();
	};

	const onPermission = (req) => {
		if (allowedTools.has(req.toolName)) return Promise.resolve({ behavior: 'allow' });
		return new Promise((resolve) => {
			pendingPermissions.set(req.id, { resolve, toolName: req.toolName });
			syncAwaitingInput();
			emit({ t: 'permission', id: req.id, toolName: req.toolName });
		});
	};

	const handlePermissionReply = (id, decision) => {
		const p = pendingPermissions.get(id);
		if (!p) return;
		pendingPermissions.delete(id);
		syncAwaitingInput();
		if (decision === 'allow_session') allowedTools.add(p.toolName);
		p.resolve(decision === 'deny' ? { behavior: 'deny' } : { behavior: 'allow' });
	};

	// what /api/sessions would publish for this session
	const payload = () => ({ working: !!s.turnLive, awaitingInput: !!s.awaitingInput });

	return { s, onPermission, handlePermissionReply, failPendingPermissions, payload, emitted, allowedTools };
}

test('awaitingInput is false while the agent is merely working', () => {
	const g = makeGate();
	g.s.turnLive = true;
	assert.deepStrictEqual(g.payload(), { working: true, awaitingInput: false });
});

test('a pending prompt raises awaitingInput while working stays true', async () => {
	const g = makeGate();
	g.s.turnLive = true;
	g.onPermission({ id: 'p1', toolName: 'Bash' });
	// This is the whole point: both true, so a client can tell "blocked on you"
	// from "thinking" instead of guessing from `working` alone.
	assert.deepStrictEqual(g.payload(), { working: true, awaitingInput: true });
});

test('answering the prompt clears awaitingInput but not working', async () => {
	const g = makeGate();
	g.s.turnLive = true;
	const decided = g.onPermission({ id: 'p1', toolName: 'Bash' });
	g.handlePermissionReply('p1', 'allow_once');
	assert.deepStrictEqual(await decided, { behavior: 'allow' });
	assert.deepStrictEqual(g.payload(), { working: true, awaitingInput: false });
});

test('two prompts: the flag only drops once BOTH are answered', () => {
	const g = makeGate();
	g.s.turnLive = true;
	g.onPermission({ id: 'p1', toolName: 'Bash' });
	g.onPermission({ id: 'p2', toolName: 'Write' });
	g.handlePermissionReply('p1', 'allow_once');
	assert.strictEqual(g.s.awaitingInput, true, 'still one outstanding');
	g.handlePermissionReply('p2', 'deny');
	assert.strictEqual(g.s.awaitingInput, false);
});

test('a stale reply for an already-resolved id does not disturb the flag', () => {
	const g = makeGate();
	g.s.turnLive = true;
	g.onPermission({ id: 'p1', toolName: 'Bash' });
	g.handlePermissionReply('p1', 'allow_once');
	g.handlePermissionReply('p1', 'deny');   // late duplicate from a reconnecting client
	assert.strictEqual(g.s.awaitingInput, false);
});

test('turn death with prompts outstanding cannot strand awaitingInput true', () => {
	const g = makeGate();
	g.s.turnLive = true;
	g.onPermission({ id: 'p1', toolName: 'Bash' });
	g.onPermission({ id: 'p2', toolName: 'Write' });
	assert.strictEqual(g.s.awaitingInput, true);
	g.failPendingPermissions('backend gone');   // turn end / child death
	g.s.turnLive = false;
	assert.deepStrictEqual(g.payload(), { working: false, awaitingInput: false });
});

test('an auto-allowed tool never raises awaitingInput', async () => {
	const g = makeGate();
	g.s.turnLive = true;
	g.allowedTools.add('Read');
	await g.onPermission({ id: 'p1', toolName: 'Read' });
	assert.strictEqual(g.s.awaitingInput, false);
	assert.strictEqual(g.emitted.length, 0, 'no prompt should have been emitted');
});
