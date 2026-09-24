import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extensión de pi que expone el Lean Orchestrator.
 *
 * Comando:
 *   /orchestra <args>            (init / models / report / --clean / --self-test / ...)
 *
 * Tools (el orquestador es el chat):
 *   orchestra_scout     — recon barato del codebase (no gasta el contexto del chat)
 *   orchestra_dispatch  — corre 1..N work orders en paralelo y devuelve un resumen compacto
 *   orchestra_approve   — aprueba e integra una tarea en `needs-approval`
 *   orchestra_reject    — descarta una tarea
 *   orchestra_status    — estado de las tareas
 *   orchestra_models    — ranking/rotación de modelos
 *   orchestra_report    — costo/uso desde el ledger
 *
 * Todo delega en `orchestra.mjs` (este paquete); la extensión sólo lo invoca con --json
 * y devuelve el JSON compacto al modelo.
 */

const DRIVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestra.mjs");

// Timers de widget por contexto de comando (para poder apagarlo).
const dashboards = new Map<any, any>();

function globToRegExp(glob: string): RegExp {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`, "i");
}
function matchGlob(p: string, g: string): boolean {
  const pp = String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const gg = String(g || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (globToRegExp(gg).test(pp)) return true;
  if (gg.startsWith("**/") && globToRegExp(gg.slice(3)).test(pp)) return true;
  return false;
}
const denyReadHit = (p: string, pats: string[]) => (pats || []).some((g) => matchGlob(p, g));
const denyCommandHit = (cmd: string, pats: string[]) => (pats || []).some((re) => { try { return new RegExp(re, "i").test(cmd); } catch { return false; } });
function appendCommandLog(role: string, cmd: string) {
  const log = process.env.ORCHESTRA_LOG;
  if (!log) return;
  try {
    fs.appendFileSync(path.join(path.dirname(log), `${role || "worker"}.commands.log`), `${new Date().toISOString()} ${cmd.replace(/\s+/g, " ").slice(0, 300)}\n`);
  } catch { /* noop */ }
}

function runDriver(argv: string[], cwd: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [DRIVER, ...argv], { cwd, stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    } catch {
      resolve(1);
    }
  });
}

/** Invoca el driver con --json, captura stdout y parsea el JSON. */
function runDriverJson(argv: string[], cwd: string, signal?: AbortSignal): Promise<{ data: any; raw: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [DRIVER, ...argv, "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => reject(e));
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* noop */ } };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const text = out.trim();
      const start = text.indexOf("{");
      if (!text || start === -1) {
        return reject(new Error(`orchestra ${argv[0]} exit ${code}: ${(text + "\n" + err).slice(-800)}`));
      }
      try {
        resolve({ data: JSON.parse(text.slice(start)), raw: text, stderr: err, code: code ?? 0 });
      } catch {
        reject(new Error(`salida no-JSON de orchestra ${argv[0]} (exit ${code}): ${(text + "\n" + err).slice(-800)}`));
      }
    });
  });
}

/** Ejecuta el driver y devuelve su stdout como líneas (para el panel). */
function spawnLines(argv: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [DRIVER, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.on("close", () => resolve(out.split(/\r?\n/).filter((l) => l.trim().length > 0)));
      child.on("error", () => resolve([]));
    } catch { resolve([]); }
  });
}

/**
 * Mientras corre una orden larga, refresca un widget con el dashboard
 * (`--plain --no-usage`, sin red) y streamea lo mismo por `onUpdate`.
 */
async function withProgress(ctx: any, cwd: string, onUpdate: any, label: string, fn: () => Promise<any>, intervalMs = 2500) {
  const ui = ctx?.ui;
  let stopped = false;
  const refresh = async () => {
    if (stopped) return;
    const lines = await spawnLines(["dashboard", "--once", "--plain", "--no-usage"], cwd);
    if (stopped || !lines.length) return;
    try { ui?.setWidget?.("orchestra", lines, { placement: "belowEditor" }); } catch { /* noop */ }
    onUpdate?.(text(lines.join("\n")));
  };
  try { ui?.setStatus?.("orchestra", label); } catch { /* noop */ }
  refresh();
  const timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fn();
  } finally {
    stopped = true;
    clearInterval(timer);
    try { ui?.setWidget?.("orchestra", undefined); ui?.setStatus?.("orchestra", undefined); } catch { /* noop */ }
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export default function orchestraExtension(pi: ExtensionAPI) {
  // Guards para subagentes (T-05/T-12): la extensión se carga también en los `pi`
  // headless, así que este hook aplica a los workers. Sólo actúa si el driver
  // exportó ORCHESTRA_ROLE (evita tocar tu sesión interactiva).
  pi.on("tool_call", async (event: any) => {
    const role = process.env.ORCHESTRA_ROLE;
    if (!role) return;
    let guards: any = {};
    try { guards = JSON.parse(process.env.ORCHESTRA_GUARDS || "{}"); } catch { return; }
    const input: any = event?.input || {};
    if (event?.toolName === "bash") {
      const cmd = String(input.command || "");
      if (guards.denyCommands?.length && denyCommandHit(cmd, guards.denyCommands)) {
        return { block: true, reason: `[orchestra] comando bloqueado por guards (rol ${role})` };
      }
      for (const g of guards.denyRead || []) {
        const token = String(g).replace(/\*+/g, "").replace(/^\/+/, "");
        if (token.includes("/") && token.length >= 6 && cmd.includes(token)) {
          return { block: true, reason: `[orchestra] bash toca ruta denegada (${token})` };
        }
      }
      if (guards.logCommands) appendCommandLog(role, cmd);
    }
    const p = input.path || input.pattern || input.query || input.file || "";
    if (p && guards.denyRead?.length && denyReadHit(String(p), guards.denyRead)) {
      return { block: true, reason: `[orchestra] lectura denegada por guards: ${p}` };
    }
    return;
  });

  pi.registerCommand("orchestra", {
    description: "Lean Orchestrator: init / models / report / --clean / --self-test (multi-modelo)",
    getArgumentCompletions: (prefix) => {
      const options = ["init", "models", "models --apply", "report", "scout", "dispatch", "approve", "reject", "status", "usage", "--clean", "--plan", "--keys-status", "--keys-check", "--self-test", "--all", "--stub", "--no-worktrees", "--task ", "--help"];
      const filtered = options.filter((o) => o.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const argv = args.trim() ? args.trim().split(/\s+/) : ["--keys-status"];
      const code = await runDriver(argv, cwd);
      ctx.ui.notify(`orchestra ${argv.join(" ")} → exit ${code}`, code === 0 ? "info" : "error");
    },
  });

  pi.registerTool({
    name: "orchestra_scout",
    label: "Orchestra Scout",
    description: "Reconocimiento barato del codebase con un modelo worker. Devuelve un mapa comprimido (path:line — descripción) sin gastar el contexto del chat.",
    promptSnippet: "Recon barato del codebase (scout) que no gasta tu contexto",
    promptGuidelines: ["Use orchestra_scout para reconocer el codebase antes de despachar trabajo pesado."],
    parameters: Type.Object({
      query: Type.String({ description: "Qué investigar (en lenguaje natural)" }),
      task: Type.Optional(Type.String({ description: "id de tarea existente, para usar su acceptance/scope" })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "rutas/globs a priorizar" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.(text(`scout: ${params.query}`));
      const argv = ["scout", "--query", params.query];
      if (params.task) argv.push("--task", params.task);
      if (params.scope?.length) argv.push("--scope", params.scope.join(","));
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      return { ...text(data.map || "(sin mapa)"), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_dispatch",
    label: "Orchestra Dispatch",
    description: "Corre 1..N work orders disjuntos en paralelo (worktrees + autor→gate→verifier→rondas con modelos baratos) y devuelve un resumen compacto por orden. Si no se pide commit, quedan en needs-approval.",
    promptSnippet: "Despachar work orders al loop (autor→gate→verifier→rondas) en paralelo",
    promptGuidelines: [
      "Use orchestra_dispatch para ejecutar trabajo: pasá work orders con goal + acceptance + scope.",
      "Use orchestra_dispatch con commit:false (default) para revisar antes de integrar, y orchestra_approve para commitear.",
    ],
    parameters: Type.Object({
      orders: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          taskId: Type.Optional(Type.String({ description: "usar/afinar una tarea existente de tasks.json" })),
          goal: Type.String({ description: "qué hay que lograr" }),
          acceptance: Type.Array(Type.String(), { description: "criterios verificables (obligatorio)" }),
          scope: Type.Optional(Type.Array(Type.String(), { description: "archivos/globs que puede tocar" })),
          targets: Type.Optional(Type.Array(Type.String(), { description: "targets de gate" })),
          risk: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
        }),
      ),
      workers: Type.Optional(Type.Number({ description: "parallelismo (default loop.maxParallelTasks)" })),
      commit: Type.Optional(Type.Boolean({ description: "auto-aprobar e integrar (default false = needs-approval)" })),
      yes: Type.Optional(Type.Boolean({ description: "aprobar rutas protegidas" })),
      dryRun: Type.Optional(Type.Boolean()),
      decisions: Type.Optional(Type.String({ description: "JSON de decisiones, ej. {\"keys\":\"use_orchestrator\"}" })),
      detach: Type.Optional(Type.Boolean({ description: "correr en background y devolver runId (T-04)" })),
      runId: Type.Optional(Type.String({ description: "id de run para seguirlo con orchestra_status" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const argv = ["dispatch"];
      for (const o of params.orders) argv.push("--order", JSON.stringify(o));
      if (params.workers) argv.push("--workers", String(params.workers));
      if (params.commit) argv.push("--commit");
      if (params.yes) argv.push("--yes");
      if (params.dryRun) argv.push("--dry-run");
      if (params.decisions) argv.push("--decisions", params.decisions);
      if (params.runId) argv.push("--run-id", params.runId);
      if (params.detach) {
        argv.push("--detach");
        const { data } = await runDriverJson(argv, ctx.cwd, signal);
        return { ...text(`dispatch detached: ${data.runId} (pid ${data.pid}). Seguí con orchestra_status run:${data.runId}. log=${data.log}`), details: data };
      }
      onUpdate?.(text(`despachando ${params.orders.length} orden(es)...`));
      const { data } = await withProgress(ctx, ctx.cwd, onUpdate, `dispatch ${params.orders.length} orden(es)`, () => runDriverJson(argv, ctx.cwd, signal));
      const lines = (data.results || []).map((r: any) => {
        const mark = r.approved ? "✓" : r.status === "needs-approval" ? "⏳" : r.status === "needs-decision" ? "❓" : "✗";
        return `${mark} ${r.id}: ${r.status}${r.verdict ? ` ${r.verdict}` : ""} $${r.cost}${r.diff ? ` diff=${r.diff}` : ""}`;
      });
      const tail = data.status === "needs-attention"
        ? "Usá orchestra_approve (o orchestra_reject) para cada tarea pendiente."
        : "Todo integrado.";
      return { ...text([`dispatch ${data.status} (costo $${data.cost})`, ...lines, tail].join("\n")), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_approve",
    label: "Orchestra Approve",
    description: "Aprueba una tarea en needs-approval y (con commit:true) la integra: commit en el worktree + merge a la rama base.",
    promptSnippet: "Aprobar e integrar (commit+merge) una tarea del loop",
    promptGuidelines: ["Use orchestra_approve cuando una tarea esté en needs-approval y el diff te convenza."],
    parameters: Type.Object({
      task: Type.String({ description: "id de la tarea" }),
      commit: Type.Optional(Type.Boolean({ description: "integrar (commit+merge). Default true si no lo pasás" })),
      yes: Type.Optional(Type.Boolean({ description: "aprobar rutas protegidas" })),
      message: Type.Optional(Type.String({ description: "mensaje de commit" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const argv = ["approve", "--task", params.task];
      argv.push("--commit");
      if (params.commit === false) argv.pop();
      if (params.yes) argv.push("--yes");
      if (params.message) argv.push("--message", params.message);
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      const integ = data.integration?.ok ? "integrada" : data.integration?.skipped ? "sin integrar (dry-run)" : "no integrada";
      return { ...text(`aprobada ${data.id}: ${data.status} — ${integ} — $${data.cost}`), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_reject",
    label: "Orchestra Reject",
    description: "Rechaza una tarea del loop y limpia su worktree/rama.",
    parameters: Type.Object({
      task: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const argv = ["reject", "--task", params.task];
      if (params.reason) argv.push("--reason", params.reason);
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      return { ...text(`rechazada ${data.id}${data.reason ? ` — ${data.reason}` : ""}`), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_status",
    label: "Orchestra Status",
    description: "Estado compacto de las tareas del loop, o de un run detached (run:'<id>' / runs:true).",
    promptSnippet: "Ver estado de las tareas del loop, runs detached y decisiones pendientes",
    parameters: Type.Object({
      run: Type.Optional(Type.String({ description: "id de run detached (dispatch --detach)" })),
      runs: Type.Optional(Type.Boolean({ description: "listar todos los runs" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const argv = ["status"];
      if (params?.run) argv.push("--run", params.run);
      else if (params?.runs) argv.push("--runs");
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      if (params?.run) {
        const tasks = (data.tasks || []).map((t: any) => `  ${t.id}: ${t.state} $${t.cost}`);
        return { ...text([`run ${data.runId}: ${data.status} (pid ${data.pid})`, ...tasks].join("\n")), details: data };
      }
      if (params?.runs) {
        const runs = (data.runs || []).map((r: any) => `${r.runId}: ${r.status} (${(r.orders || []).join(", ")})`);
        return { ...text(runs.length ? runs.join("\n") : "sin runs"), details: data };
      }
      const lines = (data.tasks || []).map((t: any) => `${t.id}: tasks=${t.status} state=${t.state} $${t.cost}${t.decision ? ` decision=${t.decision.reason}` : ""}`);
      return { ...text(lines.length ? lines.join("\n") : "sin tareas"), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_usage",
    label: "Orchestra Usage",
    description: "Cuota consumida por cuenta (rolling/weekly/monthly %) desde el endpoint /usage de opencode-go. Sirve para decidir si cerrar con la cuenta del orquestador.",
    parameters: Type.Object({
      noCache: Type.Optional(Type.Boolean({ description: "ignorar el cache de 60s" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const argv = ["usage"];
      if (params.noCache) argv.push("--no-cache");
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      const lines = (data.accounts || []).map((a: any) => {
        const u = a.usage;
        return u ? `${a.role} ${a.name}: rolling=${u.rolling?.percent ?? "-"}% weekly=${u.weekly?.percent ?? "-"}% monthly=${u.monthly?.percent ?? "-"}%` : `${a.role} ${a.name}: sin datos`;
      });
      return { ...text(lines.length ? lines.join("\n") : "sin cuentas"), details: data };
    },
  });

  pi.registerTool({
    name: "orchestra_dashboard",
    label: "Orchestra Dashboard",
    description: "Vista compacta del loop: costos por rol/modelo, tareas y su estado (needs-approval/needs-decision), cuota por cuenta y worktrees abiertos.",
    promptSnippet: "Ver el dashboard del loop (costos, tareas, cuota)",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const lines = await spawnLines(["dashboard", "--once", "--plain"], ctx.cwd);
      return { ...text(lines.length ? lines.join("\n") : "(sin datos)"), details: { lines } };
    },
  });

  pi.registerCommand("orchestra-dashboard", {
    description: "Muestra el dashboard del loop como widget (se actualiza cada 5s)",
    handler: async (_args, ctx) => {
      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const render = async () => {
        const lines = await spawnLines(["dashboard", "--once", "--plain", "--no-usage"], cwd);
        try { (ctx as any).ui?.setWidget?.("orchestra", lines, { placement: "belowEditor" }); } catch { /* noop */ }
        return lines;
      };
      await render();
      const timer = setInterval(() => { render().catch(() => {}); }, 5000);
      if (typeof timer.unref === "function") timer.unref();
      (ctx as any).ui?.notify?.("orchestra dashboard on (Ctrl+C no lo apaga; /orchestra-dashboard-off)", "info");
      dashboards.set(ctx, timer);
    },
  });

  pi.registerCommand("orchestra-dashboard-off", {
    description: "Oculta el widget del dashboard",
    handler: async (_args, ctx) => {
      const timer = dashboards.get(ctx);
      if (timer) { clearInterval(timer); dashboards.delete(ctx); }
      try { (ctx as any).ui?.setWidget?.("orchestra", undefined); } catch { /* noop */ }
    },
  });

  pi.registerTool({
    name: "orchestra_models",
    label: "Orchestra Models",
    description: "Ranking de modelos (catálogo opencode-go + arena.ai) y pools de rotación. Con apply:true escribe los pools en config.json.",
    parameters: Type.Object({
      apply: Type.Optional(Type.Boolean({ description: "escribir los pools en config.json (backup .bak)" })),
      refresh: Type.Optional(Type.Boolean({ description: "forzar refresh aunque no haya vencido" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const argv = ["models"];
      if (params.apply) argv.push("--apply");
      if (params.refresh) argv.push("--refresh");
      const { data } = await runDriverJson(argv, ctx.cwd, signal);
      const t = (label: string, ids: any[]) => `${label}: ${(ids || []).join(", ")}`;
      return {
        ...text([t("author", data.author), t("verifier", data.verifier), t("fallback", data.fallback), `escalado: ${data.escalationAuthor} / ${data.escalationVerifier}`, `servicio: ${data.service}`].join("\n")),
        details: data,
      };
    },
  });

  pi.registerTool({
    name: "orchestra_report",
    label: "Orchestra Report",
    description: "Costo y uso desde el ledger: por rol, por modelo y por tarea.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const { data } = await runDriverJson(["report"], ctx.cwd, signal);
      const byRole = Object.entries(data.byRole || {}).map(([r, v]: any) => `${r} $${Number(v.cost).toFixed(4)}`).join(", ");
      return { ...text(`eventos ${data.events} | costo $${Number(data.cost).toFixed(4)} | ${byRole}`), details: data };
    },
  });
}
