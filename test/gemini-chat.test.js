import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGeminiUpdate } from '../gemini-chat.js';

function collect(evt) {
	const evs = [], slash = [], meta = [];
	let sessId = null;
	mapGeminiUpdate(evt, {
		emit: (e) => evs.push(e),
		onSessionId: (s) => { sessId = s; },
		onSlashCommands: (s) => slash.push(s),
		onMeta: (m) => meta.push(m)
	});
	return { evs, slash, meta, sessId };
}

test('init event → captures conversation_id and slash-commands', () => {
	const r = collect({ event: 'init', conversation_id: 'conv-123', init: { cwd: '/tmp', tools: ['view_file'] } });
	assert.equal(r.sessId, 'conv-123');
	assert.equal(r.slash.length, 1);
	assert.ok(r.slash[0].builtins.some((b) => b.name === 'model'));
	assert.ok(r.slash[0].builtins.some((b) => b.name === 'effort'));
});

test('step_update agent_response → text deltas and final close', () => {
	const items = new Map();
	const evs = [];
	const onMeta = [];
	
	// Active delta
	mapGeminiUpdate(
		{ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' } },
		{ emit: (e) => evs.push(e), onMeta: (m) => onMeta.push(m), items }
	);
	assert.deepEqual(evs, [{ t: 'text', id: 'g-msg-2', text: 'Hello ' }]);

	// Done state
	mapGeminiUpdate(
		{ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'world\n', usage: { total_tokens: 1500 } } },
		{ emit: (e) => evs.push(e), onMeta: (m) => onMeta.push(m), items }
	);
	assert.equal(evs.length, 3);
	assert.deepEqual(evs[1], { t: 'text', id: 'g-msg-2', text: 'world\n' });
	assert.deepEqual(evs[2], { t: 'text', id: 'g-msg-2', final: true });
	assert.deepEqual(onMeta, [{ ctxTokens: 1500 }]);
});

test('step_update thinking → thinking stream', () => {
	const r = collect({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'thinking', text_delta: 'Reasoning...' } });
	assert.deepEqual(r.evs, [{ t: 'thinking', id: 'g-thk-1', text: 'Reasoning...' }]);
});

test('step_update tool → running and ok/error', () => {
	const r1 = collect({
		event: 'step_update',
		step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/test' } } }
	});
	assert.deepEqual(r1.evs, [{ t: 'tool', id: 'g-tool-3', name: 'view_file', input: { AbsolutePath: '/tmp/test' }, status: 'running' }]);

	const r2 = collect({
		event: 'step_update',
		step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/test' }, output: 'file contents' } }
	});
	assert.deepEqual(r2.evs, [{ t: 'tool', id: 'g-tool-3', name: 'view_file', input: { AbsolutePath: '/tmp/test' }, status: 'ok', output: 'file contents' }]);
});

test('result event → records token usage', () => {
	const r = collect({ event: 'result', result: { status: 'SUCCESS', usage: { total_tokens: 2500 } } });
	assert.deepEqual(r.meta, [{ ctxTokens: 2500 }]);
});
