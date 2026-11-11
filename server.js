const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CFG_PATH = path.join(ROOT, 'config.json');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { cfg = {}; }

const PORT = parseInt(cfg.port, 10) || 8787;
const PROVIDERS = cfg.providers || {};

function pickProvider(name) {
  return PROVIDERS[String(name || '').trim()] ||
    PROVIDERS[String(cfg.defaultProvider || '')] ||
    PROVIDERS[Object.keys(PROVIDERS)[0]];
}
const SYSTEM = cfg.system || 'Ты полезный ассистент. Отвечай по-русски, кратко и по делу. Если просят код — давай рабочий код.';
const PIN = String(cfg.pin || '').trim();
const HOST = '0.0.0.0';
const WORKDIR = path.join(os.homedir(), String(cfg.workdir || 'NeuraWork'));
const MAX_STEPS = Math.max(1, parseInt(cfg.maxAgentSteps, 10) || 6);

let ACTIVITY = { text: 'ожидание', thought: '', ts: Date.now(), log: [] };
function setActivity(t) {
  const text = String(t);
  if (ACTIVITY.text === text) return;
  ACTIVITY = {
    text,
    thought: ACTIVITY.thought || '',
    ts: Date.now(),
    log: [{ at: Date.now(), text }].concat(ACTIVITY.log || []).slice(0, 40)
  };
}
function cleanThought(t) {
  let s = String(t || '');
  const cut = s.search(/<[｜|]?\s*(DSML|function_calls|tool_calls|invoke|parameter)/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/<\/?[a-zA-Z_][^>]*>/g, '');
  s = s.replace(/[｜|]+\s*$/gm, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
function setThought(t) {
  const s = cleanThought(t);
  if (!s) return;
  ACTIVITY = { text: ACTIVITY.text, ts: Date.now(), thought: s.slice(0, 2000), log: ACTIVITY.log || [] };
}

// ---------- обновления ----------
async function updateInfo() {
  const repo = String(cfg.updateRepo || '').trim();
  if (repo) {
    try {
      const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
        headers: { 'User-Agent': 'klodoks-updater', Accept: 'application/vnd.github+json' }
      });
      if (r.status === 404) return { error: 'GitHub: репозиторий ' + repo + ' не найден или нет релизов' };
      if (!r.ok) return { error: 'GitHub: HTTP ' + r.status };
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const zip = assets.filter((a) => /\.zip$/i.test(a.name || ''))[0];
      return {
        latest,
        zip: zip ? zip.browser_download_url : '',
        notes: String(rel.name || ''),
        source: 'github',
        available: !!latest && latest !== String(cfg.version || '0.0.0')
      };
    } catch (e) {
      return { error: 'GitHub: ' + String(e.message || e) };
    }
  }
  const url = String(cfg.updateUrl || '').trim();
  if (!url) return { error: 'Не заданы updateRepo или updateUrl в web/config.json' };
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return { error: 'Манифест недоступен: HTTP ' + r.status };
    const m = await r.json();
    const latest = String(m.version || '');
    const current = String(cfg.version || '0.0.0');
    return {
      latest,
      zip: String(m.zip || ''),
      notes: String(m.notes || ''),
      available: !!latest && latest !== current
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------- сеть: кто в локальной сети и общий чат ----------
let LAN_PEERS = {};
let LAN_MSGS = [];
let LAN_SEQ = 0;

function lanIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function lanTouch(ip) {
  LAN_PEERS[ip] = Date.now();
}

setInterval(() => {
  const now = Date.now();
  Object.keys(LAN_PEERS).forEach((k) => {
    if (now - LAN_PEERS[k] > 45000) delete LAN_PEERS[k];
  });
}, 15000);

try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch { }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function text(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

// ---------- агент: полный доступ к компьютеру ----------

function safePath(rel) {
  let p = String(rel || '.').trim();
  if (p === '~') p = os.homedir();
  else if (/^[~][/\\]/.test(p)) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) p = path.join(WORKDIR, p);
  return path.resolve(p);
}

function runCmd(command, cwd) {
  const dir = cwd ? safePath(cwd) : WORKDIR;
  return new Promise((resolve) => {
    exec(command, { cwd: dir, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      const clipped = out.length > 4000 ? out.slice(0, 4000) + '\n... (обрезано)' : out;
      if (err && !out) return resolve('Ошибка: ' + err.message);
      resolve(clipped || '(без вывода)');
    });
  });
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Показать файлы и папки по любому пути на диске',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Относительный путь, по умолчанию .' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл по любому пути на диске',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создать или перезаписать текстовый файл по любому пути на диске, папки создаются сами',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_cmd',
      description: 'Выполнить любую команду cmd.exe или PowerShell: npm, node, git, winget, python, установка пакетов и сборка приложений',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Папка выполнения, по умолчанию рабочая' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Открыть ссылку в браузере по умолчанию',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Запустить программу, открыть файл или папку на компьютере',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Путь к exe, файлу или папке' } },
        required: ['target']
      }
    }
  }
];

async function runTool(name, args) {
  try {
    setActivity(name + ' ' + JSON.stringify(args || {}).slice(0, 140));
    if (name === 'list_dir') {
      const dir = safePath(args && args.path ? args.path : '.');
      const items = fs.readdirSync(dir, { withFileTypes: true })
        .slice(0, 200)
        .map((d) => (d.isDirectory() ? d.name + '/' : d.name));
      return items.length ? items.join('\n') : '(пусто)';
    }
    if (name === 'read_file') {
      const f = safePath(args.path);
      const st = fs.statSync(f);
      if (st.size > 200000) return 'Файл слишком большой (больше 200 КБ)';
      return fs.readFileSync(f, 'utf8');
    }
    if (name === 'write_file') {
      const f = safePath(args.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(args.content || ''), 'utf8');
      return 'Записано: ' + path.relative(WORKDIR, f);
    }
    if (name === 'run_cmd') {
      return await runCmd(String(args.command || ''), args && args.cwd ? String(args.cwd) : null);
    }
    if (name === 'open_url') {
      const u = String(args.url || '');
      if (!/^https?:\/\//i.test(u)) return 'Разрешены только http/https ссылки';
      spawn('cmd.exe', ['/c', 'start', '""', u], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      return 'Открываю в браузере: ' + u;
    }
    if (name === 'open_app') {
      const t = String(args.target || '');
      spawn('cmd.exe', ['/c', 'start', '""', t], { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
      return 'Запускаю: ' + t;
    }
    return 'Неизвестный инструмент: ' + name;
  } catch (e) {
    return 'Ошибка инструмента: ' + e.message;
  }
}

const AGENT_RULES = [
  '',
  '',
  'Ты работаешь на компьютере пользователя и МОЖЕШЬ выполнять действия сам.',
  'Инструменты: list_dir, read_file, write_file, run_cmd (любые команды: npm, git, winget, python, сборка приложений), open_url (открыть сайт в браузере), open_app (запустить программу, файл или папку).',
  'Пути можно указывать абсолютные, по всему диску, и с ~. Стартовая папка: ' + WORKDIR + '.',
  'Если просят открыть сайт, программу, файл, папку, поставить пакет, создать проект — ВЫЗЫВАЙ ИНСТРУМЕНТ, а не объясняй, что не имеешь доступа.',
  'НИКОГДА не отвечай, что у тебя нет доступа к компьютеру, браузеру или графическому интерфейсу: у тебя есть инструменты, и они работают.',
  'Перед вызовом инструмента напиши 1–2 предложения от первого лица: что понял, что собираюсь сделать и зачем. Этот текст показывается пользователю в блоке «о чём думает».',
  'Не спрашивай разрешения на каждый шаг. Действуй и в конце коротко отчитайся, что сделано.'
].join('\n');

function extractReasoning(m) {
  if (!m) return '';
  const direct = m.reasoning_content || m.reasoning || m.thinking || m.analysis;
  if (direct && String(direct).trim()) return String(direct);
  const rd = m.reasoning_details;
  if (Array.isArray(rd)) {
    const t = rd
      .map((x) => (x && (x.text || x.summary || x.content)) || '')
      .join('\n')
      .trim();
    if (t) return t;
  }
  return '';
}

async function agentTurn(prov, key, model, history) {
  const messages = [{ role: 'system', content: SYSTEM + AGENT_RULES }, ...history];
  const steps = [];
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      setActivity('думает');
      const msg = await callModel(prov, key, model, messages, TOOLS);
      if (!msg) break;

      const reasoning = extractReasoning(msg);
      if (reasoning.trim()) setThought(reasoning);
      else if (msg.content && String(msg.content).trim() && msg.tool_calls && msg.tool_calls.length) setThought(msg.content);

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        setActivity('готово');
        return { reply: msg.content || '(пустой ответ)', steps };
      }

      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = {}; }
        const result = await runTool(c.function.name, args);
        steps.push({ tool: c.function.name, args, result: String(result).slice(0, 600) });
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(result) });
      }
    }
    return { error: 'Достигнут лимит шагов агента', steps };
  } catch (e) {
    return { error: e.message, steps };
  }
}

async function callModel(prov, key, model, messages, tools) {
  const payload = { model, messages, max_tokens: 1500 };
  if (tools) { payload.tools = tools; payload.tool_choice = 'auto'; }

  const r = await fetch(`${prov.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const raw = await r.text();
  if (!r.ok) {
    let hint = '';
    if (r.status === 401 || r.status === 403) hint = ' — ключ неверный или нет доступа';
    if (r.status === 429) hint = ' — лимит исчерпан';
    if (r.status === 404) hint = ' — модель не найдена';
    if (r.status === 400) hint = ' — возможно, модель не умеет инструменты';
    throw new Error(`HTTP ${r.status}${hint}: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const data = JSON.parse(raw);
  return data && data.choices && data.choices[0] && data.choices[0].message;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return text(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/api/activity') {
      return json(res, 200, ACTIVITY);
    }

    if (p === '/api/lan' && req.method === 'GET') {
      const u = new URL(req.url, 'http://local');
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      lanTouch(lanIp(req));
      return json(res, 200, {
        peers: Object.keys(LAN_PEERS).length,
        me: lanIp(req),
        messages: LAN_MSGS.filter((m) => m.id > since).slice(-50)
      });
    }

    if (p === '/api/lan' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return json(res, 400, { error: 'Пустое сообщение' });
      const ip = lanIp(req);
      lanTouch(ip);
      LAN_SEQ += 1;
      LAN_MSGS.push({ id: LAN_SEQ, from: String(body.from || ip).slice(0, 40), ip, text, at: Date.now() });
      if (LAN_MSGS.length > 200) LAN_MSGS = LAN_MSGS.slice(-200);
      return json(res, 200, { ok: true, id: LAN_SEQ });
    }

    if (req.method === 'GET' && p === '/api/config') {
      const providers = {};
      for (const [k, v] of Object.entries(PROVIDERS)) {
        providers[k] = { title: v.title || k, defaultModel: v.defaultModel || '' };
      }
      const addr = String(req.socket.remoteAddress || '');
      const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

      return json(res, 200, {
        providers,
        pinRequired: !!PIN,
        pin: local ? PIN : '',
        workdir: WORKDIR,
        mode: String(cfg.mode || 'coding'),
        defaultProvider: String(cfg.defaultProvider || '')
      });
    }

    if (req.method === 'POST' && p === '/api/chat') {
      const body = await readBody(req, 256 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });
      if (PIN && String(body.pin || '') !== PIN) return json(res, 401, { error: 'Неверный PIN' });

      const prov = pickProvider(body.provider);
      if (!prov || !prov.baseUrl) return json(res, 400, { error: 'Неизвестный сервис' });

      const key = String(body.key || '').trim();
      const model = String(body.model || '').trim() || prov.defaultModel || '';
      if (!model) return json(res, 400, { error: 'Модель не задана' });

      const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];

      try {
        if (PIN) {
          const out = await agentTurn(prov, key, model, history);
          return json(res, 200, out);
        }
        const messages = [{ role: 'system', content: SYSTEM }, ...history];
        const msg = await callModel(prov, key, model, messages, null);
        return json(res, 200, { reply: (msg && msg.content) || '(пустой ответ)' });
      } catch (e) {
        return json(res, 200, { error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/agent') {
      const body = await readBody(req, 512 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });

      if (!PIN) {
        return json(res, 403, { error: 'Режим агента выключен: задайте "pin" в web/config.json и перезапустите сервер' });
      }
      if (String(body.pin || '') !== PIN) return json(res, 401, { error: 'Неверный PIN' });

      const prov = pickProvider(body.provider);
      if (!prov || !prov.baseUrl) return json(res, 400, { error: 'Неизвестный сервис' });

      const key = String(body.key || '').trim();
      const model = String(body.model || '').trim() || prov.defaultModel || '';
      if (!model) return json(res, 400, { error: 'Модель не задана' });

      const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
      const out = await agentTurn(prov, key, model, history);
      return json(res, 200, out);
    }

    if (p === '/api/update/check' && req.method === 'GET') {
      const info = await updateInfo();
      return json(res, 200, Object.assign({ current: String(cfg.version || '0.0.0') }, info));
    }

    if (p === '/api/update/apply' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });
      if (String(body.pin || '') !== PIN) return json(res, 401, { error: 'Неверный PIN' });
      const info = await updateInfo();
      if (info.error) return json(res, 400, { error: info.error });
      if (!info.zip) return json(res, 400, { error: 'В манифесте нет ссылки на архив' });
      try {
        const tmpZip = path.join(os.tmpdir(), 'klodoks-update-' + Date.now() + '.zip');
        const r = await fetch(info.zip);
        if (!r.ok) throw new Error('Архив не скачался: HTTP ' + r.status);
        fs.writeFileSync(tmpZip, Buffer.from(await r.arrayBuffer()));
        const target = path.resolve(__dirname, '..');
        await new Promise((ok, bad) => {
          const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            'Expand-Archive -LiteralPath "' + tmpZip + '" -DestinationPath "' + target + '" -Force'], { windowsHide: true });
          ps.on('exit', (code) => code === 0 ? ok() : bad(new Error('Распаковка не удалась, код ' + code)));
          ps.on('error', bad);
        });
        return json(res, 200, { ok: true, version: info.latest, needRestart: true });
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    if (p === '/api/agents' && req.method === 'GET') {
      const dir = path.join(os.homedir(), '.claude', 'agents');
      let items = [];
      try {
        items = fs.readdirSync(dir)
          .filter(function (f) { return f.toLowerCase().endsWith('.md'); })
          .map(function (f) {
            const txt = fs.readFileSync(path.join(dir, f), 'utf8');
            const name = (txt.match(/^name:\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
            const desc = (txt.match(/^description:\s*(.+)$/m) || [])[1] || '';
            return { file: f, name: String(name).trim(), description: String(desc).trim() };
          });
      } catch (e) { }
      return json(res, 200, { dir: dir, agents: items });
    }

    if (p === '/api/agents' && req.method === 'POST') {
      if (!PIN) return json(res, 403, { error: 'Задайте "pin" в web/config.json' });
      const body = await readBody(req, 64 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });
      if (String(body.pin || '') !== PIN) return json(res, 401, { error: 'Неверный PIN' });

      const request = String(body.request || body.description || '').trim();
      const rawName = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      const tools = String(body.tools || 'Read, Grep, Glob').trim();
      const fallbackDescription = request || 'Пользовательский агент';

      let content = null;
      let usedModel = false;

      if (request) {
        const prov = pickProvider(body.provider);
        const key = String(body.key || '').trim();
        const model = String(body.model || '').trim() || (prov && prov.defaultModel) || '';
        if (prov && prov.baseUrl && model) {
          try {
            const prompt = 'Составь файл агента Claude Code по запросу пользователя.\n\nЗапрос: ' + request +
              '\n\nВерни ТОЛЬКО содержимое файла, без пояснений: YAML frontmatter (name латиницей, description на русском — когда вызывать агента, tools — только нужные из Read, Grep, Glob, Bash, Write, Edit, model: inherit), а ниже подробную инструкцию агенту на русском.';
            const msg = await callModel(prov, key, model, [{ role: 'user', content: prompt }], null);
            let t = String((msg && msg.content) || '');
            t = t.replace(/```[a-zA-Z]*\r?\n/g, '').replace(/```/g, '');
            const idx = t.indexOf('---');
            if (idx >= 0) {
              const cand = t.slice(idx).trim();
              if (/^name:/m.test(cand) && /^description:/m.test(cand)) {
                content = cand;
                usedModel = true;
              }
            }
          } catch (e) { }
        }
      }

      let name = rawName;
      if (!name && content) {
        const m = content.match(/^name:\s*([A-Za-z0-9._-]+)/m);
        if (m) name = m[1].toLowerCase();
      }
      if (!name) name = 'agent-' + Date.now().toString(36);

      const dir = path.join(os.homedir(), '.claude', 'agents');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
      const file = path.join(dir, name + '.md');
      if (fs.existsSync(file)) return json(res, 409, { error: 'Агент с таким именем уже есть' });

      if (!content) {
        content = [
          '---',
          'name: ' + name,
          'description: ' + fallbackDescription,
          'tools: ' + tools,
          'model: inherit',
          '---',
          '',
          'Ты — агент «' + name + '». ' + fallbackDescription,
          '',
          '## Порядок работы',
          '1. Разберись в задаче и посмотри нужные файлы.',
          '2. Выполни работу аккуратно и до конца.',
          '3. Проверь результат.',
          '',
          '## Формат отчёта',
          'Кратко: что сделано, что проверено, что осталось.',
          ''
        ].join('\n');
      }

      try {
        fs.writeFileSync(file, content, 'utf8');
        return json(res, 200, { ok: true, file: file, name: name });
      } catch (e) {
        return json(res, 500, { error: 'Не удалось записать: ' + e.message });
      }
    }

    if (req.method === 'POST' && p === '/api/action') {
      if (!PIN) return json(res, 403, { error: 'Задайте "pin" в web/config.json' });
      const body = await readBody(req, 16 * 1024);
      if (!body) return json(res, 400, { error: 'Неверный запрос' });
      if (String(body.pin || '') !== PIN) return json(res, 401, { error: 'Неверный PIN' });

      const action = String(body.action || '').toLowerCase();
      const arg = String(body.arg || '').trim();

      const apps = {
        'notepad': 'notepad.exe', 'блокнот': 'notepad.exe',
        'calc': 'calc.exe', 'калькулятор': 'calc.exe',
        'paint': 'mspaint.exe', 'проводник': 'explorer.exe', 'explorer': 'explorer.exe',
        'edge': 'msedge.exe', 'chrome': 'chrome.exe', 'браузер': 'msedge.exe'
      };

      const sendKey = function (ch) {
        try {
          spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
            '(New-Object -ComObject WScript.Shell).SendKeys([char]' + ch + ')'],
            { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
          return true;
        } catch (e) { return false; }
      };

      try {
        if (action === 'open_url') {
          if (!/^https?:\/\//i.test(arg)) return json(res, 400, { error: 'Разрешены только http/https ссылки' });
          spawn('cmd.exe', ['/c', 'start', '""', arg], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, done: 'открываю ' + arg });
        }

        if (action === 'open_app') {
          const exe = apps[arg.toLowerCase()];
          if (!exe) return json(res, 400, { error: 'Приложение не в списке разрешённых: ' + arg });
          spawn(exe, [], { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, done: 'запускаю ' + arg });
        }

        if (action === 'volume') {
          if (arg === 'up') { sendKey(175); return json(res, 200, { ok: true, done: 'громче' }); }
          if (arg === 'down') { sendKey(174); return json(res, 200, { ok: true, done: 'тише' }); }
          if (arg === 'mute') { sendKey(173); return json(res, 200, { ok: true, done: 'звук выключен' }); }
          return json(res, 400, { error: 'volume: up | down | mute' });
        }

        if (action === 'media') {
          sendKey(179);
          return json(res, 200, { ok: true, done: 'пауза/плей' });
        }

        return json(res, 400, { error: 'Неизвестное действие: ' + action });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    return text(res, 404, 'Not found');
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const ips = lanAddresses();
  console.log('');
  console.log('  ИИ-меню запущено');
  console.log('  ------------------------------------------');
  console.log(`  На этом ПК:  http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('  Адрес в сети не найден (нет Wi-Fi/Ethernet?)');
  } else {
    for (const ip of ips) console.log(`  С телефона:  http://${ip}:${PORT}`);
  }
  console.log('  ------------------------------------------');
  console.log(`  Рабочая папка агента: ${WORKDIR}`);
  console.log(`  PIN: ${PIN ? 'включён (агент доступен)' : 'выключен (агент заблокирован)'}`);
  console.log('');
  console.log('  Окно не закрывать. Ctrl+C — остановить.');
  console.log('');
});
