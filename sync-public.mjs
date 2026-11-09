// Reads ONLY the anonymous, opened-round API. No owner identity or secrets.
import { readFile, writeFile, mkdir, cp, rm, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ORIGIN = 'https://walengmen-lab.jefferyhualiu.chatgpt.site';
const MIRROR = 'https://apexegg.github.io/walengmen-web';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const dateKey = (s) => { try { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00Z').toISOString().slice(0, 10) === s; } catch { return false; } };
export async function readPublicJson(path, max = 256 * 1024, fetcher = fetch, origin = ORIGIN, pause = (ms) => new Promise((done) => setTimeout(done, ms))) {
  if (!/^\/(api\/(catalog|rounds\/(today|\d{4}-\d{2}-\d{2})(\?hash=[a-f0-9]{64})?)|content\/[a-f0-9]{64}(\/source)?\.json)$/.test(path)) throw Error('Refusing a non-public API path');
  let r;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      r = await fetcher(origin + path, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { accept: 'application/json' } });
    } catch (error) {
      if (attempt === 3) throw error;
      await pause(1000 * 2 ** attempt); continue;
    }
    if (![408, 425, 429, 500, 502, 503, 504].includes(r.status) || attempt === 3) break;
    const retryAfter = r.headers.get('retry-after');
    const requestedWait = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    const delay = Math.min(60000, Math.max(1000 * 2 ** attempt, Number.isFinite(requestedWait) ? requestedWait : 0));
    await r.body?.cancel(); await pause(delay);
  }
  if (!r.ok || !/application\/json/i.test(r.headers.get('content-type') ?? '')) throw Error('Public source unavailable: ' + r.status);
  const parts = []; let size = 0;
  for await (const part of r.body) { size += part.length; if (size > max) throw Error('Public response exceeds budget'); parts.push(part); }
  const bytes = Buffer.concat(parts); return { value: JSON.parse(bytes.toString('utf8')), bytes };
}
const json = readPublicJson;
async function files(dir, prefix = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + e.name;
    if (e.isDirectory()) out.push(...await files(join(dir, e.name), name + '/'));
    else if (e.isFile()) out.push([name, sha(await readFile(join(dir, e.name)))]);
    else throw Error('Symlinks are forbidden in the public mirror');
  } return out.sort((a, b) => a[0].localeCompare(b[0]));
}
export async function syncPublic({ root = process.cwd(), fetcher = fetch } = {}) {
  const cache = join(root, 'cache'), pub = join(root, 'public'); await mkdir(cache, { recursive: true });
  const catalog = (await json('/api/catalog', undefined, fetcher)).value;
  if (catalog.degraded) throw Error('Refusing a degraded catalog; preserve the existing deployment');
  if (!dateKey(catalog.today) || !Array.isArray(catalog.rounds) || catalog.rounds.length > 10000) throw Error('Malformed public catalog');
  const selected = catalog.rounds.filter((r) => dateKey(r.dateKey) && r.dateKey <= catalog.today).sort((a, b) => a.dateKey.localeCompare(b.dateKey)).slice(-30);
  if (!selected.length || new Set(selected.map((r) => r.dateKey)).size !== selected.length) throw Error('No distinct released rounds');
  const editions = Array.isArray(catalog.editions) ? catalog.editions.filter(e => selected.some(r => r.dateKey === e.dateKey)) : [];
  let old; try { old = JSON.parse(await readFile(join(cache, 'published.json'), 'utf8')); } catch { /* first publish */ }
  for (const prior of old?.rounds ?? []) {
    if (prior.date < selected[0].dateKey && selected.length === 30) continue;
    const current = selected.find((r) => r.dateKey === prior.date);
    if (!current) throw Error('Published history disappeared; preserve the existing deployment');
    if (current.hash !== prior.hash || (prior.sourceHash && current.sourceHash !== prior.sourceHash)) {
      const previous = editions.find(e => e.dateKey === prior.date && e.hash === prior.hash && (!prior.sourceHash || e.sourceHash === prior.sourceHash));
      const correction = current.rarityEdition;
      if (!previous || !correction || correction.baseHash !== (previous.rarityEdition?.baseHash ?? previous.hash)
        || !(correction.generation > (previous.rarityEdition?.generation ?? 0)) || !/^[a-f0-9]{64}$/.test(correction.evidenceHash ?? '')
        || !correction.reviewerRunId || correction.reviewerRunId === correction.authorRunId) throw Error('Published daily identity changed without a preserved reviewed rarity edition; preserve the existing deployment');
    }
  }
  const stamp = sha(JSON.stringify({ assets: await files(join(root, 'web')), rounds: selected.map((r) => [r.dateKey, r.hash, r.sourceHash, r.version]), editions: editions.map(e => [e.dateKey, e.hash, e.sourceHash]), today: catalog.today }));
  if (old?.stamp === stamp) return { changed: false, date: catalog.today, rounds: old.rounds.length, bytes: old.bytes };
  const fetchBlob = async (path, max, expected) => {
    try { const b = (await json(path, max, fetcher, MIRROR)).bytes; if (sha(b) === expected) return b; } catch { /* mirror not yet populated or unreachable */ }
    const b = (await json(path, max, fetcher)).bytes;
    if (sha(b) !== expected) throw Error('Public archive failed SHA-256 verification'); return b;
  };
  const metadata = [], blobs = [];
  const historical = editions.filter(e => !selected.some(r => r.dateKey === e.dateKey && r.hash === e.hash));
  for (const row of [...selected, ...historical]) {
    if (!/^[a-f0-9]{64}$/.test(row.hash)) throw Error('Invalid public content hash');
    const exact = historical.includes(row) ? '?hash=' + row.hash : '';
    const round = (await json('/api/rounds/' + row.dateKey + exact, undefined, fetcher)).value;
    if (round.hash !== row.hash || round.dateKey !== row.dateKey || round.roundId !== row.dateKey || round.contentUrl !== `/content/${row.hash}.json` || round.sourceUrl !== `/content/${row.hash}/source.json` || !/^[a-f0-9]{64}$/.test(round.sourceHash ?? '') || round.sourceHash !== row.sourceHash) throw Error('Round identity mismatch');
    const key = join(cache, row.hash + '.json.gz'), sourceKey = join(cache, row.hash + '.source.json.gz');
    let play;
    try { play = gunzipSync(await readFile(key), { maxOutputLength: 3 * 1024 * 1024 }); } catch { play = await fetchBlob(round.contentUrl, 3 * 1024 * 1024, row.hash); }
    if (sha(play) !== row.hash) throw Error('Published round failed SHA-256 verification');
    const pack = JSON.parse(play.toString('utf8'));
    if (pack.id !== round.packId || pack.questions?.length !== 7 || pack.questions.some((q) => !Array.isArray(q.answers) || !q.answers.length || !q.prompt?.zh || !q.rule?.zh)) throw Error('Invalid seven-question pack');
    let source;
    try {
      source = gunzipSync(await readFile(sourceKey), { maxOutputLength: 12 * 1024 * 1024 });
      if (sha(source) !== (await readFile(sourceKey + '.sha256', 'utf8')).trim()) throw Error('Cached source hash mismatch');
    } catch { source = await fetchBlob(round.sourceUrl, 12 * 1024 * 1024, round.sourceHash); }
    const full = JSON.parse(source.toString('utf8'));
    if (sha(source) !== round.sourceHash) throw Error('Frozen source archive failed SHA-256 verification');
    if (full.id !== pack.id || full.questions?.length !== 7 || full.questions.some((q, i) => q.id !== pack.questions[i].id || q.answers.length !== pack.questions[i].answers.length)) throw Error('Source archive does not match released questions');
    await writeFile(key, gzipSync(play, { level: 9 })); await writeFile(sourceKey, gzipSync(source, { level: 9 })); await writeFile(sourceKey + '.sha256', sha(source) + '\n');
    metadata.push(round); blobs.push({ hash: row.hash, play, source });
  }
  const changed = true;
  const estimated = () => blobs.reduce((n, b) => n + b.play.length + b.source.length, 1024 * 1024);
  while (estimated() > 390 * 1024 * 1024 && selected.length > 1) {
    const date = selected.shift().dateKey;
    for (let i = metadata.length - 1; i >= 0; i--) if (metadata[i].dateKey === date) metadata.splice(i, 1);
    const needed = new Set(metadata.map(m => m.hash));
    for (let i = blobs.length - 1; i >= 0; i--) if (!needed.has(blobs[i].hash)) blobs.splice(i, 1);
  }
  const next = pub + '.next'; await rm(next, { recursive: true, force: true }); await cp(join(root, 'web'), next, { recursive: true });
  await mkdir(join(next, 'api/rounds'), { recursive: true }); await mkdir(join(next, 'content'), { recursive: true });
  const latest = metadata.find(m => m.dateKey === selected.at(-1).dateKey && m.hash === selected.at(-1).hash);
  await writeFile(join(next, 'api/catalog.json'), JSON.stringify({ ...catalog, rounds: selected, ...(editions.length ? { editions: editions.filter(e => selected.some(r => r.dateKey === e.dateKey)) } : {}) }));
  for (const r of metadata) {
    await writeFile(join(next, 'api/rounds', r.dateKey + '--' + r.hash + '.json'), JSON.stringify(r));
    if (selected.some(s => s.dateKey === r.dateKey && s.hash === r.hash)) await writeFile(join(next, 'api/rounds', r.dateKey + '.json'), JSON.stringify(r));
  }
  await writeFile(join(next, 'api/rounds/today.json'), JSON.stringify({ ...latest, requestedDate: catalog.today, availability: latest.dateKey === catalog.today ? 'current' : 'fallback' }));
  for (const b of blobs) {
    await writeFile(join(next, 'content', b.hash + '.json'), b.play); await mkdir(join(next, 'content', b.hash), { recursive: true }); await writeFile(join(next, 'content', b.hash, 'source.json'), b.source);
  }
  const sizes = await Promise.all((await files(next)).map(async ([name]) => (await readFile(join(next, name))).length));
  const bytes = sizes.reduce((a, b) => a + b, 0); if (bytes > 400 * 1024 * 1024) throw Error('Mirror exceeds its conservative400MiB budget');
  const backup = pub + '.previous'; await rm(backup, { recursive: true, force: true });
  try { await rename(pub, backup); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await rename(next, pub); } catch (e) { try { await rename(backup, pub); } catch {} throw e; }
  await rm(backup, { recursive: true, force: true });
  const hashes = new Set(blobs.map((b) => b.hash));
  for (const name of await readdir(cache)) if (/^[a-f0-9]{64}(\.source)?\.json\.gz(\.sha256)?$/.test(name) && !hashes.has(name.slice(0, 64))) await rm(join(cache, name));
  await writeFile(join(cache, 'published.json'), JSON.stringify({ stamp, source: ORIGIN, date: catalog.today, rounds: selected.map((r) => ({ date: r.dateKey, hash: r.hash, sourceHash: r.sourceHash })), editions: metadata.length, bytes }, null, 2) + '\n');
  return { changed, date: catalog.today, rounds: selected.length, editions: metadata.length, bytes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncPublic(); console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `publish=${result.changed}\n`, { flag: 'a' });
}
