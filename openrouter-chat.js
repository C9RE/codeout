// daemon/openrouter-chat.js — OpenRouter AI coding agent backend for codeout.
//
// Speaks the standard OpenAI-compatible Chat Completions API with Server-Sent Events (SSE) streaming,
// reasoning tokens (<think> / reasoning_content), and native tool calling (view_file, write_to_file,
// replace_file_content, run_command, list_dir).
//
// Normalizes the stream into the codeout ChatEvent union (see daemon/CHAT-EVENTS.md).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, relative, isAbsolute, dirname } from 'node:path';
import { evId, clip } from './chat-events.js';

export const BUILTINS = [
	{ name: 'model', description: 'Switch OpenRouter model (e.g. deepseek/deepseek-r1, anthropic/claude-3.7-sonnet)' },
	{ name: 'mode', description: 'default|acceptEdits|plan|bypassPermissions' },
	{ name: 'clear', description: 'Start a fresh chat' }
];

export const OPENROUTER_SYSTEM_PROMPT = [
	'You are codeout, a powerful, self-hosted AI coding assistant running directly on the user\'s host server.',
	'You have access to tools to view files, write files, make edits, and execute shell commands in the project workspace.',
	'Be conversational, concise, and structured for mobile and desktop screens.',
	'When asking the user to make a choice between discrete options, format the choices as an <options><option>Label</option></options> block so they render as interactive buttons.',
	'Always inspect files first before editing.'
].join(' ');

export const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'view_file',
			description: 'Read file contents from the workspace. Supports line ranges.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the project root or absolute' },
					start_line: { type: 'integer', description: '1-indexed starting line number (optional)' },
					end_line: { type: 'integer', description: '1-indexed ending line number (optional)' }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'write_to_file',
			description: 'Create or completely overwrite a file with the provided content.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the project root or absolute' },
					content: { type: 'string', description: 'Complete content to write to the file' }
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'replace_file_content',
			description: 'Replace an exact target substring within a file with replacement content.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'File path relative to the project root' },
					target: { type: 'string', description: 'Exact substring to replace' },
					replacement: { type: 'string', description: 'Replacement string' }
				},
				required: ['path', 'target', 'replacement']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'run_command',
			description: 'Execute a bash shell command in the project directory.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command line to execute' }
				},
				required: ['command']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List files and subdirectories in a directory.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Directory path relative to the project root (default .)' }
				}
			}
		}
	}
];

export function resolveOpenRouterModel(rawModel) {
	const m = String(rawModel || '').trim();
	if (!m) return 'deepseek/deepseek-r1';
	const lower = m.toLowerCase();
	if (lower === 'r1' || lower === 'deepseek-r1' || lower === 'deepseek/r1') return 'deepseek/deepseek-r1';
	if (lower === 'v3' || lower === 'deepseek-v3' || lower === 'deepseek-chat') return 'deepseek/deepseek-chat';
	if (lower === 'sonnet' || lower === 'claude-sonnet' || lower === 'claude-3.7-sonnet') return 'anthropic/claude-3.7-sonnet';
	if (lower === 'opus' || lower === 'claude-opus') return 'anthropic/claude-3-opus';
	if (lower === 'haiku' || lower === 'claude-haiku') return 'anthropic/claude-3.5-haiku';
	if (lower === 'llama' || lower === 'llama-3.3' || lower === 'llama-70b') return 'meta-llama/llama-3.3-70b-instruct';
	if (lower === 'qwen' || lower === 'qwen-coder') return 'qwen/qwen-2.5-coder-32b-instruct';
	if (lower === 'gemini' || lower === 'gemini-2.5-pro') return 'google/gemini-2.5-pro';
	if (lower === 'flash' || lower === 'gemini-2.5-flash') return 'google/gemini-2.5-flash';
	return m;
}

/**
 * Execute a local tool within cwd.
 */
async function executeTool(name, input, cwd) {
	const resolveFile = (p) => isAbsolute(p) ? p : resolvePath(cwd, p);

	if (name === 'view_file') {
		const target = resolveFile(input.path);
		if (!existsSync(target)) return `Error: File not found: ${input.path}`;
		const content = readFileSync(target, 'utf8');
		const lines = content.split('\n');
		const start = Math.max(1, input.start_line || 1);
		const end = Math.min(lines.length, input.end_line || lines.length);
		const sliced = lines.slice(start - 1, end);
		return sliced.map((line, idx) => `${start + idx}: ${line}`).join('\n');
	}

	if (name === 'write_to_file') {
		const target = resolveFile(input.path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, String(input.content ?? ''), 'utf8');
		return `Successfully wrote ${Buffer.byteLength(input.content || '', 'utf8')} bytes to ${input.path}`;
	}

	if (name === 'replace_file_content') {
		const target = resolveFile(input.path);
		if (!existsSync(target)) return `Error: File not found: ${input.path}`;
		const content = readFileSync(target, 'utf8');
		if (!content.includes(input.target)) return `Error: Target content not found in ${input.path}`;
		const updated = content.replace(input.target, input.replacement);
		writeFileSync(target, updated, 'utf8');
		return `Successfully replaced target content in ${input.path}`;
	}

	if (name === 'list_dir') {
		const target = resolveFile(input.path || '.');
		if (!existsSync(target)) return `Error: Directory not found: ${input.path || '.'}`;
		const entries = readdirSync(target, { withFileTypes: true });
		return entries.map((e) => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`).join('\n');
	}

	if (name === 'run_command') {
		return new Promise((resolve) => {
			const start = Date.now();
			let stdout = '';
			let stderr = '';
			const child = spawn('bash', ['-c', input.command], {
				cwd,
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe']
			});

			child.stdout.on('data', (d) => { stdout += d.toString(); });
			child.stderr.on('data', (d) => { stderr += d.toString(); });

			const timer = setTimeout(() => {
				try { child.kill('SIGKILL'); } catch {}
				resolve(`Command timed out after 60s.\nStdout: ${stdout}\nStderr: ${stderr}`);
			}, 60000);

			child.on('close', (code) => {
				clearTimeout(timer);
				const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n--- stderr ---\n');
				resolve(out || `Command exited with code ${code} (${Date.now() - start}ms)`);
			});

			child.on('error', (err) => {
				clearTimeout(timer);
				resolve(`Error executing command: ${err.message}`);
			});
		});
	}

	return `Error: Unknown tool ${name}`;
}

/**
 * Start an OpenRouter chat session.
 */
export function startOpenRouterChat({
	cwd,
	env,
	resumeId = null,
	model = null,
	effort = null,
	permissionMode = 'default',
	extraSystemPrompt = null,
	emit,
	onSessionId,
	onSlashCommands,
	onMeta,
	onPermission
}) {
	const sessionId = resumeId || `or-${Date.now()}-${evId()}`;
	onSessionId?.(sessionId);
	onSlashCommands?.({ commands: [], builtins: BUILTINS });

	const resolvedModel = resolveOpenRouterModel(model);
	onMeta?.({ model: resolvedModel, apiKeySource: 'openrouter' });

	const apiKey = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
	const baseUrl = env.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

	let killed = false;
	let currentController = null;
	const messages = [];

	const systemPrompt = extraSystemPrompt
		? `${OPENROUTER_SYSTEM_PROMPT}\n\n${extraSystemPrompt}`
		: OPENROUTER_SYSTEM_PROMPT;

	messages.push({ role: 'system', content: systemPrompt });

	async function runTurn(userText) {
		if (killed) return;
		if (userText) messages.push({ role: 'user', content: userText });

		if (!apiKey) {
			emit({ t: 'error', message: 'OpenRouter API key is missing. Set it in the Control Deck or ~/.codeout/config.json.' });
			emit({ t: 'turn', phase: 'end', status: 'error' });
			return;
		}

		let turnDone = false;
		let iteration = 0;
		const maxIterations = 15;

		while (!turnDone && !killed && iteration < maxIterations) {
			iteration++;
			currentController = new AbortController();

			const reqBody = {
				model: resolvedModel,
				messages,
				tools: TOOLS,
				stream: true,
				stream_options: { include_usage: true }
			};

			let response;
			try {
				response = await fetch(`${baseUrl}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`,
						'HTTP-Referer': 'https://codeout.dev',
						'X-Title': 'codeout'
					},
					body: JSON.stringify(reqBody),
					signal: currentController.signal
				});
			} catch (err) {
				if (killed) return;
				emit({ t: 'error', message: `OpenRouter network error: ${err.message}` });
				emit({ t: 'turn', phase: 'end', status: 'error' });
				return;
			}

			if (!response.ok) {
				const errText = await response.text().catch(() => '');
				emit({ t: 'error', message: `OpenRouter HTTP ${response.status}: ${clip(errText, 300)}` });
				emit({ t: 'turn', phase: 'end', status: 'error' });
				return;
			}

			let assistantContent = '';
			let reasoningContent = '';
			const toolCallsMap = new Map(); // index -> { id, name, arguments }
			let inThinkTag = false;
			const textId = evId();
			const thinkId = evId();

			try {
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (!killed) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop(); // keep partial line in buffer

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed || !trimmed.startsWith('data:')) continue;
						const raw = trimmed.slice(5).trim();
						if (raw === '[DONE]') break;

						let chunk;
						try { chunk = JSON.parse(raw); } catch { continue; }

						if (chunk.usage) {
							onMeta?.({
								ctxTokens: chunk.usage.total_tokens || chunk.usage.prompt_tokens,
								costUsd: chunk.usage.cost || null
							});
						}

						const choice = chunk.choices?.[0];
						if (!choice) continue;
						const delta = choice.delta || {};

						// 1. Handle native reasoning content (DeepSeek R1 / OpenAI o1/o3 reasoning deltas)
						const rDelta = delta.reasoning || delta.reasoning_content;
						if (rDelta) {
							reasoningContent += rDelta;
							emit({ t: 'thinking', id: thinkId, text: rDelta });
						}

						// 2. Handle text content + inline <think>...</think> tags
						if (delta.content) {
							let cDelta = delta.content;
							if (cDelta.includes('<think>')) {
								inThinkTag = true;
								cDelta = cDelta.replace('<think>', '');
							}
							if (inThinkTag) {
								if (cDelta.includes('</think>')) {
									const [thinkPart, afterPart] = cDelta.split('</think>');
									if (thinkPart) {
										reasoningContent += thinkPart;
										emit({ t: 'thinking', id: thinkId, text: thinkPart });
									}
									inThinkTag = false;
									if (afterPart) {
										assistantContent += afterPart;
										emit({ t: 'text', id: textId, text: afterPart });
									}
								} else {
									reasoningContent += cDelta;
									emit({ t: 'thinking', id: thinkId, text: cDelta });
								}
							} else {
								assistantContent += cDelta;
								emit({ t: 'text', id: textId, text: cDelta });
							}
						}

						// 3. Handle tool calls delta
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								const idx = tc.index ?? 0;
								const cur = toolCallsMap.get(idx) || { id: tc.id || evId(), name: tc.function?.name || '', arguments: '' };
								if (tc.id) cur.id = tc.id;
								if (tc.function?.name) cur.name = tc.function.name;
								if (tc.function?.arguments) cur.arguments += tc.function.arguments;
								toolCallsMap.set(idx, cur);
							}
						}
					}
				}
			} catch (streamErr) {
				if (killed) return;
				emit({ t: 'error', message: `OpenRouter stream error: ${streamErr.message}` });
				emit({ t: 'turn', phase: 'end', status: 'error' });
				return;
			}

			// Assemble assistant message into conversation history
			const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
				id: tc.id,
				type: 'function',
				function: { name: tc.name, arguments: tc.arguments }
			}));

			const asstMsg = { role: 'assistant', content: assistantContent || null };
			if (toolCalls.length > 0) asstMsg.tool_calls = toolCalls;
			messages.push(asstMsg);

			if (toolCalls.length === 0) {
				turnDone = true;
				emit({ t: 'turn', phase: 'end' });
				break;
			}

			// Execute tool calls
			for (const tc of toolCalls) {
				if (killed) break;
				const toolId = tc.id;
				const name = tc.function.name;
				let parsedArgs = {};
				try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}

				emit({
					t: 'tool',
					id: toolId,
					name,
					status: 'running',
					input: parsedArgs
				});

				// Permission check if not in bypass mode
				if (permissionMode !== 'bypassPermissions' && (name === 'write_to_file' || name === 'replace_file_content' || name === 'run_command')) {
					if (onPermission) {
						try {
							const decision = await onPermission({ id: toolId, toolName: name, input: parsedArgs });
							if (decision?.behavior === 'deny') {
								const reason = decision.message || 'Tool execution denied by user.';
								emit({ t: 'tool', id: toolId, name, status: 'error', output: reason });
								messages.push({ role: 'tool', tool_call_id: toolId, content: `Error: ${reason}` });
								continue;
							}
						} catch (permErr) {
							emit({ t: 'tool', id: toolId, name, status: 'error', output: `Permission error: ${permErr.message}` });
							messages.push({ role: 'tool', tool_call_id: toolId, content: `Error: ${permErr.message}` });
							continue;
						}
					}
				}

				// Execute the tool locally
				const result = await executeTool(name, parsedArgs, cwd);
				emit({
					t: 'tool',
					id: toolId,
					name,
					status: result.startsWith('Error:') ? 'error' : 'ok',
					output: result
				});
				messages.push({ role: 'tool', tool_call_id: toolId, content: result });
			}
		}

		if (iteration >= maxIterations) {
			emit({ t: 'error', message: 'Maximum tool calling iterations reached.' });
			emit({ t: 'turn', phase: 'end' });
		}
	}

	return {
		send: (text) => {
			if (killed) return false;
			runTurn(text).catch((err) => {
				emit({ t: 'error', message: `Unhandled turn error: ${err.message}` });
				emit({ t: 'turn', phase: 'end', status: 'error' });
			});
			return true;
		},
		kill: () => {
			killed = true;
			if (currentController) {
				try { currentController.abort(); } catch {}
				currentController = null;
			}
		},
		child: null
	};
}
