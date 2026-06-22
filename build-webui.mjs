// Build the daemon's web UI from the sibling webapp repo and stage it in ./webui.
// The daemon no longer carries its own SvelteKit source - the real UI source of truth
// is ../webapp (adapter-static). This script: (1) builds ../webapp, (2) copies its
// build output (../webapp/build/*) into ./webui, replacing whatever was there.
// Invoked by `bun run build`. Cross-platform (no shell cp), so it works on any host.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webapp = join(here, '..', 'webapp');
const webappBuild = join(webapp, 'build');
const webui = join(here, 'webui');

if (!existsSync(webapp)) {
	console.error(`[build-webui] sibling webapp not found at ${webapp}`);
	console.error('[build-webui] the daemon serves the webapp build; clone/place ../webapp next to ./daemon.');
	process.exit(1);
}

// Build the webapp (bun, per project convention). Inherit stdio so its log is visible.
console.log(`[build-webui] building webapp in ${webapp} ...`);
const r = spawnSync('bun', ['run', 'build'], { cwd: webapp, stdio: 'inherit' });
if (r.status !== 0) {
	console.error(`[build-webui] webapp build failed (exit ${r.status ?? r.signal})`);
	process.exit(r.status || 1);
}
if (!existsSync(webappBuild)) {
	console.error(`[build-webui] expected build output at ${webappBuild}, not found`);
	process.exit(1);
}

// Replace ./webui with the fresh build output.
console.log(`[build-webui] staging ${webappBuild} -> ${webui}`);
rmSync(webui, { recursive: true, force: true });
mkdirSync(webui, { recursive: true });
cpSync(webappBuild, webui, { recursive: true });
console.log('[build-webui] done.');
