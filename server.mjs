import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const envPath = resolve(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
const port = Number(process.env.PORT || 4173);
const databasePath = resolve(root, 'data', 'setlist.db');
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, position INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS setlists (id TEXT PRIMARY KEY, payload TEXT NOT NULL, position INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8' };

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readLibrary() {
  const songs = database.prepare('SELECT payload FROM songs ORDER BY position').all().map(row => JSON.parse(row.payload));
  const sets = database.prepare('SELECT payload FROM setlists ORDER BY position').all().map(row => JSON.parse(row.payload));
  const initialized = database.prepare("SELECT value FROM app_meta WHERE key = 'library_initialized'").get()?.value === '1';
  const updatedAt = Number(database.prepare("SELECT value FROM app_meta WHERE key = 'updated_at'").get()?.value || 0);
  return { initialized, updatedAt, songs, sets };
}

function replaceLibrary(songs, sets) {
  const updatedAt = Date.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM songs; DELETE FROM setlists;');
    const putSong = database.prepare('INSERT INTO songs (id, payload, position) VALUES (?, ?, ?)');
    const putSet = database.prepare('INSERT INTO setlists (id, payload, position) VALUES (?, ?, ?)');
    songs.forEach((song, position) => putSong.run(song.id, JSON.stringify(song), position));
    sets.forEach((set, position) => putSet.run(set.id, JSON.stringify(set), position));
    database.prepare("INSERT INTO app_meta (key, value) VALUES ('library_initialized', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    database.prepare("INSERT INTO app_meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(updatedAt));
    database.exec('COMMIT');
    return updatedAt;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

async function readJson(req, maxBytes = 24_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > maxBytes) throw Object.assign(new Error('La lista es demasiado grande.'), { status: 413 });
  }
  try { return JSON.parse(data); }
  catch { throw Object.assign(new Error('El contenido enviado no es JSON válido.'), { status: 400 }); }
}

function callGroqSetlist(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python, [resolve(root, 'groq_setlist.py')], {
      cwd: root, windowsHide: true, env: { ...process.env, GROQ_API_KEY: process.env.GROQ_API_KEY || '' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (error.code === 'ENOENT') rejectPromise(Object.assign(new Error('No se encontró Python. Instala Python y las dependencias de requirements.txt.'), { status: 503 }));
      else rejectPromise(error);
    });
    child.on('close', code => {
      for (const line of stderr.split(/\r?\n/)) if (line.startsWith('[Groq usage]')) console.info(line);
      let result;
      try { result = JSON.parse(stdout); }
      catch { rejectPromise(Object.assign(new Error(stderr.trim() || 'Groq no devolvió un repertorio válido.'), { status: 502 })); return; }
      if (code !== 0 || result.error) {
        rejectPromise(Object.assign(new Error(result.error || stderr.trim() || 'Groq no pudo crear el repertorio.'), { status: result.status || 502 }));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end('Solicitud no válida'); return; }
  if (pathname === '/api/library' && req.method === 'GET') {
    try { return sendJson(res, 200, readLibrary()); }
    catch (error) { console.error(`No se pudo leer la base local: ${error.message}`); return sendJson(res, 500, { error: 'No se pudo leer la base de datos local.' }); }
  }
  if (pathname === '/api/library' && req.method === 'PUT') {
    try {
      const body = await readJson(req, 10_000_000);
      if (!Array.isArray(body.songs) || !Array.isArray(body.sets) || body.songs.length > 50_000 || body.sets.length > 5_000) {
        return sendJson(res, 400, { error: 'La biblioteca enviada no tiene un formato válido o excede el límite permitido.' });
      }
      const validSongs = body.songs.every(song => song && typeof song.id === 'string' && typeof song.title === 'string');
      const validSets = body.sets.every(set => set && typeof set.id === 'string' && typeof set.name === 'string' && Array.isArray(set.songIds));
      if (!validSongs || !validSets) return sendJson(res, 400, { error: 'Cada canción y setlist necesita un identificador válido.' });
      const updatedAt = replaceLibrary(body.songs, body.sets);
      return sendJson(res, 200, { ok: true, updatedAt, songCount: body.songs.length, setCount: body.sets.length });
    } catch (error) {
      const status = error.status || 500;
      console.error(`No se pudo guardar la base local: ${error.message}`);
      return sendJson(res, status, { error: status === 500 ? 'No se pudieron guardar los cambios en la base de datos local.' : error.message });
    }
  }
  if (pathname === '/api/setlist' && req.method === 'POST') {
    try {
      const body = await readJson(req, 2_000);
      if (!process.env.GROQ_API_KEY) return sendJson(res, 503, { error: 'Falta configurar GROQ_API_KEY en el archivo .env.' });
      const prompt = String(body.prompt || '').trim().slice(0, 500);
      const duration = Math.max(30, Math.min(180, Math.round(Number(body.duration) / 30) * 30 || 120));
      const songs = database.prepare('SELECT payload FROM songs ORDER BY position').all().map(row => JSON.parse(row.payload));
      if (!songs.length) return sendJson(res, 400, { error: 'La biblioteca no contiene canciones.' });
      const count = Math.min(songs.length, Math.max(1, Math.round(duration * 60 / 210)));
      const candidates = songs.map((song, index) => ({
        i: index, t: String(song.title || '').slice(0, 100), a: String(song.artist || '').slice(0, 80),
        c: String(song.category || '').slice(0, 40), g: String(song.genre || '').slice(0, 40),
        s: String(song.subgenre || '').slice(0, 40), v: String(song.eventType || '').slice(0, 40),
        k: String(song.key || '').slice(0, 16),
        e: song.energy !== null && song.energy !== undefined && song.energy !== '' && Number.isInteger(Number(song.energy)) ? Number(song.energy) : null,
        d: Math.max(30, Math.min(900, Number(song.duration) || 210))
      }));
      const maxCandidates = Math.min(candidates.length, Math.max(60, Math.min(120, count * 2)));
      let selected = candidates;
      if (candidates.length > maxCandidates) {
        const terms = prompt.toLocaleLowerCase('es');
        const categoryNames = [...new Set(songs.map(song => String(song.category || '').trim()).filter(Boolean))];
        const matchingCategories = categoryNames.filter(category => terms.includes(category.toLocaleLowerCase('es')));
        const preferred = candidates.filter(candidate => matchingCategories.some(category => category.toLocaleLowerCase('es') === candidate.c.toLocaleLowerCase('es')));
        const preferredIds = new Set(preferred.map(candidate => candidate.i));
        const remainder = candidates.filter(candidate => !preferredIds.has(candidate.i));
        const slots = Math.max(0, maxCandidates - Math.min(preferred.length, maxCandidates));
        const stride = Math.max(1, Math.ceil(remainder.length / Math.max(1, slots)));
        selected = [...preferred.slice(0, maxCandidates), ...remainder.filter((_, index) => index % stride === 0).slice(0, slots)];
      }
      const targetSeconds = duration * 60;
      const model = process.env.GROQ_SETLIST_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
      console.info(`[Groq setlist] request model=${model} candidates=${selected.length} target_minutes=${duration}`);
      const result = await callGroqSetlist({ prompt, duration, targetSeconds, count, songs: selected });
      const valid = new Set(selected.map(song => song.i));
      const ordered = [...new Set((Array.isArray(result.order) ? result.order : []).filter(index => Number.isInteger(index) && valid.has(index)))];
      const used = new Set(ordered);
      const rest = selected.filter(song => !used.has(song.i));
      const chosen = [];
      let elapsed = 0;
      const addIfFits = song => {
        const seconds = Math.max(30, Math.min(900, Number(song.d) || 210));
        if (elapsed + seconds > targetSeconds) return false;
        chosen.push(song.i);
        used.add(song.i);
        elapsed += seconds;
        return true;
      };
      for (const index of ordered) {
        const song = selected.find(candidate => candidate.i === index);
        if (song) addIfFits(song);
      }
      while (rest.some(song => !used.has(song.i))) {
        const remainingSeconds = targetSeconds - elapsed;
        const fitting = rest.filter(song => !used.has(song.i) && (Number(song.d) || 210) <= remainingSeconds);
        if (!fitting.length) break;
        fitting.sort((a, b) => (Number(b.d) || 210) - (Number(a.d) || 210));
        addIfFits(fitting[0]);
      }
      return sendJson(res, 200, { songIds: chosen.map(index => songs[index].id), durationSeconds: elapsed });
    } catch (error) {
      const status = error.status || (error.name === 'TimeoutError' ? 504 : 502);
      return sendJson(res, status, { error: error.message || 'Groq no pudo crear el repertorio.' });
    }
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Ruta API no encontrada.' });
  const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const relativePath = relative(root, requested);
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => part.startsWith('.') || part.toLowerCase() === 'data')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const content = await readFile(requested);
    res.writeHead(200, { 'Content-Type': types[extname(requested)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
}).listen(port, '0.0.0.0', () => console.log(`Setlist AI Studio listo en http://localhost:${port}`));
