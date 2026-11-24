// runner.mjs - the multi-provider pipeline engine.
//
// The classic execution paths ask ONE agent to orchestrate a whole flow in a
// single session (Devin ACP or `devin -p`). This engine is the alternative:
// the dashboard itself walks the flow's stages and spawns one headless CLI
// call per stage (claude -p, codex exec, gemini -p, copilot -p, opencode run,
// auggie --print, devin -p). That buys three things the single-session path
// cannot:
//
//   * any agentic CLI can run a flow - not just Devin;
//   * each stage may run on a different provider + model (stage.provider /
//     stage.model in the flow JSON), so cheap models do cheap work;
//   * the orchestration itself costs zero tokens - routing, loops and gates
//     are plain code here, not an LLM following a skill prompt.
//
// State, gates and artifacts use the SAME files the agent-driven runs use
// (.workbench/state.json, commands.json), so the dashboard UI needs nothing
// new. Zero dependencies (node builtins only).
import { spawn, execFile } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initState, setStage, setFlow, bumpLoop, addLog,
  writeState, readState, drainInbox, summary,
} from '../scripts/lib/state.mjs';
import { killTreeCommand } from '../scripts/lib/platform.mjs';
import {
  PROVIDERS, detectProvider, checkProviderAuth,
  providerRunArgs, providerRunsStages, mapModelToProvider,
} from './providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH = path.resolve(__dirname, '..');
const FLOWS_DIR = path.join(WORKBENCH, 'flows');
const AGENTS_DIR = path.join(WORKBENCH, 'agents');

// A single stage call must terminate; a stalled CLI cannot hold a pipeline
// forever. The whole run is additionally bounded by the caller's stop flag.
const STAGE_TIMEOUT_MS = Math.max(60000, Number(process.env.FF_STAGE_TIMEOUT_MS) || 2 * 3600 * 1000);
const SCRIPT_TIMEOUT_MS = Math.max(10000, Number(process.env.FF_SCRIPT_TIMEOUT_MS) || 10 * 60 * 1000);
const MAX_GATE_ROUNDS = 2;

const STRIP_ANSI = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-Z\\-_]/g;

const GATE_MODES = ['auto', 'terminal', 'dashboard', 'ai'];
const SHIP_MODES = { 1: 'Mode 1 - prepare', 2: 'Mode 2 - commit', 3: 'Mode 3 - push (user approved)' };

// ---------- helpers ----------

async function readTextSafe(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

// Strip YAML frontmatter from a role profile - the block configures the host
// agent's tool registry; the engine only needs the contract text.
function stripFrontmatter(md) {
  return String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function thinkingLine(effort) {
  const e = String(effort || '').toLowerCase();
  if (['max', 'xhigh', 'high'].includes(e)) {
    return 'Thinking level: HIGH - think deeply and enumerate alternatives before acting; verify every assumption against the code.';
  }
  if (e === 'medium') return 'Thinking level: MEDIUM - reason enough to be correct, no exhaustive exploration.';
  if (e) return 'Thinking level: LOW - act directly, minimal deliberation, keep the output short.';
  return '';
}

// ---------- provider process ----------

// A .cmd/.bat shim is just a wrapper around a real script or exe. cmd.exe
// mangles multi-line or quote-heavy args, so we unwrap the shim and spawn its
// target directly - the prompt then reaches the CLI byte-for-byte.
function unwrapBatch(cliPath) {
  const exists = existsSync;
  try {
    const dir = path.dirname(cliPath);
    const body = readFileSync(cliPath, 'utf8').replace(/%~dp0/gi, dir + path.sep);
    for (const m of body.matchAll(/"([^"]+\.(?:js|mjs|cjs|exe|bat|cmd))"/g)) {
      const p = path.resolve(dir, m[1]);
      if (p !== cliPath && exists(p)) return p;
    }
    for (const m of body.matchAll(/([\w\-.\\/]+\\[\w\-.\\/]+\.(?:js|mjs|cjs|exe))(?=\s|$)/g)) {
      const p = path.resolve(dir, m[1]);
      if (p !== cliPath && exists(p)) return p;
    }
  } catch {}
  return null;
}

// Spawn one provider CLI in headless mode, streaming output lines into push().
// Returns { text, code, killed } - text is everything the tool printed.
function spawnProviderCli(id, cliPath, prompt, { model, permissionMode, cwd, timeoutMs, push, procRef }) {
  const args = providerRunArgs(id, { model, permissionMode });
  const batch = /\.(cmd|bat)$/i.test(cliPath);
  const unwrapped = batch ? unwrapBatch(cliPath) : null;
  const viaNode = /\.(mjs|js|cjs)$/i.test(unwrapped || cliPath);
  // cmd.exe ends a command line at the first newline, silently truncating a
  // multi-line prompt on Windows shims - only reachable when a .cmd cannot be
  // unwrapped, so fall back to a flattened prompt there.
  args.push(batch && !unwrapped ? prompt.replace(/\r?\n+/g, ' ') : prompt);
  const cmd = viaNode ? process.execPath : (unwrapped || cliPath);
  const argv = viaNode ? [unwrapped || cliPath, ...args] : args;
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
      detached: process.platform !== 'win32',
    });
    if (procRef) procRef.proc = proc;
    let out = '';
    let killed = false;
    let settled = false;
    const lineBuf = { cur: '' };
    const feed = (d) => {
      out += d;
      const text = String(d).replace(STRIP_ANSI, '');
      lineBuf.cur += text;
      let i;
      while ((i = lineBuf.cur.indexOf('\n')) >= 0) {
        const line = lineBuf.cur.slice(0, i);
        lineBuf.cur = lineBuf.cur.slice(i + 1);
        if (line.trim()) push(line);
      }
    };
    const kill = () => {
      killed = true;
      const tree = killTreeCommand(proc.pid);
      try {
        if (tree) execFile(tree.cmd, tree.args, { windowsHide: true }, () => {});
        else { try { process.kill(-proc.pid, 'SIGTERM'); } catch { process.kill(proc.pid, 'SIGTERM'); } }
      } catch {}
    };
    const timer = setTimeout(() => { push(`[engine] stage call timed out after ${Math.round(timeoutMs / 60000)}min`); kill(); }, timeoutMs);
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ text: out + `\nspawn error: ${e.message}`, code: 1, killed }); } });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (lineBuf.cur.trim()) push(lineBuf.cur);
      resolve({ text: out, code: code ?? 1, killed });
    });
  });
}

// One script call (pre/post), same streaming contract as provider CLIs.
function runScript(script, project, push, procRef) {
  const file = path.join(WORKBENCH, script);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [file, project], {
      cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      detached: process.platform !== 'win32',
    });
    if (procRef) procRef.proc = proc;
    let out = '';
    const feed = (d) => { out += d; for (const l of String(d).replace(STRIP_ANSI, '').split(/\r?\n/)) if (l.trim()) push(l); };
    const timer = setTimeout(() => {
      const tree = killTreeCommand(proc.pid);
      try { if (tree) execFile(tree.cmd, tree.args, { windowsHide: true }, () => {}); else process.kill(proc.pid, 'SIGTERM'); } catch {}
    }, SCRIPT_TIMEOUT_MS);
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ out: `${out}\n${e.message}`, code: 1 }); });
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ out, code: code ?? 1 }); });
  });
}

// ---------- prompt assembly ----------

async function roleProfile(agent) {
  if (!agent) return '';
  const md = await readTextSafe(path.join(AGENTS_DIR, `${agent}.md`));
  return stripFrontmatter(md || `You are the "${agent}" stage of an engineering pipeline. Do the stage's work exactly and write the artifact it names.`);
}

function fillPlaceholders(text, ctx) {
  return String(text || '')
    .replace(/\{TASK\}/g, ctx.task)
    .replace(/\{PROJECT\}/g, ctx.project)
    .replace(/\{WORKBENCH\}/g, WORKBENCH)
    .replace(/\{SHIP_MODE\}/g, ctx.shipMode);
}

// The full one-shot prompt a stage CLI receives: role contract + stage goal +
// the mechanical contract the engine parses afterwards.
async function buildStagePrompt(stage, st, ctx) {
  const parts = [];
  const think = thinkingLine(st.effort || stage.effort);
  if (think) parts.push(think);
  if (stage.agent) {
    parts.push(`You are "${stage.agent}" - one stage of a staged engineering pipeline running inside ${ctx.project}.`);
    parts.push(await roleProfile(stage.agent));
  }
  parts.push('---');
  parts.push('Stage instructions (authoritative for this stage):');
  parts.push(fillPlaceholders(stage.prompt || '', ctx));
  parts.push(`Task: ${ctx.task}`);
  parts.push(`Project root: ${ctx.project}. Work inside it.`);
  if (stage.artifact) parts.push(`Write your deliverable to ${path.join(ctx.project, '.workbench', 'artifacts', stage.artifact)} (create folders as needed).`);
  parts.push(`The workbench lives at ${WORKBENCH}. Helper scripts run as: node "${path.join(WORKBENCH, 'scripts', '<name>.mjs')}" "${ctx.project}"`);
  parts.push('Never kill processes (Stop-Process/taskkill/kill) and never stop or restart the Malomatia Flow dashboard or any running server - this pipeline is hosted by that process, so killing it aborts the run.');
  parts.push(`If a file deliverable is needed (PDF, Word, Excel, CSV, HTML, TXT, Markdown, JSON), never write your own converter and never add a library: run \`node "${path.join(WORKBENCH, 'scripts', 'convert-doc.mjs')}" "<document>" --to <format> [--out <path>]\` (run it with --formats to list formats). Write the document as Markdown first - tables in Markdown table syntax become real tables in pdf/docx/html and real rows in xlsx/csv.`);
  if (ctx.inbox) parts.push(`INBOX - direct instructions from the user, honor them:\n${ctx.inbox}`);
  if (ctx.sizingNote) parts.push(ctx.sizingNote);
  if (ctx.retryNote) parts.push(ctx.retryNote);
  if (ctx.feedback) parts.push(`Reviewer feedback to address:\n${ctx.feedback}`);
  parts.push(stage.onFail
    ? 'End your reply with a line "RESULT: <one-line outcome>" and make sure the artifact carries a "Verdict: PASS" or "Verdict: FAIL" line.'
    : 'End your reply with one line: RESULT: <one-line outcome>');
  return parts.join('\n\n');
}

// ---------- verdict + done-criteria ----------

function parseVerdict(stage, artifactText, cliText) {
  if (!stage.onFail) return null;
  // The artifact wins on conflict (it is the durable record); stdout second.
  for (const src of [artifactText, cliText]) {
    if (!src) continue;
    const m = String(src).match(/verdict\s*:\s*(PASS|FAIL|APPROVE|REVISE)/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Mechanical done-criteria: the artifact exists and is non-trivial; a verdict
// stage must also carry a Verdict line. The LLM-level judgement lives in the
// critic / tester stages, not in this check.
async function artifactOk(project, stage) {
  if (!stage.artifact) return { ok: true };
  const file = path.join(project, '.workbench', 'artifacts', stage.artifact);
  const text = await readTextSafe(file);
  if (!text || !text.trim()) return { ok: false, missing: `artifact ${stage.artifact} missing or empty` };
  if (stage.onFail && !/verdict\s*:/i.test(text)) return { ok: false, missing: `artifact ${stage.artifact} has no Verdict line` };
  return { ok: true, text };
}

// ---------- gates ----------

function effectiveGate(stage, spec, settings, flowDef) {
  if (spec.gates && GATE_MODES.includes(spec.gates)) return spec.gates;
  if (stage.gate && stage.gate !== 'default' && GATE_MODES.includes(stage.gate)) return stage.gate;
  const sm = settings && settings.gateMode;
  if (sm && sm !== 'default' && GATE_MODES.includes(sm)) return sm;
  return GATE_MODES.includes(flowDef.defaultGate) ? flowDef.defaultGate : 'terminal';
}

async function aiGate(stage, st, ctx, io, round, feedback) {
  const criticPrompt = [
    `You are "critic" - the independent reviewer at an AI-review gate of a staged pipeline in ${ctx.project}.`,
    await roleProfile('critic'),
    '---',
    `Stage goal: ${fillPlaceholders(stage.prompt || '', ctx)}`,
    `Task: ${ctx.task}`,
    `Done criteria:\n${(stage.done || []).map((d) => `- ${d}`).join('\n') || '- (none listed)'}`,
    `Artifact: ${path.join(ctx.project, '.workbench', 'artifacts', stage.artifact || '')}`,
    feedback ? `Previous review issues (verify they are fixed):\n${feedback}` : '',
    'Judge the artifact against the stage goal and done criteria. End your reply with EXACTLY one line: VERDICT: APPROVE or VERDICT: REVISE preceded by numbered concrete issues.',
  ].filter(Boolean).join('\n\n');
  io.push(`[gate:ai] review round ${round} for "${stage.id}"`);
  const r = await io.providerCall(ctx.criticProvider || ctx.provider, criticPrompt, { model: ctx.criticModel });
  const m = r.text.match(/verdict\s*:\s*(APPROVE|REVISE)/i);
  const issues = (r.text.match(/^\s*\d+[.)]\s+.+$/gm) || []).slice(0, 10).join('\n');
  return { verdict: m ? m[1].toUpperCase() : 'APPROVE', issues, text: r.text };
}

// ---------- provider resolution ----------

async function resolveCli(providerId, io) {
  const det = await detectProvider(providerId, io.project);
  if (!det.cliPath) return { err: `${providerId}: CLI not found` };
  const auth = await checkProviderAuth(providerId, det);
  const kind = PROVIDERS[providerId].auth && PROVIDERS[providerId].auth.kind;
  // kind 'none' providers run on the user's API keys - there is nothing to check.
  if (!auth.loggedIn && kind !== 'none') return { err: `${providerId}: not logged in (connect it from the Providers tab)` };
  return { cliPath: det.cliPath };
}

// ---------- the pipeline ----------

export async function runPipeline(opts) {
  const { project, spec, push, shouldStop, requestGate } = opts;
  const procRef = opts.procRef || { proc: null };
  const flowName = spec.flow;
  const flowFile = path.join(FLOWS_DIR, `${flowName}.json`);
  let flowDef;
  try { flowDef = JSON.parse(await fs.readFile(flowFile, 'utf8')); }
  catch { return { code: 1, error: `flow not found: ${flowName}` }; }

  const settings = (await (async () => { try { return JSON.parse(await fs.readFile(path.join(project, '.workbench', 'settings.json'), 'utf8')); } catch { return null; } })()) || {};
  const task = String(spec.task || '').trim();
  const provider = spec.provider;
  const size = ['tiny', 'small', 'full'].includes(spec.size) ? spec.size : 'auto';
  const speed = spec.speed === 'flow' ? '' : spec.speed;

  // initState resolves sizes, --speed model overrides, jump-only stages.
  const gateDefault = GATE_MODES.includes(spec.gates) ? spec.gates : 'dashboard';
  const state = initState(flowDef, {
    task, taskRaw: spec.taskRaw || task, project,
    gateMode: gateDefault, speed: speed || '', size: size === 'auto' ? 'full' : size,
    flowFile,
  });
  state.engine = { provider, startedBy: 'dashboard-runner' };
  writeState(project, state);
  push(`[engine] ${flowName} on ${provider} (gates ${gateDefault}, size ${state.size}${speed ? `, speed ${speed}` : ''})`);

  const stageDefs = flowDef.stages || [];
  const stageState = (id) => state.stages.find((s) => s.id === id);
  const save = () => writeState(project, state);
  let shipMode = SHIP_MODES[spec.shipMode] || SHIP_MODES[2];
  const ctx = {
    project, task, provider, shipMode,
    inbox: '', sizingNote: '', retryNote: '', feedback: '',
    criticProvider: spec.criticProvider || null, criticModel: spec.criticModel || null,
  };

  // One provider call wrapper every stage/gate goes through.
  const io = {
    project,
    push,
    providerCall: async (pid, prompt, { model } = {}) => {
      const useId = providerRunsStages(pid) ? pid : provider;
      const { cliPath, err } = await resolveCli(useId, io);
      if (err) return { text: `provider_error: ${err}`, code: 1 };
      const mapped = model ? mapModelToProvider(model, useId) : '';
      const res = await spawnProviderCli(useId, cliPath, prompt, {
        model: mapped, permissionMode: spec.permissionMode || 'dangerous',
        cwd: project, timeoutMs: STAGE_TIMEOUT_MS, push, procRef,
      });
      return res;
    },
  };

  const fail = async (stageId, why, whyAr) => {
    setStage(state, stageId, 'failed', { note: why, noteAr: whyAr || why });
    setFlow(state, 'failed');
    save();
    push(`[engine] FAIL ${stageId}: ${why}`);
    return { code: 1, error: why };
  };

  // Skipped preparation stages: every later stage is told what does not exist.
  const skippedIds = state.stages.filter((s) => s.status === 'skipped' && s.note.startsWith('skipped:')).map((s) => s.id);
  if (skippedIds.length) {
    ctx.sizingNote = `Sizing: ${state.size} - the ${skippedIds.join(', ')} stage(s) did not run, so their artifacts do not exist. Work from the task text and the code directly, and put a 3-line mini-plan (what, where, how to verify) at the top of your own artifact.`;
  }

  let cursor = 0;
  let jumpTo = null; // stage id a FAIL/next targeted
  while (cursor < stageDefs.length) {
    if (shouldStop && shouldStop()) { setFlow(state, 'stopped'); save(); push('[engine] stopped by user'); return { code: 1, error: 'stopped' }; }
    const stage = stageDefs[cursor];
    const st = stageState(stage.id);
    // jump-only stages are skipped in normal order unless a jump targeted them.
    if (st.status === 'skipped' && jumpTo !== stage.id) { cursor++; continue; }
    jumpTo = null;

    // Inbox: drained at every stage boundary and handed to the stage verbatim.
    ctx.inbox = drainInbox(project) || '';
    if (ctx.inbox) { addLog(state, `inbox delivered to ${stage.id}: ${ctx.inbox.slice(0, 120)}`); push(`[inbox] ${ctx.inbox.slice(0, 160)}`); }

    setStage(state, stage.id, 'running');
    save();
    push(`[stage] ${stage.id} (${stage.agent || 'script'}) running${st.model ? ` - ${st.model}` : ''}`);

    // ----- pre scripts -----
    let preFailed = null;
    for (const s of stage.pre || []) {
      push(`[pre] ${s}`);
      const r = await runScript(s, project, push, procRef);
      if (r.code !== 0 && !/SKIPPED/i.test(r.out)) { preFailed = `${s} exited ${r.code}`; break; }
    }
    if (preFailed) {
      const r = await fail(stage.id, `pre-script failed: ${preFailed}`);
      return r;
    }

    // ----- gates that precede the work: the ship gate chooses SHIP_MODE -----
    const gateMode = effectiveGate(stage, spec, settings, flowDef);
    const isShip = stage.agent === 'shipper' || stage.id === 'ship';
    if (isShip && (gateMode === 'dashboard' || gateMode === 'terminal') && requestGate) {
      setStage(state, stage.id, 'waiting_gate');
      save();
      const g = await requestGate(stage.id, stage.gateQuestion || 'Ship how far?', stage.gateQuestionAr || '');
      if (!g || g.decision === 'reject') {
        setStage(state, stage.id, 'running');
        return fail(stage.id, `gate rejected${g && g.note ? `: ${g.note}` : ''}`);
      }
      const note = (g.note || '').toLowerCase();
      shipMode = /push/.test(note) ? SHIP_MODES[3] : /prepare|only/.test(note) ? SHIP_MODES[1] : SHIP_MODES[2];
      ctx.shipMode = shipMode;
      setStage(state, stage.id, 'running');
      addLog(state, `ship gate answered - ${shipMode}`);
      save();
    }

    // ----- agent work (skipped for agent:null script stages) -----
    let verdict = null;
    let stageOut = '';
    if (stage.agent) {
      const useProvider = providerRunsStages(stage.provider) ? stage.provider : provider;
      let attempt = 0;
      let check = { ok: false, missing: 'not run' };
      let artifactText = null;
      ctx.retryNote = '';
      ctx.feedback = '';
      while (attempt < 2) {
        attempt++;
        const prompt = await buildStagePrompt(stage, st, ctx);
        push(`[cli] ${useProvider} -> ${stage.id}${st.model ? ` (${mapModelToProvider(st.model, useProvider)})` : ''}`);
        const call = await io.providerCall(useProvider, prompt, { model: st.model });
        stageOut = call.text;
        if (call.killed && shouldStop && shouldStop()) { setFlow(state, 'stopped'); save(); return { code: 1, error: 'stopped' }; }
        check = await artifactOk(project, stage);
        artifactText = check.text || null;
        if (check.ok) break;
        push(`[engine] ${stage.id}: ${check.missing}${attempt === 1 ? ' - retrying once' : ''}`);
        ctx.retryNote = `Your previous reply did not satisfy the stage contract: ${check.missing}. Produce it now.`;
      }
      if (!check.ok) return fail(stage.id, `done-criteria unmet: ${check.missing}`);
      verdict = parseVerdict(stage, artifactText, stageOut);
    }

    // ----- post scripts -----
    for (const s of stage.post || []) {
      push(`[post] ${s}`);
      const r = await runScript(s, project, push, procRef);
      if (r.code !== 0 && !/SKIPPED/i.test(r.out)) return fail(stage.id, `post-script failed: ${s} exited ${r.code}`);
    }

    // ----- verdict routing (onFail loops) -----
    if (stage.onFail && verdict === 'FAIL') {
      const loop = bumpLoop(state, stage.id);
      setStage(state, stage.id, 'failed', { note: 'tester FAIL - routing to debug', noteAr: 'الاختبار فشل - بنروّح للتصحيح' });
      addLog(state, `${stage.id} FAIL -> ${stage.onFail} (loop ${loop.count}/${loop.max})`);
      save();
      push(`[verdict] ${stage.id}: FAIL -> ${stage.onFail} (loop ${loop.count}/${loop.max})`);
      if (loop.exceeded) { setFlow(state, 'failed'); save(); return { code: 1, error: `${stage.id}: loops exhausted` }; }
      const target = stageDefs.findIndex((x) => x.id === stage.onFail);
      if (target < 0) return fail(stage.id, `onFail target "${stage.onFail}" not in flow`);
      // The jump target runs next even though init marked it skipped.
      const tst = stageState(stage.onFail);
      tst.status = 'pending';
      jumpTo = stage.onFail;
      cursor = target;
      continue;
    }

    // ----- gate at stage end -----
    if (gateMode === 'auto') {
      addLog(state, `${stage.id}: gate auto-approved`);
    } else if (gateMode === 'ai') {
      for (let round = 1; round <= MAX_GATE_ROUNDS; round++) {
        const g = await aiGate(stage, st, ctx, io, round, ctx.feedback);
        push(`[gate:ai] ${stage.id} round ${round} -> ${g.verdict}`);
        addLog(state, `${stage.id}: ai review round ${round} -> ${g.verdict}`);
        if (g.verdict === 'APPROVE' || round === MAX_GATE_ROUNDS) break;
        ctx.feedback = g.issues;
        // Re-run the stage once with the issues to fix, then review again.
        ctx.retryNote = '';
        const prompt = await buildStagePrompt(stage, st, ctx);
        const useProvider = providerRunsStages(stage.provider) ? stage.provider : provider;
        await io.providerCall(useProvider, prompt, { model: st.model });
        save();
      }
    } else if ((gateMode === 'dashboard' || gateMode === 'terminal') && requestGate && !isShip) {
      setStage(state, stage.id, 'waiting_gate');
      save();
      push(`[gate] ${stage.id}: waiting for a decision (${gateMode})`);
      const g = await requestGate(stage.id, stage.gateQuestion || `Continue after "${stage.title || stage.id}"?`, stage.gateQuestionAr || '');
      if (!g || g.decision === 'reject') {
        setStage(state, stage.id, 'running');
        addLog(state, `${stage.id}: gate rejected${g && g.note ? ` - ${g.note}` : ''}`);
        save();
        if (g && g.note) {
          // Re-run once with the note as feedback (gate reject does not burn a loop).
          ctx.feedback = `Gate reviewer rejected the stage with this note - address it:\n${g.note}`;
          ctx.retryNote = '';
          const prompt = await buildStagePrompt(stage, st, ctx);
          const useProvider = providerRunsStages(stage.provider) ? stage.provider : provider;
          await io.providerCall(useProvider, prompt, { model: st.model });
          ctx.feedback = '';
          const recheck = await artifactOk(project, stage);
          if (!recheck.ok) return fail(stage.id, `done-criteria unmet after gate retry: ${recheck.missing}`);
        } else {
          return fail(stage.id, 'gate rejected');
        }
      }
      addLog(state, `${stage.id}: gate approved`);
    }

    setStage(state, stage.id, 'done', {
      note: st.note && st.note.startsWith('ai review:') ? st.note : `${stage.artifact || 'done'} produced`,
      noteAr: 'تمت المرحلة',
    });
    save();
    push(`[stage] ${stage.id} done`);

    // A stage's `next` (e.g. debug -> test) jumps back in the flow.
    if (stage.next) {
      const target = stageDefs.findIndex((x) => x.id === stage.next);
      if (target >= 0) { stageState(stage.next).status = 'pending'; jumpTo = stage.next; cursor = target; continue; }
    }
    cursor++;
  }

  setFlow(state, 'done');
  save();
  push('[engine] flow complete');
  return { code: 0, summary: summary(readState(project)) };
}
