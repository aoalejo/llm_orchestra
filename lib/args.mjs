/** Parseo de flags de CLI. */
export function parseArgs(argv) {
  const out = { task: null, all: false, plan: false, commit: false, yes: false, dryRun: false, verbose: false, selfTest: false, keysStatus: false, keysCheck: false, workers: null, noWorktrees: false, init: false, force: false, stub: false, help: false, models: false, apply: false, json: false, refresh: false, report: false, clean: false, scout: false, dispatch: false, approve: false, reject: false, status: false, usage: false, order: null, ordersFile: null, query: null, scope: null, message: null, reason: null, decisionsRaw: null, provider: null, noCache: false, index: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--plan') out.plan = true;
    else if (a === '--commit') out.commit = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--keys-status') out.keysStatus = true;
    else if (a === '--keys-check') out.keysCheck = true;
    else if (a === '--workers') { const n = Number(argv[++i]); out.workers = Number.isFinite(n) && n > 0 ? n : null; }
    else if (a === '--no-worktrees') out.noWorktrees = true;
    else if (a === '--stub') out.stub = true;
    else if (a === 'models') out.models = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === 'report') out.report = true;
    else if (a === '--clean') out.clean = true;
    else if (a === 'scout') out.scout = true;
    else if (a === 'dispatch') out.dispatch = true;
    else if (a === 'approve') out.approve = true;
    else if (a === 'reject') out.reject = true;
    else if (a === 'status') out.status = true;
    else if (a === 'usage') out.usage = true;
    else if (a === '--order') (out.order ??= []).push(argv[++i]);
    else if (a === '--orders') out.ordersFile = argv[++i];
    else if (a === '--query') out.query = argv[++i];
    else if (a === '--scope') out.scope = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--decisions') out.decisionsRaw = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--no-cache') out.noCache = true;
    else if (a === '--index') out.index = true;
    else if (a === 'init') out.init = true;
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
