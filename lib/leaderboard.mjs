/**
 * Scraping + matching del leaderboard WebDev/code de arena.ai.
 *
 * Portado (con atribución) de `aoalejo/opencode_mcp` — src/leaderboard.js,
 * adaptado a este driver. La página server-renderiza una tabla HTML; si arena.ai
 * cambia el markup, `fetchWebDevLeaderboard` devuelve 0 filas y el ranker lo
 * detecta en vez de rankear con datos vacíos.
 */
export const DEFAULT_ARENA_URL = 'https://arena.ai/leaderboard/code/webdev';

// Sufijos de "esfuerzo" que el leaderboard agrega al slug base
// (ej. "kimi-k3-max", "deepseek-v4-flash-high"). Se quitan uno a la vez,
// primero la secuencia más larga, cuando el slug no matchea un id tal cual.
const VARIANT_SUFFIXES = ['xhigh', 'high', 'max', 'minimal', 'low', 'thinking', 'preview'];

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Devuelve filas {rank, slug, score, votes} del leaderboard WebDev/code. */
export async function fetchWebDevLeaderboard(url = DEFAULT_ARENA_URL) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (orchestra tier ranker)' } });
  if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
  const html = await res.text();

  const tbodyStart = html.indexOf('<tbody');
  const tbodyEnd = html.indexOf('</tbody>');
  if (tbodyStart === -1 || tbodyEnd === -1) throw new Error('arena.ai cambió el markup: no hay <tbody>');
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rowsHtml = tbody.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

  const rows = [];
  for (const rowHtml of rowsHtml) {
    const cells = rowHtml.match(/<td[\s\S]*?<\/td>/g) ?? [];
    if (cells.length < 4) continue;
    const rank = parseInt(stripTags(cells[0]), 10);
    // El slug exacto suele estar en title="..." (el texto visible puede truncarse por CSS).
    const titleMatch = cells[2].match(/title="([^"]+)"/);
    const slug = titleMatch ? titleMatch[1] : stripTags(cells[2]).split(' ')[0];
    const scoreMatch = stripTags(cells[3]).match(/-?\d+(\.\d+)?/);
    const score = scoreMatch ? parseFloat(scoreMatch[0]) : null;
    const votesText = cells[4] ? stripTags(cells[4]).replace(/,/g, '') : '';
    const votes = votesText && /^\d+$/.test(votesText) ? parseInt(votesText, 10) : null;
    if (Number.isFinite(rank) && slug && score != null) rows.push({ rank, slug, score, votes });
  }
  return rows;
}

export function normalize(s) {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // quita anotaciones tipo "(codex-harness)"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isStrippableToken(token) {
  return VARIANT_SUFFIXES.includes(token) || /^\d{6,}$/.test(token); // snapshot con fecha
}

/**
 * Matchea un id de modelo contra las filas del leaderboard. Intenta match
 * exacto normalizado primero (así "qwen3.8-max" es un SKU real, no "qwen3.8"
 * con variante max). Si no hay exacto, prueba quitando sufijos de variante y
 * se queda con el de mayor score.
 *
 * Devuelve `{...row, variant}` (variant = sufijo de esfuerzo para reproducir
 * ese score, o null si el leaderboard ya rankea el modelo base) o null.
 */
export function matchModel(modelId, leaderboardRows) {
  const target = normalize(modelId);
  const byNorm = leaderboardRows.map((r) => ({ ...r, _norm: normalize(r.slug) }));

  const exact = byNorm.filter((r) => r._norm === target);
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (b.score > a.score ? b : a));
    return { ...best, variant: null };
  }

  const candidates = [];
  for (const r of byNorm) {
    const tokens = r._norm.split('-');
    const stripped = [];
    while (tokens.length > 0 && isStrippableToken(tokens[tokens.length - 1])) stripped.unshift(tokens.pop());
    const variantTokens = stripped.filter((t) => VARIANT_SUFFIXES.includes(t));
    if (stripped.length > 0 && tokens.join('-') === target) {
      candidates.push({ ...r, variant: variantTokens.length > 0 ? variantTokens.join('-') : null });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.score > a.score ? b : a));
}
