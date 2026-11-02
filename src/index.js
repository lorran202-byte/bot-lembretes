// Bot de lembretes de treino para o WhatsApp (API oficial da Meta), rodando no Cloudflare Workers.
// - O personal administra tudo pelo próprio WhatsApp (menus com botões e listas).
// - O aluno recebe o lembrete (modelo aprovado pela Meta) com os botões "Sim, vou" / "Não vou".
// - Um "cron" roda a cada minuto e envia os lembretes na hora certa.

import { localDate, localTime, toEpoch, addDays, weekday, relativeDay, shortLabel, DIAS_CURTOS } from './tempo.js';

// ===================================================================
// Utilidades
// ===================================================================

const Dia = (d) => DIAS_CURTOS[d][0].toUpperCase() + DIAS_CURTOS[d].slice(1);
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const digitos = (s) => String(s || '').replace(/\D/g, '');
const tamanho = (s) => [...String(s)].length;
const corta = (s, n) => { const a = [...String(s ?? '')]; return a.length <= n ? a.join('') : a.slice(0, n - 1).join('') + '…'; };
const umaLinha = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function novoId(n = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => abc[x % abc.length]).join('');
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function hmacHex(chave, dados) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(chave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(dados)));
}
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ===================================================================
// API do WhatsApp (Graph API da Meta)
// ===================================================================

const VERSAO_API = 'v24.0';
const SEGREDOS = ['WA_TOKEN', 'WA_PHONE_ID', 'WA_WABA_ID', 'WA_APP_ID', 'WA_APP_SECRET'];

class WaErro extends Error {
  constructor(e = {}) {
    super(e.error_user_msg || e.message || 'Erro na API do WhatsApp');
    this.code = e.code;
    this.detalhes = e.error_data?.details;
  }
}

async function graph(env, caminho, { method = 'POST', corpo, token } = {}) {
  const base = env.WA_API || `https://graph.facebook.com/${VERSAO_API}`;
  const r = await fetch(`${base}/${caminho}`, {
    method,
    headers: { Authorization: `Bearer ${token || env.WA_TOKEN}`, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const j = await r.json().catch(() => ({ error: { message: `resposta inválida (HTTP ${r.status})` } }));
  if (!r.ok || j.error) throw new WaErro(j.error || { message: `HTTP ${r.status}` });
  return j;
}

/** Envia uma mensagem e devolve o id dela (wamid). */
async function enviarWa(env, para, msg) {
  const j = await graph(env, `${env.WA_PHONE_ID}/messages`, {
    corpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(para), ...msg },
  });
  return j.messages?.[0]?.id || null;
}

const mTexto = (texto) => ({ type: 'text', text: { body: corta(texto, 4096), preview_url: false } });

/** Texto com opções: até 3 opções curtas viram botões; mais que isso vira lista (até 10). */
function mMenu(texto, opcoes = [], botaoLista = 'Ver opções') {
  const ops = opcoes.filter(Boolean);
  if (!ops.length) return mTexto(texto);
  if (ops.length <= 3 && ops.every((o) => tamanho(o[1]) <= 20) && tamanho(texto) <= 1024) {
    return {
      type: 'interactive',
      interactive: { type: 'button', body: { text: texto }, action: { buttons: ops.map(([id, t]) => ({ type: 'reply', reply: { id, title: t } })) } },
    };
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: corta(texto, 4096) },
      action: {
        button: corta(botaoLista, 20),
        sections: [{ title: 'Opções', rows: ops.slice(0, 10).map(([id, t, d]) => ({ id, title: corta(t, 24), ...(d ? { description: corta(d, 72) } : {}) })) }],
      },
    },
  };
}

const mLink = (texto, rotulo, url) => ({
  type: 'interactive',
  interactive: { type: 'cta_url', body: { text: corta(texto, 1024) }, action: { name: 'cta_url', parameters: { display_text: corta(rotulo, 20), url } } },
});

const ERROS = {
  190: 'O token do WhatsApp (WA_TOKEN) expirou ou está errado',
  368: 'A Meta bloqueou temporariamente os envios deste número',
  131026: 'O WhatsApp não conseguiu entregar (o aluno pode ter bloqueado o número do bot ou estar com o WhatsApp desatualizado)',
  131030: 'Esse número não está na lista de números de teste da Meta',
  131031: 'A conta do WhatsApp do bot foi bloqueada pela Meta',
  131042: 'Falta cadastrar uma forma de pagamento na Meta',
  131047: 'Passaram mais de 24h desde a última mensagem dessa pessoa',
  131049: 'A Meta decidiu não entregar essa mensagem agora',
  131056: 'Muitas mensagens seguidas para o mesmo número; tente de novo em alguns minutos',
  132000: 'A mensagem do lembrete foi montada errado',
  132001: 'A mensagem do lembrete ainda não foi aprovada pela Meta',
  132015: 'A mensagem do lembrete foi pausada pela Meta',
  132016: 'A mensagem do lembrete foi desativada pela Meta',
  133010: 'O número do bot não está registrado; abra o endereço do bot para registrar',
};
const explicarErro = (e) => ERROS[e?.code] || [e?.message, e?.detalhes].filter(Boolean).join(' — ') || 'erro desconhecido';

// ===================================================================
// Modelos de mensagem (precisam ser aprovados pela Meta)
// ===================================================================

const IDIOMA = 'pt_BR';
const MODELO_LEMBRETE = 'lembrete_treino';
const MODELO_AVISOS = 'avisos_personal';

const MODELOS = [
  {
    name: MODELO_LEMBRETE, language: IDIOMA, category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Olá, {{1}}! 💪\n\nLembrete do seu treino *{{2}}* com {{3}}.\n\nVocê vai?', example: { body_text: [['Maria', 'hoje às 17:00', 'Prof. Lorran']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sim, vou' }, { type: 'QUICK_REPLY', text: 'Não vou' }] },
    ],
  },
  {
    name: MODELO_AVISOS, language: IDIOMA, category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Você tem {{1}} aviso(s) novo(s) sobre os treinos dos seus alunos. Toque abaixo para ver.', example: { body_text: [['3']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Ver avisos' }] },
    ],
  },
];

const parametro = (t) => ({ type: 'text', text: corta(umaLinha(t), 60) || '-' });
const botaoModelo = (i, payload) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] });

function modeloLembrete(cfg, s) {
  return {
    type: 'template',
    template: {
      name: MODELO_LEMBRETE, language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: [parametro(primeiroNome(s.nome)), parametro(`${relativeDay(s.data)} às ${s.hora}`), parametro(cfg.personal)] },
        botaoModelo(0, `r:${s.chave}:1`),
        botaoModelo(1, `r:${s.chave}:0`),
      ],
    },
  };
}

const modeloAvisos = (n) => ({
  type: 'template',
  template: { name: MODELO_AVISOS, language: { code: IDIOMA }, components: [{ type: 'body', parameters: [parametro(n)] }, botaoModelo(0, 'avisos')] },
});

// ===================================================================
// Banco de dados (Cloudflare D1)
// ===================================================================

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS alunos (
     id TEXT PRIMARY KEY, nome TEXT NOT NULL, wa TEXT, convite TEXT UNIQUE,
     ativo INTEGER NOT NULL DEFAULT 1, horarios TEXT NOT NULL DEFAULT '[]', criado INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessoes (
     chave TEXT PRIMARY KEY, aluno_id TEXT, nome TEXT, wa TEXT, data TEXT, hora TEXT,
     inicio INTEGER, status TEXT, wamid TEXT, enviado INTEGER, respondido INTEGER, erro TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessoes_data ON sessoes(data)`,
  `CREATE TABLE IF NOT EXISTS conversas (wa TEXT PRIMARY KEY, estado TEXT, em INTEGER)`,
  `CREATE TABLE IF NOT EXISTS avisos (id INTEGER PRIMARY KEY AUTOINCREMENT, texto TEXT, em INTEGER)`,
  `CREATE TABLE IF NOT EXISTS vistos (id TEXT PRIMARY KEY, em INTEGER)`,
];
// colunas novas em bancos criados pela versão do Telegram
const COLUNAS_NOVAS = ['ALTER TABLE alunos ADD COLUMN wa TEXT', 'ALTER TABLE sessoes ADD COLUMN wa TEXT', 'ALTER TABLE sessoes ADD COLUMN wamid TEXT'];

let schemaOk = false;
async function prepararBanco(env) {
  if (schemaOk) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const s of COLUNAS_NOVAS) await env.DB.prepare(s).run().catch(() => {});
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS sessoes_wamid ON sessoes(wamid)').run();
  // Veio da versão do Telegram? Mantém alunos e horários, mas cada um precisa ativar de novo pelo WhatsApp.
  const canal = await env.DB.prepare("SELECT v FROM config WHERE k = 'canal'").first();
  if (!canal || canal.v !== 'whatsapp') {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM config WHERE k IN ('admin', 'bot')"),
      env.DB.prepare('DELETE FROM sessoes'),
      env.DB.prepare("INSERT INTO config (k, v) VALUES ('canal', 'whatsapp') ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    ]);
  }
  schemaOk = true;
}

const sql = (env, s, ...p) => env.DB.prepare(s).bind(...p);
const todos = async (env, s, ...p) => (await sql(env, s, ...p).all()).results || [];
const um = (env, s, ...p) => sql(env, s, ...p).first();
const exec = (env, s, ...p) => sql(env, s, ...p).run();

const CONFIG_PADRAO = {
  personal: 'seu personal', antecedencia: '120', pausado: '0', admin: '', numero: '',
  codigo_admin: '', admin_ultimo: '0', avisos_tpl: '0', pin: '',
};
async function lerConfig(env) {
  const c = { ...CONFIG_PADRAO };
  for (const r of await todos(env, 'SELECT k, v FROM config')) c[r.k] = r.v;
  return c;
}
const salvarConfig = (env, k, v) =>
  exec(env, 'INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));

const lerAluno = async (env, id) => {
  const a = await um(env, 'SELECT * FROM alunos WHERE id = ?', id);
  return a && { ...a, horarios: JSON.parse(a.horarios || '[]') };
};
const lerAlunos = async (env) =>
  (await todos(env, 'SELECT * FROM alunos ORDER BY nome COLLATE NOCASE')).map((a) => ({ ...a, horarios: JSON.parse(a.horarios || '[]') }));

async function lerEstado(env, wa) {
  const r = await um(env, 'SELECT estado, em FROM conversas WHERE wa = ?', wa);
  if (!r || Date.now() - r.em > 30 * 60000) return null; // conversa esquecida depois de 30 min
  return JSON.parse(r.estado);
}
const salvarEstado = (env, wa, e) =>
  e ? exec(env, 'INSERT INTO conversas (wa, estado, em) VALUES (?, ?, ?) ON CONFLICT(wa) DO UPDATE SET estado = excluded.estado, em = excluded.em', wa, JSON.stringify(e), Date.now())
    : exec(env, 'DELETE FROM conversas WHERE wa = ?', wa);

// ===================================================================
// Horários: entende "seg qua sex 17h, ter 18:30", "segunda a sexta 7h" etc.
// ===================================================================

const PALAVRAS_DIA = {
  dom: 0, domingo: 0, domingos: 0,
  seg: 1, segunda: 1, segundas: 1,
  ter: 2, terca: 2, tercas: 2,
  qua: 3, quarta: 3, quartas: 3,
  qui: 4, quinta: 4, quintas: 4,
  sex: 5, sexta: 5, sextas: 5,
  sab: 6, sabado: 6, sabados: 6,
};

export function entenderHorarios(texto) {
  const toks = String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/-?feiras?/g, ' ').replace(/(\d)\s+h\b/g, '$1h').split(/[\s,;/|+]+/).filter(Boolean);
  const out = [];
  let pendentes = [];
  let ultimos = [];
  let anterior = null;
  let intervalo = false;
  for (const t of toks) {
    const tt = t.replace(/[.:]$/, '');
    if (tt in PALAVRAS_DIA) {
      const d = PALAVRAS_DIA[tt];
      if (intervalo && anterior !== null) {
        for (let x = (anterior + 1) % 7; ; x = (x + 1) % 7) { pendentes.push(x); if (x === d) break; }
      } else pendentes.push(d);
      anterior = d;
      intervalo = false;
      continue;
    }
    if (tt === 'a' || tt === 'ate') { intervalo = true; continue; }
    const m = tt.match(/^(\d{1,2})(?:[:h.]?(\d{2}))?(?:h|hs|hrs|horas?)?$/);
    if (m) {
      const h = +m[1], mi = +(m[2] || 0);
      if (h > 23 || mi > 59) continue;
      const hora = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
      const dias = pendentes.length ? pendentes : ultimos;
      for (const d of dias) out.push({ dia: d, hora });
      if (pendentes.length) { ultimos = pendentes; pendentes = []; }
      intervalo = false;
    }
  }
  const vistos = new Set();
  return out
    .filter((x) => { const k = x.dia + x.hora; if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => ((a.dia + 6) % 7) - ((b.dia + 6) % 7) || a.hora.localeCompare(b.hora));
}

const textoHorarios = (hs) => (hs.length ? hs.map((h) => `${Dia(h.dia)} ${h.hora}`).join(' · ') : 'nenhum horário');

// ===================================================================
// Agenda
// ===================================================================

const ROTULOS = {
  agendado: '⏰ lembrete às {envio}',
  enviando: '📤 enviando…',
  pendente: '⏳ sem resposta',
  confirmado: '✅ confirmou',
  cancelado: '❌ não vai',
  pulado: '🚫 lembrete cancelado',
  sem_whatsapp: '⚠️ não ativou os lembretes',
  erro: '⚠️ erro no envio',
  perdido: '— não enviado',
};

const chaveDe = (data, alunoId, hora) => `${data}|${alunoId}|${hora}`;

async function montarAgenda(env, cfg, dias, agora = Date.now()) {
  const hoje = localDate(agora);
  const fim = addDays(hoje, dias);
  const antecedencia = (+cfg.antecedencia || 120) * 60000;
  const alunos = await lerAlunos(env);
  const sess = await todos(env, 'SELECT * FROM sessoes WHERE data >= ? AND data < ?', hoje, fim);
  const porChave = Object.fromEntries(sess.map((s) => [s.chave, s]));
  const itens = [];
  for (let i = 0; i < dias; i++) {
    const data = addDays(hoje, i);
    const wd = weekday(data);
    for (const a of alunos) {
      for (const h of a.horarios) {
        if (h.dia !== wd) continue;
        const chave = chaveDe(data, a.id, h.hora);
        const s = porChave[chave];
        if (!s && !a.ativo) continue;
        const inicio = toEpoch(data, h.hora);
        delete porChave[chave];
        itens.push({
          chave, data, hora: h.hora, inicio, envio: inicio - antecedencia, aluno: a, nome: a.nome,
          status: s ? s.status : inicio <= agora ? 'perdido' : 'agendado', sessao: s || null,
        });
      }
    }
  }
  // lembretes já enviados cujo horário foi alterado/excluído depois
  for (const s of Object.values(porChave)) {
    itens.push({ chave: s.chave, data: s.data, hora: s.hora, inicio: s.inicio, envio: s.inicio - antecedencia, aluno: null, nome: s.nome, status: s.status, sessao: s });
  }
  return itens.sort((x, y) => x.inicio - y.inicio || x.nome.localeCompare(y.nome));
}

const rotulo = (item) => (ROTULOS[item.status] || item.status).replace('{envio}', localTime(item.envio));

// ===================================================================
// Avisos para o personal
// A Meta só deixa mandar mensagem livre até 24h depois da última mensagem da pessoa.
// Fora disso os avisos ficam guardados e vai um modelo "Você tem X avisos" com um botão.
// ===================================================================

const JANELA = 23.5 * 3600000;
const INTERVALO_MODELO_AVISOS = 3 * 3600000;
const janelaAberta = (cfg, agora = Date.now()) => agora - (+cfg.admin_ultimo || 0) < JANELA;

async function avisarAdmin(env, cfg, texto, opcoes) {
  if (!cfg.admin) return;
  if (janelaAberta(cfg)) {
    try { await enviarWa(env, cfg.admin, mMenu(texto, opcoes)); return; } catch (e) {
      if (e.code !== 131047) { console.log('aviso ao personal falhou', e.message); return; }
    }
  }
  await guardarAviso(env, cfg, texto);
}

async function guardarAviso(env, cfg, texto) {
  const agora = Date.now();
  await exec(env, 'INSERT INTO avisos (texto, em) VALUES (?, ?)', texto, agora);
  const ultimo = +((await um(env, "SELECT v FROM config WHERE k = 'avisos_tpl'"))?.v || 0);
  if (agora - ultimo < INTERVALO_MODELO_AVISOS) return;
  await salvarConfig(env, 'avisos_tpl', agora);
  const n = (await um(env, 'SELECT count(*) AS n FROM avisos')).n;
  try { await enviarWa(env, cfg.admin, modeloAvisos(n)); } catch (e) { console.log('modelo de avisos falhou', explicarErro(e)); }
}

/** Entrega os avisos guardados (quando o personal volta a falar com o bot). */
async function entregarAvisos(T) {
  const lista = await todos(T.env, 'SELECT * FROM avisos ORDER BY id');
  if (!lista.length) return false;
  await exec(T.env, 'DELETE FROM avisos WHERE id <= ?', lista.at(-1).id);
  await salvarConfig(T.env, 'avisos_tpl', 0);
  const blocos = [];
  let atual = `📬 *Avisos enquanto você estava fora* (${lista.length})`;
  for (const a of lista) {
    const linha = `\n\n🕒 ${shortLabel(localDate(a.em))} ${localTime(a.em)}\n${a.texto}`;
    if (tamanho(atual + linha) > 4000) { blocos.push(atual); atual = linha.trim(); } else atual += linha;
  }
  blocos.push(atual);
  for (const b of blocos) await enviarWa(T.env, T.para, mTexto(b));
  return true;
}

// ===================================================================
// Envio dos lembretes
// ===================================================================

/** Cria a sessão (uma vez só) e manda o lembrete. Retorna a sessão. */
async function enviarLembrete(env, cfg, item, forcar = false) {
  const a = item.aluno;
  if (forcar) await exec(env, 'DELETE FROM sessoes WHERE chave = ?', item.chave);
  const statusInicial = a.wa ? 'enviando' : 'sem_whatsapp';
  const ins = await exec(env,
    'INSERT OR IGNORE INTO sessoes (chave, aluno_id, nome, wa, data, hora, inicio, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    item.chave, a.id, a.nome, a.wa || null, item.data, item.hora, item.inicio, statusInicial);
  if (!ins.meta || ins.meta.changes !== 1) return null; // outro processo já cuidou

  const s = { chave: item.chave, nome: a.nome, data: item.data, hora: item.hora, wa: a.wa };
  if (!a.wa) {
    await avisarAdmin(env, cfg,
      `⚠️ *${a.nome}* tem treino ${relativeDay(item.data)} às ${item.hora}, mas ainda não ativou os lembretes no WhatsApp.`,
      [[`al:conv:${a.id}`, '🔗 Link de convite']]);
    return { ...s, status: 'sem_whatsapp' };
  }
  try {
    const wamid = await enviarWa(env, a.wa, modeloLembrete(cfg, s));
    await exec(env, 'UPDATE sessoes SET status = ?, wamid = ?, enviado = ?, erro = NULL WHERE chave = ?', 'pendente', wamid, Date.now(), item.chave);
    return { ...s, status: 'pendente' };
  } catch (e) {
    const erro = explicarErro(e);
    await exec(env, 'UPDATE sessoes SET status = ?, erro = ? WHERE chave = ?', 'erro', erro, item.chave);
    await avisarAdmin(env, cfg, `⚠️ Não consegui mandar o lembrete para *${a.nome}* (${item.hora}).\n${erro}.`);
    return { ...s, status: 'erro', erro };
  }
}

async function cron(env, agora = Date.now()) {
  await prepararBanco(env);
  const cfg = await lerConfig(env);
  if (cfg.pausado === '1' || !cfg.admin) return;
  const itens = await montarAgenda(env, cfg, 2, agora);
  for (const it of itens) {
    if (it.status !== 'agendado' || !it.aluno) continue;
    if (agora >= it.envio && agora < it.inicio - 5 * 60000) await enviarLembrete(env, cfg, it);
  }
  // limpeza: guarda só 60 dias de histórico
  if (new Date(agora).getUTCMinutes() === 7) {
    await exec(env, 'DELETE FROM sessoes WHERE inicio < ?', agora - 60 * 86400000);
    await exec(env, 'DELETE FROM vistos WHERE em < ?', agora - 3 * 86400000);
  }
}

/** A Meta avisa depois quando uma mensagem não foi entregue. */
async function aoReceberStatus(env, st) {
  if (st.status !== 'failed') return;
  const s = await um(env, 'SELECT * FROM sessoes WHERE wamid = ?', st.id);
  if (!s) return;
  const e = st.errors?.[0] || {};
  const erro = explicarErro({ code: e.code, message: e.title || e.message, detalhes: e.error_data?.details });
  await exec(env, "UPDATE sessoes SET status = 'erro', erro = ? WHERE chave = ?", erro, s.chave);
  const cfg = await lerConfig(env);
  const convite = e.code === 131026 && s.aluno_id ? [[`al:conv:${s.aluno_id}`, '🔗 Link de convite']] : undefined;
  await avisarAdmin(env, cfg, `⚠️ O lembrete de *${s.nome}* (${relativeDay(s.data)} às ${s.hora}) não foi entregue.\n${erro}.`, convite);
}

// ===================================================================
// Respostas do aluno
// ===================================================================

async function respostaAluno(T, chave, vai) {
  const { env, cfg } = T;
  const s = await um(env, 'SELECT * FROM sessoes WHERE chave = ?', chave);
  if (!s || (s.wa && s.wa !== T.para)) return enviarWa(env, T.para, mTexto('Esse lembrete não foi encontrado.'));
  if (Date.now() > s.inicio + 2 * 3600000) return enviarWa(env, T.para, mTexto('Esse horário já passou. 🙂'));
  if (s.status === 'pulado') return enviarWa(env, T.para, mTexto(`Esse lembrete foi cancelado por ${cfg.personal}.`));

  const novo = vai ? 'confirmado' : 'cancelado';
  const mudou = s.status !== novo;
  if (mudou) await exec(env, 'UPDATE sessoes SET status = ?, respondido = ? WHERE chave = ?', novo, Date.now(), chave);

  const nome = primeiroNome(s.nome);
  const quando = `${relativeDay(s.data)} às ${s.hora}`;
  await enviarWa(env, T.para, vai
    ? mMenu(`✅ *Presença confirmada!* Treino ${quando}. Até lá, ${nome} 💪`, [[`r:${chave}:0`, '↩️ Não vou mais']])
    : mMenu(`👋 *Tudo certo, ${nome}.* Avisei que você não vai ${quando}.`, [[`r:${chave}:1`, '↩️ Vou sim']]));

  if (mudou) {
    const mudouIdeia = s.status === 'confirmado' || s.status === 'cancelado';
    await avisarAdmin(env, cfg, vai
      ? `✅ *${s.nome}* ${mudouIdeia ? 'mudou de ideia e ' : ''}confirmou o treino de ${quando}.`
      : `❌ *${s.nome}* ${mudouIdeia ? 'mudou de ideia: ' : ''}*não vai* ao treino de ${quando}.`);
  }
}

// ===================================================================
// Telas do personal (administrador)
// Cada tela é uma mensagem nova com botões (até 3) ou uma lista (até 10 opções).
// ===================================================================

async function mostrar(T, texto, opcoes, botaoLista) {
  if (T.aviso) { texto = `${T.aviso}\n\n${texto}`; T.aviso = ''; }
  return enviarWa(T.env, T.para, mMenu(texto, opcoes, botaoLista));
}

const textoConvite = (cfg, a) => `Quero receber os lembretes de treino (código ${a.convite})`;
const linkConvite = (cfg, a) => `https://wa.me/${cfg.numero}?text=${encodeURIComponent(textoConvite(cfg, a))}`;

async function telaInicio(T) {
  const { env, cfg } = T;
  const itens = (await montarAgenda(env, cfg, 1)).filter((i) => i.status !== 'pulado');
  const n = (s) => itens.filter((i) => i.status === s).length;
  const resumo = itens.length
    ? `Hoje: *${itens.length}* treino${itens.length > 1 ? 's' : ''} · ✅ ${n('confirmado')} · ❌ ${n('cancelado')} · ⏳ ${n('pendente')}`
    : 'Nenhum treino hoje.';
  const pausa = cfg.pausado === '1' ? '\n\n⏸ *Lembretes pausados.* Abra Ajustes para retomar.' : '';
  return mostrar(T, `🏋️ *Lembretes de treino*\n\n${resumo}${pausa}`, [
    ['ag:0', '📅 Hoje', 'Quem confirmou e quem falta'],
    ['ag:1', '📅 Amanhã'],
    ['al:lista', '👥 Alunos', 'Ver, editar, pausar e convidar'],
    ['al:novo', '➕ Novo aluno'],
    ['cf', '⚙️ Ajustes', 'Antecedência, seu nome, pausar todos'],
    ['ajuda', '❓ Como funciona'],
  ], 'Abrir menu');
}

async function telaAgenda(T, desloc) {
  const { env, cfg } = T;
  const data = addDays(localDate(), desloc);
  const itens = (await montarAgenda(env, cfg, desloc + 1)).filter((i) => i.data === data);
  const titulo = `📅 *${cap(relativeDay(data))}* · ${shortLabel(data)}`;
  const corpo = itens.length ? itens.map((i) => `*${i.hora}*  ${i.nome}\n      ${rotulo(i)}`).join('\n') : 'Nenhum treino.';
  const futuros = itens.filter((i) => i.inicio > Date.now());
  const mostrados = futuros.slice(0, 8);
  const dica = mostrados.length ? '\n\nAbra a lista para enviar um lembrete agora ou cancelar um.' : '';
  return mostrar(T, `${titulo}\n\n${corpo}${dica}`, [
    ...mostrados.map((i) => [`it:${i.chave}`, `${i.hora} · ${primeiroNome(i.nome)}`, rotulo(i)]),
    desloc === 0 ? ['ag:1', '📅 Amanhã'] : ['ag:0', '📅 Hoje'],
    ['menu', '🏠 Menu'],
  ], 'Ver treinos');
}

const deslocDe = (chave) => Math.max(0, Math.round((toEpoch(chave.split('|')[0], '12:00') - toEpoch(localDate(), '12:00')) / 86400000));

async function telaItem(T, chave) {
  const { env, cfg } = T;
  const desloc = deslocDe(chave);
  const it = (await montarAgenda(env, cfg, desloc + 1)).find((i) => i.chave === chave);
  if (!it) return telaAgenda(T, 0);
  const futuro = it.inicio > Date.now();
  const enviado = ['pendente', 'confirmado', 'cancelado', 'erro'].includes(it.status);
  const erro = it.sessao?.erro ? `\n${it.sessao.erro}` : '';
  return mostrar(T, `*${it.nome}*\n${shortLabel(it.data)} às ${it.hora}\n\n${rotulo(it)}${erro}`, [
    futuro && it.aluno && it.status !== 'pulado' ? [`it:env:${chave}`, enviado ? '📤 Reenviar agora' : '📤 Enviar agora'] : null,
    futuro && it.status === 'agendado' ? [`it:pul:${chave}`, '🚫 Não enviar'] : null,
    it.status === 'pulado' && futuro ? [`it:vol:${chave}`, '↩️ Voltar a enviar'] : null,
    [`ag:${desloc}`, '⬅️ Voltar'],
  ]);
}

const POR_PAGINA = 7;
async function telaAlunos(T, pagina = 0) {
  const alunos = await lerAlunos(T.env);
  const paginas = Math.max(1, Math.ceil(alunos.length / POR_PAGINA));
  pagina = Math.min(Math.max(0, pagina), paginas - 1);
  const daPagina = alunos.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const status = (a) => (!a.wa ? '⚠️ ainda não ativou' : !a.ativo ? '⏸ pausado' : textoHorarios(a.horarios));
  const texto = alunos.length
    ? `👥 *Alunos* (${alunos.length})${paginas > 1 ? ` · página ${pagina + 1} de ${paginas}` : ''}\n\n` +
      alunos.map((a) => `${!a.wa ? '⚠️' : !a.ativo ? '⏸' : '✅'} ${a.nome}`).join('\n') +
      '\n\n⚠️ = ainda não ativou · ⏸ = pausado'
    : '👥 *Alunos*\n\nNenhum aluno cadastrado ainda.';
  return mostrar(T, texto, [
    ...daPagina.map((a) => [`al:ver:${a.id}`, a.nome, status(a)]),
    ['al:novo', '➕ Novo aluno'],
    paginas > 1 ? [`al:lista:${(pagina + 1) % paginas}`, pagina + 1 < paginas ? '➡️ Mais alunos' : '↩️ Primeira página'] : null,
    ['menu', '🏠 Menu'],
  ], 'Ver alunos');
}

async function telaAluno(T, id) {
  const a = await lerAluno(T.env, id);
  if (!a) return telaAlunos(T);
  const st = !a.wa ? '⚠️ Ainda não ativou os lembretes (precisa tocar no link de convite)' : a.ativo ? '✅ Recebendo lembretes' : '⏸ Lembretes pausados';
  return mostrar(T, `*${a.nome}*\n\n🗓️ ${textoHorarios(a.horarios)}\n${st}`, [
    [`al:hor:${a.id}`, '🕒 Mudar horários'],
    [`al:nom:${a.id}`, '✏️ Mudar nome'],
    [`al:atv:${a.id}`, a.ativo ? '⏸ Pausar lembretes' : '▶️ Retomar lembretes'],
    [`al:conv:${a.id}`, '🔗 Link de convite'],
    [`al:exc:${a.id}`, '🗑 Excluir'],
    ['al:lista', '⬅️ Alunos'],
  ], 'Opções');
}

async function telaConvite(T, id, novo = false) {
  const { env, cfg } = T;
  const a = await lerAluno(env, id);
  if (!a) return telaAlunos(T);
  const convite = `Olá, ${primeiroNome(a.nome)}! 💪 Os lembretes dos nossos treinos agora vão chegar pelo WhatsApp, com botões para confirmar sua presença.\n\nToque no link e envie a mensagem que aparecer:\n${linkConvite(cfg, a)}`;
  const topo = novo ? `✅ *${a.nome}* cadastrado(a)!\n🗓️ ${textoHorarios(a.horarios)}\n\n` : '';
  const prefixo = T.aviso ? `${T.aviso}\n\n` : '';
  T.aviso = '';
  await enviarWa(env, T.para, mLink(
    `${prefixo}${topo}Agora mande este convite para ${primeiroNome(a.nome)}. Quando ele(a) enviar a mensagem, eu te aviso.\n\n${convite.split('\n').map((l) => `> ${l}`).join('\n')}`,
    '📲 Enviar ao aluno', `https://wa.me/?text=${encodeURIComponent(convite)}`));
  return mostrar(T, 'Toque em *Enviar ao aluno* acima e escolha a conversa dele(a).', [[`al:ver:${a.id}`, '⬅️ Ver aluno'], ['menu', '🏠 Menu']]);
}

const ANTECEDENCIAS = [[30, '30 min'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [240, '4 horas'], [360, '6 horas'], [720, '12 horas'], [1440, '1 dia']];
const textoAntecedencia = (m) => (ANTECEDENCIAS.find((x) => x[0] === +m) || [0, `${m} min`])[1];

function telaAjustes(T) {
  const { cfg } = T;
  return mostrar(T,
    `⚙️ *Ajustes*\n\n` +
    `Seu nome nas mensagens: *${cfg.personal}*\n` +
    `Enviar o lembrete: *${textoAntecedencia(cfg.antecedencia)} antes* do treino\n` +
    `Lembretes: *${cfg.pausado === '1' ? '⏸ pausados' : '▶️ ligados'}*`, [
      ['cf:ant', '⏰ Quanto tempo antes'],
      ['cf:nome', '✏️ Seu nome'],
      ['cf:pausa', cfg.pausado === '1' ? '▶️ Retomar lembretes' : '⏸ Pausar todos', cfg.pausado === '1' ? undefined : 'Feriado ou férias'],
      ['menu', '🏠 Menu'],
    ], 'Ajustes');
}

const EXEMPLO_HORARIOS = 'Exemplos:\n• seg qua sex 17h\n• ter qui 6:30, sab 9h\n• segunda a sexta 18h';

const AJUDA =
  `*Como funciona*\n\n` +
  `1. Cadastre o aluno em ➕ *Novo aluno* (nome e horários).\n` +
  `2. Mande o link de convite para ele.\n` +
  `3. Quando ele enviar a mensagem do link, está pronto.\n\n` +
  `Antes de cada treino o aluno recebe o lembrete com os botões *Sim, vou* / *Não vou*, e você recebe o aviso aqui.\n\n` +
  `Atalhos que você pode digitar: *menu*, *hoje*, *amanhã*, *alunos*, *novo*, *ajustes*.`;

function iniciarNovoAluno(T) {
  return Promise.all([
    salvarEstado(T.env, T.para, { passo: 'novo_nome' }),
    mostrar(T, '➕ *Novo aluno*\n\nQual o nome do aluno?', [['menu', 'Cancelar']]),
  ]);
}

// ===================================================================
// Mensagens recebidas
// ===================================================================

const TIPOS = { image: 'uma foto', audio: 'um áudio', video: 'um vídeo', document: 'um arquivo', sticker: 'uma figurinha', location: 'uma localização', contacts: 'um contato' };

async function aoReceberMensagem(env, msg) {
  const de = String(msg.from);
  const texto = (msg.text?.body || '').trim();
  const acao = msg.button?.payload || msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
  let cfg = await lerConfig(env);
  const ehAdmin = !!cfg.admin && cfg.admin === de;
  const T = { env, cfg, para: de, aviso: '' };

  if (ehAdmin) {
    cfg.admin_ultimo = String(Date.now());
    await salvarConfig(env, 'admin_ultimo', cfg.admin_ultimo);
    await entregarAvisos(T);
    if (acao === 'avisos') return telaInicio(T);
  }

  // botões do lembrete (aluno)
  const r = acao.match(/^r:(.+):([01])$/);
  if (r) return respostaAluno(T, r[1], r[2] === '1');

  // mensagem do link de convite (aluno)
  const cv = texto.match(/c[oó]digo\s*:?\s*([A-Za-z0-9]{10})\b/i);
  if (cv) {
    const a = await um(env, 'SELECT * FROM alunos WHERE convite = ?', cv[1]);
    if (!a) return enviarWa(env, de, mTexto('Esse link de convite não vale mais. Peça um novo ao seu personal. 🙂'));
    const jaEra = a.wa === de;
    await exec(env, 'UPDATE alunos SET wa = ? WHERE id = ?', de, a.id);
    const hs = JSON.parse(a.horarios || '[]');
    await enviarWa(env, de, mTexto(
      `Oi, ${primeiroNome(a.nome)}! 👋\n\nPronto! Você vai receber aqui os lembretes dos seus treinos com ${cfg.personal}, com botões para confirmar se vai ou não.\n\n🗓️ Seus horários: ${textoHorarios(hs)}`));
    if (!jaEra && !ehAdmin) await avisarAdmin(env, cfg, `🎉 *${a.nome}* ativou os lembretes no WhatsApp.`);
    if (!ehAdmin) return;
    return telaInicio(T);
  }

  // primeiro acesso: quem mandar "admin <código>" (o link da página de ativação) vira o administrador
  const ad = texto.match(/^admin\s+(\S+)$/i);
  if (!cfg.admin && ad) {
    if (!cfg.codigo_admin || ad[1] !== cfg.codigo_admin) {
      return enviarWa(env, de, mTexto('Código inválido. Abra de novo o endereço do bot (o que termina em .workers.dev) e toque no botão de lá.'));
    }
    await salvarConfig(env, 'admin', de);
    await salvarConfig(env, 'admin_ultimo', Date.now());
    await salvarEstado(env, de, { passo: 'nome_personal', primeiro: true });
    return enviarWa(env, de, mTexto(
      `👋 Bem-vindo! Você agora é o *administrador* deste bot.\n\nPrimeiro, como você quer aparecer nas mensagens para os alunos?\nEx: Prof. Lorran`));
  }

  if (!ehAdmin) {
    // aluno mandando mensagem: encaminha para o personal
    const a = await um(env, 'SELECT * FROM alunos WHERE wa = ?', de);
    if (!a) return enviarWa(env, de, mTexto('Oi! 👋 Este número envia lembretes de treino. Peça o link de convite ao seu personal.'));
    const conteudo = texto || msg.interactive?.button_reply?.title || '';
    if (conteudo) {
      await avisarAdmin(env, cfg, `💬 Mensagem de *${a.nome}*:\n${conteudo}\n\nResponder pelo seu WhatsApp: https://wa.me/${de}`);
      return enviarWa(env, de, mTexto(`Recebi! Passei sua mensagem para ${cfg.personal}. 👍`));
    }
    if (TIPOS[msg.type]) {
      await avisarAdmin(env, cfg, `💬 *${a.nome}* mandou ${TIPOS[msg.type]} para o bot. Só consigo repassar texto.\nFale com ele(a): https://wa.me/${de}`);
      return enviarWa(env, de, mTexto(`Recebi! Mas só consigo repassar mensagens de texto para ${cfg.personal}. Se for importante, escreva aqui. 🙂`));
    }
    return;
  }

  // ---------- administrador ----------
  if (acao) return aoTocarBotao(T, acao);

  const cmd = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\//, '').split(/\s+/)[0];
  if (['menu', 'inicio', 'cancelar', 'oi', 'ola'].includes(cmd) && texto.split(/\s+/).length <= 2) {
    await salvarEstado(env, de, null);
    return telaInicio(T);
  }
  const atalhos = { hoje: () => telaAgenda(T, 0), amanha: () => telaAgenda(T, 1), alunos: () => telaAlunos(T), ajustes: () => telaAjustes(T) };
  if (atalhos[cmd] && texto.split(/\s+/).length === 1) { await salvarEstado(env, de, null); return atalhos[cmd](); }
  if (cmd === 'novo' && texto.split(/\s+/).length === 1) return iniciarNovoAluno(T);
  if (cmd === 'ajuda' && texto.split(/\s+/).length === 1) return enviarWa(env, de, mTexto(AJUDA));

  const estado = await lerEstado(env, de);
  if (!estado || !texto) return telaInicio(T);
  return continuarConversa(T, estado, texto);
}

async function continuarConversa(T, estado, texto) {
  const { env } = T;
  const p = estado.passo;
  if (p === 'novo_nome' || p === 'nome_aluno') {
    const nome = umaLinha(texto).slice(0, 60);
    if (nome.length < 2) return enviarWa(env, T.para, mTexto('Digite o nome do aluno:'));
    if (p === 'nome_aluno') {
      await exec(env, 'UPDATE alunos SET nome = ? WHERE id = ?', nome, estado.id);
      await salvarEstado(env, T.para, null);
      return telaAluno(T, estado.id);
    }
    await salvarEstado(env, T.para, { passo: 'novo_horarios', nome });
    return mostrar(T, `Quais os dias e horários de treino de *${nome}*?\n\n${EXEMPLO_HORARIOS}`, [['menu', 'Cancelar']]);
  }
  if (p === 'novo_horarios' || p === 'horarios') {
    const hs = entenderHorarios(texto);
    if (!hs.length) return mostrar(T, `Não entendi os horários. 🤔\n\n${EXEMPLO_HORARIOS}`, [['menu', 'Cancelar']]);
    if (p === 'horarios') {
      await exec(env, 'UPDATE alunos SET horarios = ? WHERE id = ?', JSON.stringify(hs), estado.id);
      await salvarEstado(env, T.para, null);
      return telaAluno(T, estado.id);
    }
    const id = novoId(8);
    await exec(env, 'INSERT INTO alunos (id, nome, convite, ativo, horarios, criado) VALUES (?, ?, ?, 1, ?, ?)',
      id, estado.nome, novoId(10), JSON.stringify(hs), Date.now());
    await salvarEstado(env, T.para, null);
    return telaConvite(T, id, true);
  }
  if (p === 'nome_personal') {
    const nome = umaLinha(texto).slice(0, 40);
    await salvarConfig(env, 'personal', nome);
    await salvarEstado(env, T.para, null);
    T.cfg = await lerConfig(env);
    if (estado.primeiro) {
      await enviarWa(env, T.para, mTexto(`Perfeito, *${nome}*! 👍\n\n${AJUDA}`));
      return telaInicio(T);
    }
    return telaAjustes(T);
  }
  await salvarEstado(env, T.para, null);
  return telaInicio(T);
}

// ===================================================================
// Botões e listas do personal
// ===================================================================

async function aoTocarBotao(T, data) {
  const { env } = T;
  const [area, acao, ...resto] = data.split(':');
  const arg = resto.join(':');

  if (data === 'menu') { await salvarEstado(env, T.para, null); return telaInicio(T); }
  if (data === 'ajuda') return enviarWa(env, T.para, mTexto(AJUDA));
  if (area === 'ag') return telaAgenda(T, +acao || 0);
  if (area === 'it' && !['env', 'pul', 'vol'].includes(acao)) return telaItem(T, data.slice(3));
  if (area === 'it') {
    const chave = arg;
    const it = (await montarAgenda(env, T.cfg, deslocDe(chave) + 1)).find((i) => i.chave === chave);
    if (it && acao === 'env' && it.aluno) {
      const s = await enviarLembrete(env, T.cfg, it, true);
      T.aviso = s?.status === 'pendente' ? '✅ Lembrete enviado.' : s?.status === 'sem_whatsapp' ? '⚠️ O aluno ainda não ativou os lembretes.' : '⚠️ Não consegui enviar.';
    } else if (it && acao === 'pul' && it.aluno) {
      await exec(env, 'INSERT OR REPLACE INTO sessoes (chave, aluno_id, nome, wa, data, hora, inicio, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        chave, it.aluno.id, it.aluno.nome, it.aluno.wa || null, it.data, it.hora, it.inicio, 'pulado');
      T.aviso = '🚫 Esse lembrete não será enviado.';
    } else if (acao === 'vol') {
      await exec(env, "DELETE FROM sessoes WHERE chave = ? AND status = 'pulado'", chave);
      T.aviso = '↩️ O lembrete voltou a ser enviado.';
    }
    return telaItem(T, chave);
  }
  if (area === 'al') {
    if (acao === 'lista') return telaAlunos(T, +arg || 0);
    if (acao === 'novo') return iniciarNovoAluno(T);
    if (acao === 'ver') return telaAluno(T, arg);
    if (acao === 'conv') return telaConvite(T, arg);
    if (acao === 'hor') {
      const a = await lerAluno(env, arg);
      await salvarEstado(env, T.para, { passo: 'horarios', id: arg });
      return mostrar(T, `🕒 Novos horários de *${a?.nome}*\nAtual: ${textoHorarios(a?.horarios || [])}\n\nDigite *todos* os horários:\n\n${EXEMPLO_HORARIOS}`, [[`al:ver:${arg}`, 'Cancelar']]);
    }
    if (acao === 'nom') {
      await salvarEstado(env, T.para, { passo: 'nome_aluno', id: arg });
      return mostrar(T, 'Digite o novo nome:', [[`al:ver:${arg}`, 'Cancelar']]);
    }
    if (acao === 'atv') {
      await exec(env, 'UPDATE alunos SET ativo = 1 - ativo WHERE id = ?', arg);
      return telaAluno(T, arg);
    }
    if (acao === 'exc') {
      const a = await lerAluno(env, arg);
      return mostrar(T, `Excluir *${a?.nome}*? Ele(a) para de receber lembretes.`, [[`al:exc2:${arg}`, '🗑 Sim, excluir'], [`al:ver:${arg}`, 'Cancelar']]);
    }
    if (acao === 'exc2') {
      await exec(env, 'DELETE FROM alunos WHERE id = ?', arg);
      T.aviso = '🗑 Aluno excluído.';
      return telaAlunos(T);
    }
  }
  if (area === 'cf') {
    if (!acao) return telaAjustes(T);
    if (acao === 'ant') {
      return mostrar(T, '⏰ Mandar o lembrete quanto tempo antes do treino?', [
        ...ANTECEDENCIAS.map(([v, t]) => [`cf:antv:${v}`, (+T.cfg.antecedencia === v ? '• ' : '') + t]),
        ['cf', '⬅️ Voltar'],
      ], 'Escolher');
    }
    if (acao === 'antv') {
      await salvarConfig(env, 'antecedencia', +arg || 120);
      T.cfg = await lerConfig(env);
      T.aviso = `✅ Lembrete ${textoAntecedencia(T.cfg.antecedencia)} antes.`;
      return telaAjustes(T);
    }
    if (acao === 'nome') {
      await salvarEstado(env, T.para, { passo: 'nome_personal' });
      return mostrar(T, `Como você quer aparecer nas mensagens? (atual: *${T.cfg.personal}*)`, [['cf', 'Cancelar']]);
    }
    if (acao === 'pausa') {
      await salvarConfig(env, 'pausado', T.cfg.pausado === '1' ? '0' : '1');
      T.cfg = await lerConfig(env);
      T.aviso = T.cfg.pausado === '1' ? '⏸ Lembretes pausados.' : '▶️ Lembretes ligados.';
      return telaAjustes(T);
    }
  }
  return telaInicio(T);
}

// ===================================================================
// Ativação: registra o número, liga o webhook e cria os modelos de mensagem
// ===================================================================

const tokenVerificacao = async (env) => (await sha256hex('verify:' + env.WA_APP_SECRET)).slice(0, 32);

async function ativar(env, origem) {
  const res = { problemas: [], modelos: [] };
  let cfg = await lerConfig(env);
  if (!cfg.codigo_admin) { cfg.codigo_admin = novoId(8); await salvarConfig(env, 'codigo_admin', cfg.codigo_admin); }

  // 1. número do bot (se esta etapa falhar, as outras também falhariam)
  const info = await graph(env, `${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,platform_type`, { method: 'GET' });
  res.numero = digitos(info.display_phone_number);
  res.nome = info.verified_name;
  if (res.numero && res.numero !== cfg.numero) await salvarConfig(env, 'numero', res.numero);

  // 2. registrar o número na API (só na primeira vez)
  if (info.platform_type && info.platform_type !== 'CLOUD_API') {
    const pin = env.WA_PIN || cfg.pin || String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    if (!env.WA_PIN && !cfg.pin) await salvarConfig(env, 'pin', pin);
    try {
      await graph(env, `${env.WA_PHONE_ID}/register`, { corpo: { messaging_product: 'whatsapp', pin } });
      if (!env.WA_PIN) res.pin = pin;
    } catch (e) {
      res.problemas.push(`Registrar o número: ${explicarErro(e)}. Se você já tinha criado um PIN de confirmação em duas etapas para esse número, adicione o segredo WA_PIN com ele.`);
    }
  }

  // 3. webhook (a Meta passa a mandar as mensagens recebidas para este endereço)
  try {
    await graph(env, `${env.WA_APP_ID}/subscriptions`, {
      corpo: { object: 'whatsapp_business_account', callback_url: `${origem}/whatsapp`, verify_token: await tokenVerificacao(env), fields: 'messages' },
      token: `${env.WA_APP_ID}|${env.WA_APP_SECRET}`,
    });
  } catch (e) {
    res.problemas.push(`Ligar o webhook: ${explicarErro(e)}. Confira o WA_APP_ID e o WA_APP_SECRET.`);
  }
  try {
    await graph(env, `${env.WA_WABA_ID}/subscribed_apps`, { corpo: {} });
  } catch (e) {
    res.problemas.push(`Ligar o app à conta do WhatsApp: ${explicarErro(e)}. Confira o WA_WABA_ID.`);
  }

  // 4. modelos de mensagem
  try {
    const lista = (await graph(env, `${env.WA_WABA_ID}/message_templates?fields=name,status,language,rejected_reason&limit=200`, { method: 'GET' })).data || [];
    for (const m of MODELOS) {
      let t = lista.find((x) => x.name === m.name && x.language === m.language);
      if (!t) {
        try {
          const j = await graph(env, `${env.WA_WABA_ID}/message_templates`, { corpo: m });
          t = { name: m.name, status: j.status || 'PENDING' };
        } catch (e) {
          t = { name: m.name, status: 'ERRO', rejected_reason: explicarErro(e) };
        }
      }
      res.modelos.push(t);
    }
  } catch (e) {
    res.problemas.push(`Criar as mensagens modelo: ${explicarErro(e)}. O token precisa da permissão whatsapp_business_management.`);
  }
  return res;
}

const STATUS_MODELO = { APPROVED: '✅ aprovada', PENDING: '⏳ em análise pela Meta', REJECTED: '❌ rejeitada', PAUSED: '⏸ pausada', DISABLED: '❌ desativada', ERRO: '❌ erro ao criar' };
const NOME_MODELO = { [MODELO_LEMBRETE]: 'Lembrete do aluno', [MODELO_AVISOS]: 'Avisos para você' };

function paginaHtml(titulo, corpo) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(titulo)}</title>
<style>:root{--bg:#f4f1ec;--card:#fff;--ink:#1c1b19;--muted:#6f6a62;--line:#e4dfd6;--accent:#1DAA61}
@media (prefers-color-scheme:dark){:root{--bg:#131311;--card:#1e1d1a;--ink:#f1ede6;--muted:#a19b90;--line:#33312c}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 18px}.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px 22px}
h1{font-size:25px;line-height:1.2;margin:0 0 10px}h2{font-size:17px;margin:22px 0 6px}p,li{margin:8px 0}ul{padding-left:20px}.muted{color:var(--muted)}
a.btn{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:650;border-radius:14px;padding:16px;margin-top:20px}
code{background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}.aviso{border-left:4px solid #d9822b;padding-left:12px}</style></head>
<body><main><div class="card">${corpo}</div></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function htmlModelos(res) {
  if (!res.modelos.length) return '';
  const itens = res.modelos.map((t) => `<li>${escHtml(NOME_MODELO[t.name] || t.name)}: <b>${STATUS_MODELO[t.status] || escHtml(t.status)}</b>${t.rejected_reason && t.rejected_reason !== 'NONE' ? ` <span class="muted">(${escHtml(t.rejected_reason)})</span>` : ''}</li>`).join('');
  const pendente = res.modelos.some((t) => t.status === 'PENDING');
  return `<h2>Mensagens modelo</h2><ul>${itens}</ul>${pendente ? '<p class="muted">A Meta costuma aprovar em minutos ou poucas horas. Os lembretes só saem depois que a do aluno for aprovada.</p>' : ''}`;
}

const PRIVACIDADE = `<h1>Política de privacidade</h1>
<p>Este serviço envia lembretes de treino pelo WhatsApp para alunos de um personal trainer.</p>
<h2>O que guardamos</h2><ul><li>Nome do aluno e número do WhatsApp dele.</li><li>Dias e horários de treino.</li><li>As respostas aos lembretes (vou / não vou) dos últimos 60 dias.</li></ul>
<h2>Para que usamos</h2><p>Só para enviar os lembretes e avisar o personal sobre as confirmações. Nada é vendido nem compartilhado com terceiros.</p>
<h2>Como sair</h2><p>Peça ao seu personal para excluir seu cadastro, ou bloqueie este número no WhatsApp. Os dados ficam guardados na Cloudflare e as mensagens passam pela Meta (WhatsApp).</p>`;

// ===================================================================
// Entrada do Worker
// ===================================================================

async function tratarWebhook(env, corpo) {
  const u = JSON.parse(corpo);
  for (const entrada of u.entry || []) {
    for (const mudanca of entrada.changes || []) {
      const v = mudanca.value || {};
      if (v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(env.WA_PHONE_ID)) continue;
      for (const msg of v.messages || []) {
        // a Meta pode mandar a mesma mensagem mais de uma vez
        const novo = await exec(env, 'INSERT OR IGNORE INTO vistos (id, em) VALUES (?, ?)', msg.id, Date.now());
        if (novo.meta && novo.meta.changes !== 1) continue;
        try { await aoReceberMensagem(env, msg); } catch (e) { console.log('erro ao tratar mensagem', explicarErro(e), e?.stack || ''); }
      }
      for (const st of v.statuses || []) {
        try { await aoReceberStatus(env, st); } catch (e) { console.log('erro ao tratar status', e?.stack || e); }
      }
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/privacidade') return paginaHtml('Política de privacidade', PRIVACIDADE);

    const faltando = SEGREDOS.filter((k) => !env[k]);
    if (faltando.length) {
      return paginaHtml('Faltam dados', `<h1>Faltam dados da Meta</h1><p class="muted">Adicione nas configurações do Worker (Settings › Variables and Secrets):</p><ul>${faltando.map((k) => `<li><code>${k}</code></li>`).join('')}</ul><p class="muted">O passo a passo está no README do repositório.</p>`);
    }

    if (url.pathname === '/whatsapp' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === (await tokenVerificacao(env));
      return ok ? new Response(url.searchParams.get('hub.challenge') || '') : new Response('proibido', { status: 403 });
    }

    if (url.pathname === '/whatsapp' && req.method === 'POST') {
      const corpo = await req.text();
      const assinatura = req.headers.get('X-Hub-Signature-256') || '';
      if (!iguais(assinatura, 'sha256=' + (await hmacHex(env.WA_APP_SECRET, corpo)))) return new Response('proibido', { status: 403 });
      try {
        await prepararBanco(env);
        await tratarWebhook(env, corpo);
      } catch (e) {
        console.log('erro no webhook', e?.stack || e);
      }
      return new Response('ok');
    }

    if (url.pathname === '/' && req.method === 'GET') {
      try {
        await prepararBanco(env);
        const res = await ativar(env, url.origin);
        const cfg = await lerConfig(env);
        const numero = res.numero || cfg.numero;
        const problemas = res.problemas.length ? `<h2>⚠️ Falta resolver</h2><ul class="aviso">${res.problemas.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>` : '';
        const pin = res.pin ? `<p class="aviso">Número registrado. PIN de confirmação em duas etapas: <code>${res.pin}</code>. Guarde, a Meta pode pedir.</p>` : '';
        const cab = `<p class="muted">Número do bot: <b>+${escHtml(numero)}</b>${res.nome ? ` (${escHtml(res.nome)})` : ''}</p>`;
        if (!cfg.admin) {
          const link = `https://wa.me/${numero}?text=${encodeURIComponent(`admin ${cfg.codigo_admin}`)}`;
          return paginaHtml('Bot ativado', `<h1>✅ Bot ativado!</h1>${cab}${pin}${problemas}${htmlModelos(res)}<h2>Último passo</h2><p>Toque no botão abaixo pelo celular <b>com o seu WhatsApp pessoal</b> e envie a mensagem que aparecer. Quem enviar primeiro vira o administrador, então faça agora.</p><a class="btn" href="${escHtml(link)}">Abrir no WhatsApp</a>`);
        }
        return paginaHtml('Bot funcionando', `<h1>${problemas ? '⚠️ Bot com pendências' : '✅ Bot funcionando'}</h1>${cab}${pin}${problemas}${htmlModelos(res)}<p class="muted">Os lembretes são enviados automaticamente. Para administrar, mande <b>menu</b> para o bot no WhatsApp.</p><a class="btn" href="https://wa.me/${escHtml(numero)}?text=menu">Abrir no WhatsApp</a>`);
      } catch (e) {
        const msg = explicarErro(e);
        const dica = e?.code === 190 ? 'O token (<code>WA_TOKEN</code>) expirou ou está errado. Gere um token permanente de usuário do sistema e atualize o segredo.'
          : e?.code === 100 ? `Confira o <code>WA_PHONE_ID</code>. (${escHtml(msg)})` : escHtml(msg);
        return paginaHtml('Erro', `<h1>⚠️ Não consegui ativar</h1><p class="muted">${dica}</p>`);
      }
    }

    return new Response('Não encontrado', { status: 404 });
  },

  async scheduled(evento, env, ctx) {
    if (SEGREDOS.some((k) => !env[k])) return;
    ctx.waitUntil(cron(env, evento.scheduledTime || Date.now()).catch((e) => console.log('erro no cron', e?.stack || e)));
  },
};

// exportado para os testes
export { cron as _cron, hmacHex as _hmacHex };
