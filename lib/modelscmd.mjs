/** Comando `orchestra models`: refresca el ranking y aplica los pools. */
import fs from 'node:fs';
import path from 'node:path';
import { O } from './paths.mjs';
import { exists, writeJson, now } from './util.mjs';
import { log, warn } from './log.mjs';
import { refreshRankings, maxAgeHoursOf } from './models.mjs';
import { configPatchFromRanking, SERVICE_ROLES } from './rank.mjs';

export function applyConfigPatch(config, patch) {
  const out = structuredClone(config);
  out.roles = { ...out.roles, ...(patch.roles || {}) };
  out.fallback = { ...(out.fallback || {}), ...(patch.fallback || {}) };
  return out;
}

export function applyAndSaveRanking(config, ranking, configPath) {
  const patch = configPatchFromRanking(ranking, { serviceRoles: config.models?.applyServiceRoles !== false });
  const next = applyConfigPatch(config, patch);
  if (exists(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);
  writeJson(configPath, next);
  return next;
}

export async function runModelsCommand(args, config) {
  const configPath = path.join(O, 'config.json');
  log(`consultando catálogo ${config.provider} + arena.ai ...`);
  const ranking = await refreshRankings(config);
  const doc = { generatedAt: now(), ...ranking };
  writeJson(path.join(O, 'models.generated.json'), doc);
  if (args.json) { console.log(JSON.stringify(doc, null, 2)); return doc; }

  const fmt = (id) => {
    const m = doc.ranked.find((x) => x.id === id);
    if (!m) return `${id} (?)`;
    const score = m.score != null ? `${m.score}` : '?';
    const tag = m.source === 'arena' ? `arena #${m.arenaRank} · ${score}`
      : m.source === 'alias' || m.source === 'suffix' ? `arena #${m.arenaRank} · ${score} vía ${m.arenaSlug}`
      : m.source === 'override' ? `override · ${score}`
      : m.source === 'family' ? `≈familia · ${score}`
      : 'sin score';
    return `${id} (${tag}) $${m.input}/${m.output ?? '?'}`;
  };
  log(`catálogo: ${doc.liveCount} vivos | ${doc.counts.matched} con score | ${doc.counts.unmatched} sin score | ${doc.counts.noCost} sin costo cacheado | ${doc.counts.excluded} excluidos | arena ${doc.counts.arenaRows} filas`);
  if (doc.liveError) warn(`no se pudo listar el endpoint (se usó el cache de costos): ${doc.liveError}`);
  if (doc.liveOnly?.length) log(`nuevos en el endpoint (sin costo cacheado): ${doc.liveOnly.join(', ')}`);
  if (doc.staleOnly?.length) warn(`en el cache pero ya no en el endpoint: ${doc.staleOnly.join(', ')}`);
  if (doc.inferred?.length) warn(`score inferido por familia (verificar): ${doc.inferred.join(', ')}`);
  if (doc.pins?.length) log(`pins activos (no los toca el refresh): ${doc.pins.join(', ')}`);
  const sinScore = doc.ranked.filter((x) => x.costKnown && !x.matched).map((x) => x.id);
  if (sinScore.length) warn(`sin score en arena (quedan al final del pool): ${sinScore.join(', ')}`);
  console.log('\nROTACIÓN RECOMENDADA');
  for (const [label, ids] of [['author', doc.author], ['verifier', doc.verifier], ['fallback', doc.fallback]]) {
    for (let i = 0; i < ids.length; i++) console.log(`  ${(i === 0 ? label : '').padEnd(10)} ${fmt(ids[i])}`);
  }
  console.log(`  ${''.padEnd(10)} escalado: ${fmt(doc.escalationAuthor)} / ${fmt(doc.escalationVerifier)}`);
  const serviceIds = [...new Set(SERVICE_ROLES.map((r) => doc.serviceRoles?.[r]).filter(Boolean))];
  if (serviceIds.length === 1) console.log(`  ${'servicio'.padEnd(10)} ${fmt(serviceIds[0])}  (scout/scribe/security/merge)`);
  else if (serviceIds.length > 1) for (const role of SERVICE_ROLES) console.log(`  ${('servicio:' + role).padEnd(10)} ${fmt(doc.serviceRoles[role])}`);

  log(`próximo refresh automático: cada ${maxAgeHoursOf(config)} h (models.rankings.maxAgeHours)`);
  if (args.apply) {
    applyAndSaveRanking(config, doc, configPath);
    log('config.json actualizado (backup: config.json.bak)');
  } else {
    log('dry: usá --apply para escribir los pools en config.json');
  }
  return doc;
}
