// install.mjs - Wire the Malomatia Flow workbench into Devin's global config
// (%APPDATA%\devin on Windows, ~/Library/Application Support/devin on macOS,
// ~/.config/devin on Linux - see scripts/lib/platform.mjs).
// Creates directory links so edits in this repo apply live. No admin rights needed.
// Usage: node install.mjs [--force]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentConfigDir, agentConfigCandidates, linkType, isLink, removeLink, providerRoots } from './scripts/lib/platform.mjs';
import { PROVIDERS, RUN_PROVIDERS, detectProvider } from './dashboard/providers.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const FORCE = process.argv.includes('--force');
const LINK = linkType();

const DEVIN = agentConfigDir();
if (!DEVIN || !fs.existsSync(DEVIN)) {
  console.error(`Devin config directory not found - is Devin installed?`);
  console.error(`  looked in: ${agentConfigCandidates().join(', ')}`);
  console.error('  set DEVIN_CONFIG_DIR if it lives somewhere else.');
  process.exit(1);
}

function installLink(link, target, label) {
  if (fs.existsSync(link) || isLink(link)) {
    let reparse = isLink(link);
    try { reparse = reparse || fs.realpathSync(link) !== path.resolve(link); } catch {}
    if (reparse) {
      removeLink(link); // removes only the link, never target content
      fs.symlinkSync(target, link, LINK);
      console.log(`OK  ${label}: link repointed -> ${target}`);
      return;
    }
    // Real directory: link items individually
    console.log(`INFO ${label}: ${link} is a real directory - linking items individually`);
    for (const name of fs.readdirSync(target)) {
      const childLink = path.join(link, name);
      const childTarget = path.join(target, name);
      if (fs.existsSync(childLink) || isLink(childLink)) {
        let childReparse = isLink(childLink);
        try { childReparse = childReparse || fs.realpathSync(childLink) !== path.resolve(childLink); } catch {}
        if (childReparse) removeLink(childLink);
        else if (FORCE) fs.rmSync(childLink, { recursive: true, force: true });
        else { console.log(`SKIP ${label}: ${name} already exists (use --force to replace)`); continue; }
      }
      const linked = () => {
        try { fs.symlinkSync(childTarget, childLink, fs.statSync(childTarget).isDirectory() ? LINK : 'file'); return true; }
        catch { return false; }
      };
      if (linked()) console.log(`OK  ${label}: link ${name}`);
      else {
        // File symlinks can be refused without developer mode; a copy is the
        // honest fallback (doctor reports it as copied, not linked).
        fs.copyFileSync(childTarget, childLink);
        console.log(`OK  ${label}: copied ${name} (file copy - rerun install after edits)`);
      }
    }
    return;
  }
  fs.symlinkSync(target, link, LINK);
  console.log(`OK  ${label}: link created -> ${target}`);
}

// Where the workbench lives differs per machine, so it must NOT be baked into
// the tracked skill files. Every skill reads WORKBENCH from this local config,
// which is rewritten on each install - clone anywhere, install, done.
const LOCATOR = path.join(DEVIN, 'flowforge.json');

function writeLocator() {
  const body = { workbench: REPO, installedAt: new Date().toISOString() };
  fs.writeFileSync(LOCATOR, JSON.stringify(body, null, 2), 'utf8');
  console.log(`OK  locator: ${LOCATOR} -> ${REPO}`);
}

// Older copies hard-coded an absolute path in the skill text. Strip it so a
// shared clone never carries someone else's machine layout.
function stripHardcodedPaths() {
  const stale = /`(?:[A-Za-z]:\\|\/)[^`\n]*?ai-workbench(?=[`\\/])/g;
  const skillsDir = path.join(REPO, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(stale, '`WORKBENCH');
    if (after !== before) { fs.writeFileSync(file, after, 'utf8'); console.log(`OK  skills: removed hard-coded path from ${name}`); }
  }
}

console.log('Malomatia Flow install');
console.log(`  repo:  ${REPO}`);
console.log(`  devin: ${DEVIN}`);
console.log('');

stripHardcodedPaths();
writeLocator();
console.log('');

installLink(path.join(DEVIN, 'skills'), path.join(REPO, 'skills'), 'skills');
installLink(path.join(DEVIN, 'agents'), path.join(REPO, 'agents'), 'agents');

// ---- every other runnable agent CLI ----
// Each gets the same workbench: the locator so its sessions can find the repo,
// linked skill/agent dirs where its module format matches ours, and a thin
// generated command file per skill where it takes user prompts/commands.
const SKILL_NAMES = fs.readdirSync(path.join(REPO, 'skills'))
  .filter((d) => fs.existsSync(path.join(REPO, 'skills', d, 'SKILL.md')));

// A stub, not a copy of SKILL.md: the canonical text stays in the repo (one
// source of truth, edits are live) and the stub just points the CLI at it.
function promptStub(name, ext) {
  const body = `Read ${path.join(REPO, 'skills', name, 'SKILL.md')} and follow it exactly for the task the user describes.`;
  if (ext === '.toml') return `description = "Malomatia Flow: ${name}"\nprompt = """${body}"""\n`;
  return `---\ndescription: Malomatia Flow ${name}\n---\n${body}\n`;
}

async function installProvider(id) {
  const det = await detectProvider(id).catch(() => null);
  if (!det || !det.installed) { console.log(`SKIP ${id}: not installed`); return; }
  const roots = providerRoots();
  const ovr = process.env['FF_PROVIDER_HOME_' + id.toUpperCase()];
  if (ovr) for (const k of Object.keys(roots)) roots[k] = ovr;
  for (const mod of PROVIDERS[id].userModules || []) {
    const root = roots[mod.base];
    if (!root) continue;
    const p = path.join(root, ...mod.rel);
    if (mod.junctionOf) {
      installLink(p, path.join(REPO, mod.junctionOf), `${id}:${mod.kind}`);
    } else if (mod.kind === 'agent' && mod.type === 'dir') {
      installLink(p, path.join(REPO, 'agents'), `${id}:agents`);
    } else if (mod.kind === 'prompt' && mod.type === 'dir') {
      fs.mkdirSync(p, { recursive: true });
      const ext = (mod.exts || ['.md'])[0];
      for (const name of SKILL_NAMES) {
        fs.writeFileSync(path.join(p, `${name}${ext}`), promptStub(name, ext), 'utf8');
      }
      console.log(`OK  ${id}: ${SKILL_NAMES.length} command files -> ${p}`);
    }
  }
  // The locator sits one level up from the first module path - the provider's
  // own config dir - so a session can always find the workbench.
  const first = (PROVIDERS[id].userModules || [])[0];
  if (first && roots[first.base]) {
    const cfgDir = path.dirname(path.join(roots[first.base], ...first.rel));
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'flowforge.json'),
      JSON.stringify({ workbench: REPO, installedAt: new Date().toISOString() }, null, 2));
    console.log(`OK  ${id}: locator -> ${cfgDir}`);
  }
}

console.log('');
for (const id of RUN_PROVIDERS.filter((x) => x !== 'devin')) await installProvider(id);

// Verify instead of listing: the doctor checks the links, the locator, every
// skill/agent/flow file and the state engine, and names the fix for anything
// wrong. --quick skips the slow probes (CLI login, dashboard) so install stays
// fast; `ff doctor` runs them all.
console.log('');
const doctor = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'doctor.mjs'), '--quick', '--json'], { cwd: REPO, encoding: 'utf8' });
let checks = [];
try { checks = JSON.parse(doctor.stdout).checks; } catch { console.log('WARN doctor could not run - check with: ff doctor'); }
const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: '    ' };
for (const c of checks) console.log(`${mark[c.status] || '    '} ${c.name}: ${c.detail}${c.status !== 'ok' && c.fix ? `  -> ${c.fix}` : ''}`);
console.log('');
// Only broken wiring fails the install; a damaged custom flow is reported but
// must not make start.mjs believe Devin was never wired.
if (checks.some((c) => c.status === 'fail' && /^(Locator|Link:)/.test(c.name))) {
  console.log('Wiring is incomplete (see above). Re-check any time with: ff doctor');
  process.exit(1);
}
console.log('Done. Start a NEW Devin session and try: /flow, /understand, /flow-status, /flow-resume');
console.log('From a terminal: ff run task "<what to do>"   ·   health check: ff doctor');
