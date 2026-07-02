// Archive lifecycle tests — the daemon's first test suite. Run: node --test
//
// CODEOUT_HOME is pointed at a temp dir BEFORE importing archive.js (it derives its
// paths at module load), so nothing here can touch a real ~/.codeout.

import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'codeout-archive-test-'));
process.env.CODEOUT_HOME = HOME;

const { archiveMove, listArchives, readArchiveMeta, deleteArchive, summarize, compactTranscript, ARCHIVE_DIR } =
	await import('../archive.js');

before(() => {
	mkdirSync(join(HOME, 'chat'), { recursive: true });
	mkdirSync(join(HOME, 'uploads'), { recursive: true });
});
after(() => rmSync(HOME, { recursive: true, force: true }));

const ev = (o) => JSON.stringify(o) + '\n';

function seedLiveSession(id, events) {
	const log = join(HOME, 'chat', `${id}.jsonl`);
	writeFileSync(log, events.map((e) => ev(e)).join(''));
	const up = join(HOME, 'uploads', id);
	mkdirSync(up, { recursive: true });
	writeFileSync(join(up, 'photo.jpg'), 'jpegbytes');
	return { chatLogFile: log, uploadsPath: up };
}

const REC = { id: 'sess-1', name: 'My chat', avatar: null, cwd: '/tmp', agent: 'claude', model: 'claude-fable-5', effort: 'high', permissionMode: 'default', created: 111, resumeId: 'resume-abc' };

test('archiveMove relocates log + uploads and writes meta', () => {
	const paths = seedLiveSession('sess-1', [
		{ t: 'user', id: 'u1', text: 'build the thing', seq: 0, ts: 1 },
		{ t: 'text', id: 'a1', text: 'done', final: true, seq: 1, ts: 2 }
	]);
	const meta = archiveMove(REC, paths);
	assert.equal(meta.id, 'sess-1');
	assert.equal(meta.summaryStatus, 'pending');
	assert.equal(meta.resumeId, 'resume-abc');
	assert.ok(meta.archivedAt > 0);
	assert.ok(meta.sizeBytes > 0);
	// moved, not copied
	assert.ok(!existsSync(paths.chatLogFile));
	assert.ok(!existsSync(paths.uploadsPath));
	assert.ok(existsSync(join(ARCHIVE_DIR, 'sess-1', 'chat.jsonl')));
	assert.ok(existsSync(join(ARCHIVE_DIR, 'sess-1', 'uploads', 'photo.jpg')));
	// meta round-trips
	assert.deepEqual(readArchiveMeta('sess-1'), meta);
});

test('archiveMove tolerates a session with no uploads and an empty log', () => {
	const meta = archiveMove({ ...REC, id: 'sess-empty' }, {
		chatLogFile: join(HOME, 'chat', 'nope.jsonl'),
		uploadsPath: join(HOME, 'uploads', 'nope')
	});
	assert.equal(meta.summaryStatus, 'pending');
	assert.ok(existsSync(join(ARCHIVE_DIR, 'sess-empty', 'meta.json')));
});

test('archiveMove rejects a path-escaping id', () => {
	assert.throws(() => archiveMove({ ...REC, id: '../evil' }, { chatLogFile: 'x', uploadsPath: 'y' }));
});

test('listArchives returns newest first and skips corrupt meta', () => {
	mkdirSync(join(ARCHIVE_DIR, 'sess-corrupt'), { recursive: true });
	writeFileSync(join(ARCHIVE_DIR, 'sess-corrupt', 'meta.json'), '{nope');
	const list = listArchives();
	const ids = list.map((m) => m.id);
	assert.ok(ids.includes('sess-1') && ids.includes('sess-empty'));
	assert.ok(!ids.includes('sess-corrupt'));
	for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].archivedAt >= list[i].archivedAt);
});

test('summarize runs the runner on a compacted transcript and persists', async () => {
	let seen = null;
	const summary = await summarize('sess-1', {
		runner: async (prompt) => { seen = prompt; return 'Goal: build the thing. State: done.'; }
	});
	assert.equal(summary, 'Goal: build the thing. State: done.');
	assert.ok(seen.includes('User: build the thing'));
	assert.ok(seen.includes('Assistant: done'));
	const meta = readArchiveMeta('sess-1');
	assert.equal(meta.summaryStatus, 'done');
	assert.equal(meta.summary, summary);
	// second call is a no-op returning the stored summary (runner not invoked)
	const again = await summarize('sess-1', { runner: async () => { throw new Error('must not run'); } });
	assert.equal(again, summary);
});

test('summarize failure leaves status pending (retryable)', async () => {
	seedLiveSession('sess-fail', [{ t: 'user', id: 'u1', text: 'hi', seq: 0 }]);
	archiveMove({ ...REC, id: 'sess-fail' }, {
		chatLogFile: join(HOME, 'chat', 'sess-fail.jsonl'), uploadsPath: join(HOME, 'uploads', 'sess-fail')
	});
	const out = await summarize('sess-fail', { runner: async () => { throw new Error('boom'); } });
	assert.equal(out, null);
	assert.equal(readArchiveMeta('sess-fail').summaryStatus, 'pending');
});

test('summarize marks an empty archive done without running the model', async () => {
	const out = await summarize('sess-empty', { runner: async () => { throw new Error('must not run'); } });
	assert.equal(out, null);
	assert.equal(readArchiveMeta('sess-empty').summaryStatus, 'done');
});

test('deleteArchive removes everything; unknown/invalid ids are safe', () => {
	assert.equal(deleteArchive('sess-fail'), true);
	assert.ok(!existsSync(join(ARCHIVE_DIR, 'sess-fail')));
	assert.equal(deleteArchive('sess-fail'), false);   // already gone
	assert.equal(deleteArchive('../evil'), false);      // never joins the path
});

test('compactTranscript stitches deltas, labels tools, skips thinking, caps at tail', () => {
	const out = compactTranscript([
		{ t: 'user', text: 'fix the bug', senderName: 'Law' },
		{ t: 'text', id: 'a', text: 'Look' },
		{ t: 'text', id: 'a', text: 'ing now', final: true },
		{ t: 'thinking', id: 'th', text: 'secret reasoning' },
		{ t: 'tool', id: 't1', name: 'Read', title: 'auth.js', status: 'running' },
		{ t: 'tool', id: 't1', status: 'ok', output: 'lots of bytes' },
		{ t: 'system', text: 'Model switched to fable.' },
		{ t: 'system', text: 'claude-fable-5 · /home/law' },   // init note — excluded
		{ t: 'error', message: 'boom' }
	]);
	assert.ok(out.includes('User (Law): fix the bug'));
	assert.ok(out.includes('Assistant: Looking now'));
	assert.ok(out.includes('[tool] Read: auth.js'));
	assert.ok(out.includes('[system] Model switched to fable.'));
	assert.ok(out.includes('[error] boom'));
	assert.ok(!out.includes('secret reasoning'));
	assert.ok(!out.includes('/home/law'));
	// result emits (no name) don't produce a second tool line
	assert.equal(out.match(/\[tool\] Read/g).length, 1);
	// cap keeps the TAIL
	const capped = compactTranscript([{ t: 'user', text: 'x'.repeat(50) }, { t: 'user', text: 'KEEP-ME' }], 20);
	assert.ok(capped.includes('KEEP-ME'));
	assert.equal(capped.length, 20);
});
