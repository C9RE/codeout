import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGeminiUpdate } from '../gemini-chat.js';

function collect(update) {
	const evs = [], slash = [], meta = [];
	mapGeminiUpdate(update, { emit: (e) => evs.push(e), onSlashCommands: (s) => slash.push(s), onMeta: (m) => meta.push(m) });
	return { evs, slash, meta };
}

test('agent_message_chunk → text (string or {type:text} content)', () => {
	assert.deepEqual(collect({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hi' } }).evs, [{ t: 'text', id: 'm1', text: 'hi' }]);
	assert.deepEqual(collect({ sessionUpdate: 'agent_message_chunk', content: 'yo' }).evs, [{ t: 'text', id: 'msg', text: 'yo' }]);
	assert.deepEqual(collect({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }).evs, []); // empty → nothing
});

test('agent_thought_chunk → thinking', () => {
	assert.deepEqual(collect({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }).evs, [{ t: 'thinking', id: 'thk', text: 'hmm' }]);
});

test('tool_call → tool running; tool_call_update → ok/error', () => {
	assert.deepEqual(collect({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'ls', rawInput: { cmd: 'ls' } }).evs,
		[{ t: 'tool', id: 't1', name: 'execute', title: 'ls', input: { cmd: 'ls' }, status: 'running' }]);
	assert.equal(collect({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: 'done' }).evs[0].status, 'ok');
	assert.equal(collect({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }).evs[0].status, 'error');
	assert.equal(collect({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }).evs[0].status, 'running');
});

test('available_commands_update → slash-commands with daemon builtins', () => {
	const { slash } = collect({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'foo' }, 'bar'] });
	assert.deepEqual(slash[0].commands, ['foo', 'bar']);
	assert.ok(slash[0].builtins.some((b) => b.name === 'model'));
	assert.ok(!slash[0].builtins.some((b) => b.name === 'effort')); // Gemini has no /effort
});

test('usage_update → ctxTokens; unknown/empty variants are no-ops', () => {
	assert.deepEqual(collect({ sessionUpdate: 'usage_update', usage: { totalTokens: 4200 } }).meta, [{ ctxTokens: 4200 }]);
	assert.deepEqual(collect({ sessionUpdate: 'plan' }).evs, []);
	assert.deepEqual(collect({ sessionUpdate: 'user_message_chunk', content: 'x' }).evs, []);
	assert.deepEqual(collect(undefined).evs, []);
});
