import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---- carrega o arquivo .env (sem dependências) ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { load, db, save, newId, normalizePhone, cleanup, MENSAGEM_PADRAO } = await import('./store.js');
const WA = await import('./whatsapp.js');
const A = await import('./agenda.js');
const { relativeDay, shortLabel, localDate } = await import('./time.js');

const PORT = +(process.env.PORT || 3000);
const SENHA = process.env.SENHA_PAINEL || '';
if (!SENHA) console.warn('⚠️  SENHA_PAINEL não definida no .env — defina uma senha antes de usar de verdade.');

load();
const segredoFile = path.resolve(process.env.PASTA_DADOS || 'dados', 'segredo');
let SEGREDO = process.env.SEGREDO;
if (!SEGREDO) {
  if (!fs.existsSync(segredoFile)) fs.writeFileSync(segredoFile, randomBytes(32).toString('hex'));
  SEGREDO = fs.readFileSync(segredoFile, 'utf8').trim();
}

// ---- utilidades HTTP ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw new Error('grande demais');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const assinatura = () => createHmac('sha256', SEGREDO).update('painel:' + SENHA).digest('base64url');
function logado(req) {
  const c = cookies(req).sessao || '';
  const a = assinatura();
  return c.length === a.length && timingSafeEqual(Buffer.from(c), Buffer.from(a));
}

const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  return t && t.n >= 8 && Date.now() - t.em < 15 * 60000;
}
function falhou(ip) {
  const t = tentativas.get(ip) || { n: 0, em: Date.now() };
  if (Date.now() - t.em > 15 * 60000) { t.n = 0; t.em = Date.now(); }
  t.n++;
  tentativas.set(ip, t);
}

// ---- páginas ----
const PAINEL = () => fs.readFileSync(path.join(ROOT, 'public', 'painel.html'), 'utf8');

const BASE_CSS = `
:root{--bg:#f4f1ec;--card:#fff;--ink:#1c1b19;--muted:#6f6a62;--line:#e4dfd6;--accent:#0f7b4f;--accent-ink:#fff;--no:#b3261e;--no-bg:#fbeceb}
@media (prefers-color-scheme:dark){:root{--bg:#131311;--card:#1e1d1a;--ink:#f1ede6;--muted:#a19b90;--line:#33312c;--accent:#3fbf86;--accent-ink:#06210f;--no:#f2857c;--no-bg:#3a1d1a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:440px;margin:0 auto;padding:32px 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px}
h1{font-size:26px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}
.muted{color:var(--muted)}.small{font-size:14px}
.when{font-size:20px;font-weight:650;margin:18px 0 22px}
.btn{display:block;width:100%;border:0;border-radius:14px;padding:17px;font:inherit;font-size:18px;font-weight:650;cursor:pointer;margin-top:12px}
.yes{background:var(--accent);color:var(--accent-ink)}.no{background:var(--no-bg);color:var(--no)}
.big{font-size:56px;line-height:1;margin-bottom:12px}
input{width:100%;font:inherit;padding:14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin-top:8px}
.foot{text-align:center;margin-top:18px}
`;

function pagina(titulo, conteudo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title><style>${BASE_CSS}</style></head><body><main class="wrap">${conteudo}</main></body></html>`;
}

function paginaConfirmacao(s, aviso = '') {
  const { config } = db();
  const primeiro = esc((s.nome || '').split(/\s+/)[0]);
  const quando = `${relativeDay(s.data)} às ${s.hora}`;
  const encerrado = Date.now() > s.inicio + 2 * 3600000;
  if (s.status === 'pulado') {
    return pagina('Treino', `<div class="card"><h1>Este lembrete foi cancelado</h1><p class="muted">Fale direto com ${esc(config.personal)} se tiver dúvida.</p></div>`);
  }
  if (encerrado) {
    return pagina('Treino', `<div class="card"><h1>Esse horário já passou</h1><p class="muted">Treino de ${esc(shortLabel(s.data))} às ${esc(s.hora)}.</p></div>`);
  }
  let topo = `<h1>Olá, ${primeiro}!</h1><p class="muted" style="margin:0">Você vai ao treino?</p>`;
  if (s.status === 'confirmado') topo = `<div class="big">✅</div><h1>Presença confirmada!</h1><p class="muted" style="margin:0">Até lá, ${primeiro} 💪</p>`;
  if (s.status === 'cancelado') topo = `<div class="big">👋</div><h1>Tudo certo, ${primeiro}.</h1><p class="muted" style="margin:0">Avisamos que você não vai.</p>`;
  const respondido = s.status === 'confirmado' || s.status === 'cancelado';
  const botoes = `
    <form method="post">
      ${s.status !== 'confirmado' ? '<button class="btn yes" name="r" value="sim">✅ Vou, confirmo</button>' : ''}
      ${s.status !== 'cancelado' ? `<button class="btn no" name="r" value="nao">❌ ${respondido ? 'Mudei de ideia, não vou' : 'Não vou'}</button>` : ''}
      ${s.status === 'cancelado' ? '<button class="btn yes" name="r" value="sim">✅ Mudei de ideia, vou</button>' : ''}
    </form>`;
  return pagina('Confirmar treino', `
    <div class="card">
      ${topo}
      <div class="when">🗓️ ${esc(quando[0].toUpperCase() + quando.slice(1))}<div class="small muted" style="font-weight:400">${esc(shortLabel(s.data))}</div></div>
      ${aviso}
      ${botoes}
    </div>
    <p class="foot small muted">${esc(config.personal)}</p>`);
}

function paginaLogin(erro = '') {
  return pagina('Entrar', `
    <div class="card">
      <h1>Lembretes de treino</h1>
      <p class="muted">Digite a senha do painel.</p>
      ${erro ? `<p style="color:var(--no)">${esc(erro)}</p>` : ''}
      <form method="post" action="/entrar">
        <input type="password" name="senha" autocomplete="current-password" autofocus required>
        <button class="btn yes">Entrar</button>
      </form>
    </div>`);
}

// ---- API do painel ----
function estado() {
  const d = db();
  return {
    whatsapp: WA.wa.estado,
    config: d.config,
    mensagemPadrao: MENSAGEM_PADRAO,
    urlPublica: process.env.URL_PUBLICA || '',
    hoje: localDate(),
    semSenha: !SENHA,
  };
}

function limparAluno(input, existente = {}) {
  const nome = String(input.nome ?? existente.nome ?? '').trim().slice(0, 80);
  const telefone = normalizePhone(input.telefone ?? existente.telefone);
  if (!nome) throw new Error('Informe o nome');
  if (telefone.length < 12) throw new Error('Telefone inválido. Use DDD + número, ex: 99 98123-4567');
  const horarios = (Array.isArray(input.horarios) ? input.horarios : existente.horarios || [])
    .map((h) => ({ dia: +h.dia, hora: String(h.hora || '').slice(0, 5) }))
    .filter((h) => h.dia >= 0 && h.dia <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.hora));
  const vistos = new Set();
  const unicos = horarios.filter((h) => { const k = h.dia + h.hora; if (vistos.has(k)) return false; vistos.add(k); return true; });
  unicos.sort((a, b) => ((a.dia + 6) % 7) - ((b.dia + 6) % 7) || a.hora.localeCompare(b.hora));
  return {
    ...existente,
    nome, telefone,
    ativo: input.ativo === undefined ? existente.ativo ?? true : !!input.ativo,
    horarios: unicos,
    ...(telefone !== existente.telefone ? { jid: undefined } : {}),
  };
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const d = db();
  if (m !== 'GET' && req.headers['x-painel'] !== '1') return json(res, 403, { erro: 'Requisição inválida' });
  const b = m === 'GET' ? {} : await body(req);

  if (p === '/api/estado' && m === 'GET') return json(res, 200, estado());
  if (p === '/api/agenda' && m === 'GET') return json(res, 200, { itens: A.agenda(+(url.searchParams.get('dias') || 2)) });
  if (p === '/api/alunos' && m === 'GET') return json(res, 200, { alunos: d.alunos });

  if (p === '/api/alunos' && m === 'POST') {
    const a = limparAluno(b);
    a.id = newId();
    a.criadoEm = Date.now();
    d.alunos.push(a);
    save();
    return json(res, 200, { aluno: a });
  }
  const ma = p.match(/^\/api\/alunos\/([\w-]+)$/);
  if (ma) {
    const i = d.alunos.findIndex((a) => a.id === ma[1]);
    if (i < 0) return json(res, 404, { erro: 'Aluno não encontrado' });
    if (m === 'PUT') {
      d.alunos[i] = limparAluno(b, d.alunos[i]);
      save();
      return json(res, 200, { aluno: d.alunos[i] });
    }
    if (m === 'DELETE') {
      d.alunos.splice(i, 1);
      save();
      return json(res, 200, { ok: true });
    }
  }

  if (p === '/api/config' && m === 'PUT') {
    const c = d.config;
    if (b.personal !== undefined) c.personal = String(b.personal).trim().slice(0, 60);
    if (b.telefonePersonal !== undefined) c.telefonePersonal = b.telefonePersonal ? normalizePhone(b.telefonePersonal) : '';
    if (b.antecedenciaMin !== undefined) c.antecedenciaMin = Math.max(10, Math.min(24 * 60, +b.antecedenciaMin || 120));
    if (b.mensagem !== undefined) {
      const msg = String(b.mensagem).slice(0, 1500);
      if (!msg.includes('{link}')) throw new Error('A mensagem precisa ter {link} para o aluno conseguir confirmar');
      c.mensagem = msg;
    }
    if (b.avisarPersonal !== undefined) c.avisarPersonal = !!b.avisarPersonal;
    if (b.pausado !== undefined) c.pausado = !!b.pausado;
    save();
    return json(res, 200, { config: c });
  }

  if (p === '/api/previa' && m === 'POST') {
    const amostra = { nome: b.nome || 'Maria Souza', data: localDate(), hora: '17:00', token: 'exemplo' };
    const original = d.config.mensagem;
    if (b.mensagem) d.config.mensagem = b.mensagem;
    const texto = A.montarMensagem(amostra);
    d.config.mensagem = original;
    return json(res, 200, { texto });
  }

  if (p === '/api/agenda/enviar' && m === 'POST') return json(res, 200, { sessao: await A.enviarAgora(b.chave) });
  if (p === '/api/agenda/pular' && m === 'POST') { A.pular(b.chave, !!b.pular); return json(res, 200, { ok: true }); }

  if (p === '/api/whatsapp/codigo' && m === 'POST') {
    const tel = normalizePhone(b.telefone);
    if (tel.length < 12) throw new Error('Digite o número do WhatsApp que vai enviar os lembretes, com DDD');
    const codigo = await WA.pedirCodigo(tel);
    return json(res, 200, { codigo });
  }
  if (p === '/api/whatsapp/desconectar' && m === 'POST') {
    await WA.desconectar();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/whatsapp/teste' && m === 'POST') {
    const tel = normalizePhone(b.telefone || d.config.telefonePersonal);
    if (tel.length < 12) throw new Error('Informe um número para o teste');
    const jid = await WA.resolverJid(tel);
    await WA.enviarTexto(jid, '✅ Teste do bot de lembretes: está tudo funcionando!');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/teste/enviadas' && m === 'GET' && process.env.MOCK_WA === '1') return json(res, 200, { enviadas: WA.wa.enviadas });

  return json(res, 404, { erro: 'Não encontrado' });
}

// ---- servidor ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  try {
    // página de confirmação do aluno (pública)
    const mc = p.match(/^\/c\/([\w-]{6,40})$/);
    if (mc) {
      const s = A.sessaoPorToken(mc[1]);
      if (!s) return send(res, 404, pagina('Link inválido', '<div class="card"><h1>Link não encontrado</h1><p class="muted">Esse lembrete pode ter expirado.</p></div>'));
      if (req.method === 'POST') {
        const b = await body(req);
        const encerrado = Date.now() > s.inicio + 2 * 3600000;
        if (!encerrado && s.status !== 'pulado' && (b.r === 'sim' || b.r === 'nao')) await A.responder(s, b.r === 'sim', 'link');
        res.writeHead(303, { Location: p });
        return res.end();
      }
      return send(res, 200, paginaConfirmacao(s));
    }

    if (p === '/' ) { res.writeHead(302, { Location: '/painel' }); return res.end(); }
    if (p === '/saude') return send(res, 200, 'ok', 'text/plain');

    if (p === '/entrar' && req.method === 'POST') {
      if (bloqueado(ip)) return send(res, 429, paginaLogin('Muitas tentativas. Espere 15 minutos.'));
      const b = await body(req);
      const ok = SENHA && typeof b.senha === 'string' && b.senha.length === SENHA.length &&
        timingSafeEqual(Buffer.from(b.senha), Buffer.from(SENHA));
      if (!ok) { falhou(ip); return send(res, 401, paginaLogin('Senha incorreta.')); }
      res.writeHead(303, {
        Location: '/painel',
        'Set-Cookie': `sessao=${assinatura()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90 * 86400}`,
      });
      return res.end();
    }
    if (p === '/sair') {
      res.writeHead(303, { Location: '/painel', 'Set-Cookie': 'sessao=; Path=/; Max-Age=0' });
      return res.end();
    }

    if (p === '/painel') {
      if (!SENHA) return send(res, 500, pagina('Configurar', '<div class="card"><h1>Falta a senha</h1><p class="muted">Defina SENHA_PAINEL no arquivo .env e reinicie o bot.</p></div>'));
      return send(res, 200, logado(req) ? PAINEL() : paginaLogin());
    }

    if (p.startsWith('/api/')) {
      if (!logado(req)) return json(res, 401, { erro: 'Faça login de novo' });
      return await api(req, res, url);
    }

    return send(res, 404, pagina('Não encontrado', '<div class="card"><h1>Página não encontrada</h1></div>'));
  } catch (e) {
    if (p.startsWith('/api/')) return json(res, 400, { erro: String(e?.message || e) });
    console.error('[http]', e);
    return send(res, 500, pagina('Erro', '<div class="card"><h1>Algo deu errado</h1><p class="muted">Tente de novo em instantes.</p></div>'));
  }
});

server.listen(PORT, () => {
  console.log(`Bot de lembretes rodando na porta ${PORT}`);
  console.log(`Painel: ${(process.env.URL_PUBLICA || `http://localhost:${PORT}`).replace(/\/+$/, '')}/painel`);
});

WA.wa.on('mensagem', (m) => A.mensagemRecebida(m).catch((e) => console.error('[mensagem]', e)));
WA.iniciar();

setInterval(() => A.tick().catch((e) => console.error('[agenda]', e)), 30_000);
setTimeout(() => A.tick().catch(() => {}), 5000);
setInterval(cleanup, 6 * 3600000);
cleanup();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
