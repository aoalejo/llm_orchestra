import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extensión de pi que expone el Lean Orchestrator como comando `/orchestra`.
 *
 *   /orchestra init
 *   /orchestra --keys-status
 *   /orchestra --plan
 *   /orchestra --task <id> --dry-run
 *
 * El runtime real es `orchestra.mjs` (este paquete); la extensión sólo lo invoca.
 */

const DRIVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestra.mjs");

function runDriver(argv: string[], cwd: string): Promise<number> {
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

export default function orchestraExtension(pi: ExtensionAPI) {
  pi.registerCommand("orchestra", {
    description: "Lean Orchestrator: init / plan / task / status (multi-modelo)",
    getArgumentCompletions: (prefix) => {
      const options = ["init", "models", "models --apply", "--plan", "--keys-status", "--self-test", "--all", "--stub", "--no-worktrees", "--task ", "--help"];
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
}
