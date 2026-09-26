import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOpenRouterModel, BUILTINS, TOOLS, OPENROUTER_SYSTEM_PROMPT } from '../openrouter-chat.js';

test('resolveOpenRouterModel resolves aliases, shorthands, and defaults', () => {
	// Defaults & fallbacks
	assert.equal(resolveOpenRouterModel(''), 'deepseek/deepseek-r1');
	assert.equal(resolveOpenRouterModel(null), 'deepseek/deepseek-r1');
	assert.equal(resolveOpenRouterModel(undefined), 'deepseek/deepseek-r1');

	// DeepSeek R1 & V3
	assert.equal(resolveOpenRouterModel('r1'), 'deepseek/deepseek-r1');
	assert.equal(resolveOpenRouterModel('deepseek-r1'), 'deepseek/deepseek-r1');
	assert.equal(resolveOpenRouterModel('deepseek/r1'), 'deepseek/deepseek-r1');
	assert.equal(resolveOpenRouterModel('v3'), 'deepseek/deepseek-chat');
	assert.equal(resolveOpenRouterModel('deepseek-v3'), 'deepseek/deepseek-chat');
	assert.equal(resolveOpenRouterModel('deepseek-chat'), 'deepseek/deepseek-chat');

	// Anthropic
	assert.equal(resolveOpenRouterModel('sonnet'), 'anthropic/claude-3.7-sonnet');
	assert.equal(resolveOpenRouterModel('claude-sonnet'), 'anthropic/claude-3.7-sonnet');
	assert.equal(resolveOpenRouterModel('claude-3.7-sonnet'), 'anthropic/claude-3.7-sonnet');
	assert.equal(resolveOpenRouterModel('opus'), 'anthropic/claude-3-opus');
	assert.equal(resolveOpenRouterModel('haiku'), 'anthropic/claude-3.5-haiku');

	// Meta Llama
	assert.equal(resolveOpenRouterModel('llama'), 'meta-llama/llama-3.3-70b-instruct');
	assert.equal(resolveOpenRouterModel('llama-3.3'), 'meta-llama/llama-3.3-70b-instruct');
	assert.equal(resolveOpenRouterModel('llama-70b'), 'meta-llama/llama-3.3-70b-instruct');

	// Qwen
	assert.equal(resolveOpenRouterModel('qwen'), 'qwen/qwen-2.5-coder-32b-instruct');
	assert.equal(resolveOpenRouterModel('qwen-coder'), 'qwen/qwen-2.5-coder-32b-instruct');

	// Google Gemini
	assert.equal(resolveOpenRouterModel('gemini'), 'google/gemini-2.5-pro');
	assert.equal(resolveOpenRouterModel('gemini-2.5-pro'), 'google/gemini-2.5-pro');
	assert.equal(resolveOpenRouterModel('flash'), 'google/gemini-2.5-flash');

	// Pass-through arbitrary OpenRouter model ids
	assert.equal(resolveOpenRouterModel('mistralai/mistral-large-2411'), 'mistralai/mistral-large-2411');
	assert.equal(resolveOpenRouterModel('openai/o3-mini'), 'openai/o3-mini');
});

test('openrouter metadata and tools schema verification', () => {
	assert.ok(Array.isArray(BUILTINS));
	assert.ok(BUILTINS.some((b) => b.name === 'model'));
	assert.ok(BUILTINS.some((b) => b.name === 'mode'));
	assert.ok(BUILTINS.some((b) => b.name === 'clear'));

	assert.ok(typeof OPENROUTER_SYSTEM_PROMPT === 'string' && OPENROUTER_SYSTEM_PROMPT.length > 50);

	assert.ok(Array.isArray(TOOLS));
	const toolNames = TOOLS.map((t) => t.function?.name);
	assert.ok(toolNames.includes('view_file'));
	assert.ok(toolNames.includes('write_to_file'));
	assert.ok(toolNames.includes('replace_file_content'));
	assert.ok(toolNames.includes('run_command'));
	assert.ok(toolNames.includes('list_dir'));

	for (const tool of TOOLS) {
		assert.equal(tool.type, 'function');
		assert.ok(tool.function.name);
		assert.ok(tool.function.description);
		assert.equal(tool.function.parameters.type, 'object');
	}
});
