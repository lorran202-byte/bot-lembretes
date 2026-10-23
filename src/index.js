// Bot de lembretes de treino para o Telegram, rodando no Cloudflare Workers (plano grátis).
// - O personal administra tudo pelo próprio Telegram (menus com botões).
// - O aluno recebe o lembrete com os botões ✅ Vou / ❌ Não vou.
// - Um "cron" roda a cada minuto e envia os lembretes na hora certa.

import { localDate, localTime, toEpoch, addDays, weekday, relativeDay, shortLabel, DIAS_CURTOS } from './tempo.js';

// ===================================================================
// Utilidades
// ===================================================================

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const Dia = (d) => DIAS_CURTOS[d][0].toUpperCase() + DIAS_CURTOS[d].slice(1);
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function novoId(n = 8) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => abc[x % abc.length]).join('');
}

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ===================================================================
// Telegram
// ===================================================================

class TgErro extends Error {
  constructor(r) { super(r.description || 'Erro no Telegram'); this.code = r.error_code; }
}

async function tg(env, metodo, dados = {}) {
  const base = env.TG_API || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${env.BOT_TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'resposta inválida' }));
  if (!j.ok) throw new TgErro(j);
  return j.result;
}

const kb = (linhas) => ({ inline_keyboard: linhas.filter((l) => l && l.length) });
const b = (text, data) => ({ text, callback_data: data });
const bu = (text, url) => ({ text, url });

function enviar(env, chat, texto, teclado) {
  return tg(env, 'sendMessage', {
    chat_id: chat, text: texto, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(teclado ? { reply_markup: teclado } : {}),
  });
}

/** Edita a mensagem do menu (quando veio de um botão) ou manda uma nova. */
async function mostrar(env, chat, msgId, texto, teclado) {
  if (msgId) {
    try {
      return await tg(env, 'editMessageText', {
        chat_id: chat, message_id: msgId, text: texto, parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }, reply_markup: teclado || kb([]),
      });
    } catch (e) {
      if (String(e.message).includes('not modified')) return;
    }
  }
  return enviar(env, chat, texto, teclado);
}

// ===================================================================
// Banco de dados (Cloudflare D1)
// ===================================================================

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS alunos (
     id TEXT PRIMARY KEY, nome TEXT NOT NULL, chat_id INTEGER, convite TEXT UNIQUE,
     ativo INTEGER NOT NULL DEFAULT 1, horarios TEXT NOT NULL DEFAULT '[]', criado INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessoes (
     chave TEXT PRIMARY KEY, aluno_id TEXT, nome TEXT, chat_id INTEGER, data TEXT, hora TEXT,
     inicio INTEGER, status TEXT, msg_id INTEGER, enviado INTEGER, respondido INTEGER, erro TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessoes_data ON sessoes(data)`,
  `CREATE TABLE IF NOT EXISTS estados (chat_id INTEGER PRIMARY KEY, estado TEXT, em INTEGER)`,
];
let schemaOk = false;
async function prepararBanco(env) {
  if (schemaOk) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaOk = true;
}

const sql = (env, s, ...p) => env.DB.prepare(s).bind(...p);
const todos = async (env, s, ...p) => (await sql(env, s, ...p).all()).results || [];
const um = (env, s, ...p) => sql(env, s, ...p).first();
const exec = (env, s, ...p) => sql(env, s, ...p).run();

const CONFIG_PADRAO = { personal: 'seu personal', antecedencia: '120', pausado: '0', admin: '', bot: '' };
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

async function lerEstado(env, chat) {
  const r = await um(env, 'SELECT estado, em FROM estados WHERE chat_id = ?', chat);
  if (!r || Date.now() - r.em > 30 * 60000) return null; // conversa esquecida depois de 30 min
  return JSON.parse(r.estado);
}
const salvarEstado = (env, chat, e) =>
  e ? exec(env, 'INSERT INTO estados (chat_id, estado, em) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET estado = excluded.estado, em = excluded.em', chat, JSON.stringify(e), Date.now())
    : exec(env, 'DELETE FROM estados WHERE chat_id = ?', chat);

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
  sem_telegram: '⚠️ não ativou o Telegram',
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

function rotulo(item) {
  return ROTULOS[item.status].replace('{envio}', localTime(item.envio));
}

// ===================================================================
// Envio dos lembretes
// ===================================================================

function textoLembrete(cfg, s) {
  return `Olá, ${esc(primeiroNome(s.nome))}! 💪\n` +
    `Lembrete do seu treino <b>${esc(relativeDay(s.data))} às ${esc(s.hora)}</b>.\n\n` +
    `Você vai?`;
}

function tecladoLembrete(s, status) {
  if (status === 'confirmado') return kb([[b('Mudei de ideia: não vou', `r:${s.chave}:0`)]]);
  if (status === 'cancelado') return kb([[b('Mudei de ideia: vou', `r:${s.chave}:1`)]]);
  return kb([[b('✅ Vou', `r:${s.chave}:1`), b('❌ Não vou', `r:${s.chave}:0`)]]);
}

async function avisarAdmin(env, cfg, texto, teclado) {
  if (!cfg.admin) return;
  try { await enviar(env, +cfg.admin, texto, teclado); } catch (e) { console.log('aviso ao personal falhou', e.message); }
}

/** Cria a sessão (uma vez só) e manda o lembrete. Retorna a sessão. */
async function enviarLembrete(env, cfg, item, forcar = false) {
  const a = item.aluno;
  if (forcar) await exec(env, 'DELETE FROM sessoes WHERE chave = ?', item.chave);
  const statusInicial = a.chat_id ? 'enviando' : 'sem_telegram';
  const ins = await exec(env,
    'INSERT OR IGNORE INTO sessoes (chave, aluno_id, nome, chat_id, data, hora, inicio, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    item.chave, a.id, a.nome, a.chat_id || null, item.data, item.hora, item.inicio, statusInicial);
  if (!ins.meta || ins.meta.changes !== 1) return null; // outro processo já cuidou

  const s = { chave: item.chave, nome: a.nome, data: item.data, hora: item.hora, chat_id: a.chat_id };
  if (!a.chat_id) {
    await avisarAdmin(env, cfg,
      `⚠️ <b>${esc(a.nome)}</b> tem treino ${esc(relativeDay(item.data))} às ${esc(item.hora)}, mas ainda não ativou os lembretes no Telegram.`,
      kb([[b('🔗 Ver link de convite', `al:conv:${a.id}`)]]));
    return { ...s, status: 'sem_telegram' };
  }
  try {
    const m = await enviar(env, a.chat_id, textoLembrete(cfg, s), tecladoLembrete(s, 'pendente'));
    await exec(env, 'UPDATE sessoes SET status = ?, msg_id = ?, enviado = ?, erro = NULL WHERE chave = ?', 'pendente', m.message_id, Date.now(), item.chave);
    return { ...s, status: 'pendente' };
  } catch (e) {
    const bloqueou = e.code === 403;
    const erro = bloqueou ? 'O aluno bloqueou ou apagou o bot' : e.message;
    await exec(env, 'UPDATE sessoes SET status = ?, erro = ? WHERE chave = ?', 'erro', erro, item.chave);
    await avisarAdmin(env, cfg, `⚠️ Não consegui mandar o lembrete para <b>${esc(a.nome)}</b> (${esc(item.hora)}).\n${esc(erro)}.` +
      (bloqueou ? '\nMande o link de convite de novo para ele(a).' : ''),
      bloqueou ? kb([[b('🔗 Ver link de convite', `al:conv:${a.id}`)]]) : undefined);
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
  }
}

// ===================================================================
// Respostas do aluno
// ===================================================================

async function respostaAluno(env, cq, chave, vai) {
  const cfg = await lerConfig(env);
  const s = await um(env, 'SELECT * FROM sessoes WHERE chave = ?', chave);
  const chat = cq.message?.chat?.id;
  if (!s || (s.chat_id && s.chat_id !== chat)) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Lembrete não encontrado.' });
  }
  if (Date.now() > s.inicio + 2 * 3600000) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: cq.message.message_id, reply_markup: kb([]) }).catch(() => {});
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Esse horário já passou.', show_alert: true });
  }
  if (s.status === 'pulado') {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Esse lembrete foi cancelado.', show_alert: true });
  }
  const novo = vai ? 'confirmado' : 'cancelado';
  const mudou = s.status !== novo;
  if (mudou) await exec(env, 'UPDATE sessoes SET status = ?, respondido = ? WHERE chave = ?', novo, Date.now(), chave);

  const nome = esc(primeiroNome(s.nome));
  const rodape = vai ? `\n\n✅ <b>Presença confirmada!</b> Até lá, ${nome} 💪` : `\n\n👋 <b>Tudo certo, ${nome}.</b> Avisei que você não vai.`;
  await tg(env, 'editMessageText', {
    chat_id: chat, message_id: cq.message.message_id, parse_mode: 'HTML',
    text: textoLembrete(cfg, s) + rodape, reply_markup: tecladoLembrete(s, novo),
  }).catch(() => {});
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: vai ? 'Presença confirmada ✅' : 'Ok, avisado ❌' });

  if (mudou) {
    const quando = `${relativeDay(s.data)} às ${s.hora}`;
    const mudouIdeia = s.status === 'confirmado' || s.status === 'cancelado';
    await avisarAdmin(env, cfg, vai
      ? `✅ <b>${esc(s.nome)}</b> ${mudouIdeia ? 'mudou de ideia e ' : ''}confirmou o treino de ${esc(quando)}.`
      : `❌ <b>${esc(s.nome)}</b> ${mudouIdeia ? 'mudou de ideia: ' : ''}<b>não vai</b> ao treino de ${esc(quando)}.`);
  }
}

// ===================================================================
// Telas do personal (administrador)
// ===================================================================

function linkConvite(cfg, a) {
  return `https://t.me/${cfg.bot}?start=${a.convite}`;
}

async function telaInicio(env, cfg, chat, msgId) {
  const itens = (await montarAgenda(env, cfg, 1)).filter((i) => i.status !== 'pulado');
  const n = (s) => itens.filter((i) => i.status === s).length;
  const resumo = itens.length
    ? `Hoje: <b>${itens.length}</b> treino${itens.length > 1 ? 's' : ''} · ✅ ${n('confirmado')} · ❌ ${n('cancelado')} · ⏳ ${n('pendente')}`
    : 'Nenhum treino hoje.';
  const pausa = cfg.pausado === '1' ? '\n\n⏸ <b>Lembretes pausados.</b> Toque em Ajustes para retomar.' : '';
  return mostrar(env, chat, msgId, `🏋️ <b>Lembretes de treino</b>\n\n${resumo}${pausa}`, kb([
    [b('📅 Hoje', 'ag:0'), b('📅 Amanhã', 'ag:1')],
    [b('👥 Alunos', 'al:lista'), b('➕ Novo aluno', 'al:novo')],
    [b('⚙️ Ajustes', 'cf')],
  ]));
}

async function telaAgenda(env, cfg, chat, msgId, desloc) {
  const hoje = localDate();
  const data = addDays(hoje, desloc);
  const itens = (await montarAgenda(env, cfg, desloc + 1)).filter((i) => i.data === data);
  const titulo = `📅 <b>${cap(relativeDay(data))}</b> · ${shortLabel(data)}`;
  const linhas = itens.map((i) => `<b>${i.hora}</b>  ${esc(i.nome)}\n      ${rotulo(i)}`);
  const corpo = itens.length ? linhas.join('\n') : 'Nenhum treino.';
  const botoes = itens.filter((i) => i.inicio > Date.now()).map((i) => [b(`${i.hora} · ${primeiroNome(i.nome)}`, `it:${i.chave}`)]);
  return mostrar(env, chat, msgId, `${titulo}\n\n${corpo}${botoes.length ? '\n\n<i>Toque num treino para enviar agora ou cancelar o lembrete.</i>' : ''}`, kb([
    ...botoes,
    [b(desloc === 0 ? '📅 Amanhã' : '📅 Hoje', `ag:${desloc === 0 ? 1 : 0}`), b('🔄 Atualizar', `ag:${desloc}`)],
    [b('⬅️ Menu', 'menu')],
  ]));
}

async function telaItem(env, cfg, chat, msgId, chave) {
  const data = chave.split('|')[0];
  const desloc = Math.max(0, Math.round((toEpoch(data, '12:00') - toEpoch(localDate(), '12:00')) / 86400000));
  const it = (await montarAgenda(env, cfg, desloc + 1)).find((i) => i.chave === chave);
  if (!it) return telaAgenda(env, cfg, chat, msgId, 0);
  const futuro = it.inicio > Date.now();
  const enviado = ['pendente', 'confirmado', 'cancelado', 'erro'].includes(it.status);
  const erro = it.sessao?.erro ? `\n${esc(it.sessao.erro)}` : '';
  return mostrar(env, chat, msgId,
    `<b>${esc(it.nome)}</b>\n${shortLabel(it.data)} às ${it.hora}\n\n${rotulo(it)}${erro}`, kb([
      futuro && it.aluno && it.status !== 'pulado' ? [b(enviado ? '📤 Reenviar lembrete agora' : '📤 Enviar lembrete agora', `it:env:${chave}`)] : null,
      futuro && it.status === 'agendado' ? [b('🚫 Não enviar este lembrete', `it:pul:${chave}`)] : null,
      it.status === 'pulado' && futuro ? [b('↩️ Voltar a enviar', `it:vol:${chave}`)] : null,
      [b('⬅️ Voltar', `ag:${desloc}`)],
    ]));
}

async function telaAlunos(env, cfg, chat, msgId) {
  const alunos = await lerAlunos(env);
  const linhas = alunos.map((a) => {
    const st = !a.chat_id ? ' ⚠️' : !a.ativo ? ' ⏸' : '';
    return [b(`${a.nome}${st}`, `al:ver:${a.id}`)];
  });
  const texto = alunos.length
    ? `👥 <b>Alunos</b> (${alunos.length})\n\n⚠️ = ainda não ativou no Telegram\n⏸ = lembretes pausados`
    : '👥 <b>Alunos</b>\n\nNenhum aluno cadastrado ainda.';
  return mostrar(env, chat, msgId, texto, kb([...linhas, [b('➕ Novo aluno', 'al:novo')], [b('⬅️ Menu', 'menu')]]));
}

async function telaAluno(env, cfg, chat, msgId, id) {
  const a = await lerAluno(env, id);
  if (!a) return telaAlunos(env, cfg, chat, msgId);
  const st = !a.chat_id ? '⚠️ Ainda não ativou os lembretes (precisa tocar no link de convite)' : a.ativo ? '✅ Recebendo lembretes' : '⏸ Lembretes pausados';
  return mostrar(env, chat, msgId,
    `<b>${esc(a.nome)}</b>\n\n🗓️ ${textoHorarios(a.horarios)}\n${st}`, kb([
      [b('🕒 Mudar horários', `al:hor:${a.id}`), b('✏️ Mudar nome', `al:nom:${a.id}`)],
      [b(a.ativo ? '⏸ Pausar lembretes' : '▶️ Retomar lembretes', `al:atv:${a.id}`), b('🔗 Link de convite', `al:conv:${a.id}`)],
      [b('🗑 Excluir', `al:exc:${a.id}`)],
      [b('⬅️ Alunos', 'al:lista')],
    ]));
}

async function telaConvite(env, cfg, chat, msgId, id, novo = false) {
  const a = await lerAluno(env, id);
  if (!a) return telaAlunos(env, cfg, chat, msgId);
  const link = linkConvite(cfg, a);
  const intro = `Olá, ${primeiroNome(a.nome)}! 💪 Os lembretes dos nossos treinos agora vão chegar pelo Telegram, com um botão para confirmar sua presença.`;
  const convite = `${intro}\n\nToque no link e depois em INICIAR:\n${link}`;
  const topo = novo ? `✅ <b>${esc(a.nome)}</b> cadastrado(a)!\n🗓️ ${textoHorarios(a.horarios)}\n\n` : '';
  return mostrar(env, chat, msgId,
    `${topo}Agora mande este convite para ${esc(primeiroNome(a.nome))}. Quando ele(a) tocar em <b>Iniciar</b>, eu te aviso.\n\n<blockquote>${esc(convite)}</blockquote>`, kb([
      [bu('📲 Enviar pelo WhatsApp', `https://wa.me/?text=${encodeURIComponent(convite)}`)],
      [bu('✈️ Enviar pelo Telegram', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(intro + '\n\nToque no link e depois em INICIAR.')}`)],
      [b('⬅️ Ver aluno', `al:ver:${a.id}`), b('🏠 Menu', 'menu')],
    ]));
}

const ANTECEDENCIAS = [[30, '30 min'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [240, '4 horas'], [360, '6 horas'], [720, '12 horas'], [1440, '1 dia']];
const textoAntecedencia = (m) => (ANTECEDENCIAS.find((x) => x[0] === +m) || [0, `${m} min`])[1];

async function telaAjustes(env, cfg, chat, msgId) {
  return mostrar(env, chat, msgId,
    `⚙️ <b>Ajustes</b>\n\n` +
    `Seu nome nas mensagens: <b>${esc(cfg.personal)}</b>\n` +
    `Enviar o lembrete: <b>${textoAntecedencia(cfg.antecedencia)} antes</b> do treino\n` +
    `Lembretes: <b>${cfg.pausado === '1' ? '⏸ pausados' : '▶️ ligados'}</b>`, kb([
      [b('⏰ Quanto tempo antes', 'cf:ant')],
      [b('✏️ Seu nome', 'cf:nome')],
      [b(cfg.pausado === '1' ? '▶️ Retomar lembretes' : '⏸ Pausar todos (feriado/férias)', 'cf:pausa')],
      [b('⬅️ Menu', 'menu')],
    ]));
}

const EXEMPLO_HORARIOS = 'Exemplos:\n• <code>seg qua sex 17h</code>\n• <code>ter qui 6:30, sab 9h</code>\n• <code>segunda a sexta 18h</code>';

// ===================================================================
// Mensagens recebidas
// ===================================================================

async function aoReceberMensagem(env, msg) {
  if (msg.chat?.type !== 'private') return;
  const chat = msg.chat.id;
  const texto = (msg.text || '').trim();
  let cfg = await lerConfig(env);
  const ehAdmin = cfg.admin && +cfg.admin === chat;

  // /start com código de convite (aluno)
  const st = texto.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
  if (st && st[1] && st[1] !== 'admin') {
    const a = await um(env, 'SELECT * FROM alunos WHERE convite = ?', st[1]);
    if (!a) return enviar(env, chat, 'Esse link de convite não vale mais. Peça um novo ao seu personal. 🙂');
    const jaEra = a.chat_id === chat;
    await exec(env, 'UPDATE alunos SET chat_id = ? WHERE id = ?', chat, a.id);
    const hs = JSON.parse(a.horarios || '[]');
    await enviar(env, chat,
      `Oi, ${esc(primeiroNome(a.nome))}! 👋\n\nPronto! Você vai receber aqui os lembretes dos seus treinos com ${esc(cfg.personal)}, com botões para confirmar se vai ou não.\n\n🗓️ Seus horários: ${textoHorarios(hs)}`);
    if (!jaEra && !ehAdmin) await avisarAdmin(env, cfg, `🎉 <b>${esc(a.nome)}</b> ativou os lembretes no Telegram.`);
    if (!ehAdmin) return;
  }

  // primeiro acesso: quem der /start primeiro vira o administrador
  if (!cfg.admin && st) {
    await salvarConfig(env, 'admin', chat);
    cfg = await lerConfig(env);
    await configurarComandos(env, chat);
    await salvarEstado(env, chat, { passo: 'nome_personal', primeiro: true });
    return enviar(env, chat,
      `👋 Bem-vindo! Você agora é o <b>administrador</b> deste bot.\n\nPrimeiro, como você quer aparecer nas mensagens para os alunos?\nEx: <code>Prof. Lorran</code>`);
  }

  if (!ehAdmin) {
    // aluno mandando mensagem: encaminha para o personal
    const a = await um(env, 'SELECT * FROM alunos WHERE chat_id = ?', chat);
    if (!a) return enviar(env, chat, 'Oi! 👋 Este bot envia lembretes de treino. Peça o link de convite ao seu personal.');
    if (st) return enviar(env, chat, `Você já está cadastrado(a), ${esc(primeiroNome(a.nome))}! 👍 Os lembretes chegam aqui antes de cada treino.`);
    if (texto || msg.caption) {
      await avisarAdmin(env, cfg, `💬 Mensagem de <b>${esc(a.nome)}</b>:\n${esc(texto || msg.caption)}`);
      return enviar(env, chat, `Recebi! Passei sua mensagem para ${esc(cfg.personal)}. 👍`);
    }
    return;
  }

  // ---------- administrador ----------
  const cmd = texto.split(/[\s@]/)[0].toLowerCase();
  if (['/start', '/menu', 'menu', '/cancelar', 'cancelar'].includes(cmd)) {
    await salvarEstado(env, chat, null);
    return telaInicio(env, cfg, chat);
  }
  if (cmd === '/hoje') { await salvarEstado(env, chat, null); return telaAgenda(env, cfg, chat, null, 0); }
  if (cmd === '/amanha') { await salvarEstado(env, chat, null); return telaAgenda(env, cfg, chat, null, 1); }
  if (cmd === '/alunos') { await salvarEstado(env, chat, null); return telaAlunos(env, cfg, chat); }
  if (cmd === '/novo') return iniciarNovoAluno(env, chat);
  if (cmd === '/ajustes') { await salvarEstado(env, chat, null); return telaAjustes(env, cfg, chat); }
  if (cmd === '/ajuda') return enviar(env, chat, AJUDA);

  const estado = await lerEstado(env, chat);
  if (!estado || !texto) return telaInicio(env, cfg, chat);
  return continuarConversa(env, cfg, chat, estado, texto);
}

const AJUDA =
  `<b>Como funciona</b>\n\n` +
  `1. Cadastre o aluno em ➕ <b>Novo aluno</b> (nome e horários).\n` +
  `2. Mande o link de convite para ele (pelo WhatsApp mesmo).\n` +
  `3. Quando ele tocar em <b>Iniciar</b>, está pronto.\n\n` +
  `Antes de cada treino o aluno recebe o lembrete com os botões ✅ Vou / ❌ Não vou, e você recebe o aviso aqui.\n\n` +
  `Comandos: /menu /hoje /amanha /alunos /novo /ajustes`;

function iniciarNovoAluno(env, chat, msgId) {
  return Promise.all([
    salvarEstado(env, chat, { passo: 'novo_nome' }),
    mostrar(env, chat, msgId, '➕ <b>Novo aluno</b>\n\nQual o nome do aluno?', kb([[b('Cancelar', 'menu')]])),
  ]);
}

async function continuarConversa(env, cfg, chat, estado, texto) {
  const p = estado.passo;
  if (p === 'novo_nome' || p === 'nome_aluno') {
    const nome = texto.replace(/\s+/g, ' ').slice(0, 60);
    if (nome.length < 2) return enviar(env, chat, 'Digite o nome do aluno:');
    if (p === 'nome_aluno') {
      await exec(env, 'UPDATE alunos SET nome = ? WHERE id = ?', nome, estado.id);
      await salvarEstado(env, chat, null);
      return telaAluno(env, cfg, chat, null, estado.id);
    }
    await salvarEstado(env, chat, { passo: 'novo_horarios', nome });
    return enviar(env, chat, `Quais os dias e horários de treino de <b>${esc(nome)}</b>?\n\n${EXEMPLO_HORARIOS}`, kb([[b('Cancelar', 'menu')]]));
  }
  if (p === 'novo_horarios' || p === 'horarios') {
    const hs = entenderHorarios(texto);
    if (!hs.length) return enviar(env, chat, `Não entendi os horários. 🤔\n\n${EXEMPLO_HORARIOS}`, kb([[b('Cancelar', 'menu')]]));
    if (p === 'horarios') {
      await exec(env, 'UPDATE alunos SET horarios = ? WHERE id = ?', JSON.stringify(hs), estado.id);
      await salvarEstado(env, chat, null);
      return telaAluno(env, cfg, chat, null, estado.id);
    }
    const id = novoId(8);
    await exec(env, 'INSERT INTO alunos (id, nome, convite, ativo, horarios, criado) VALUES (?, ?, ?, 1, ?, ?)',
      id, estado.nome, novoId(10), JSON.stringify(hs), Date.now());
    await salvarEstado(env, chat, null);
    return telaConvite(env, cfg, chat, null, id, true);
  }
  if (p === 'nome_personal') {
    const nome = texto.replace(/\s+/g, ' ').slice(0, 40);
    await salvarConfig(env, 'personal', nome);
    await salvarEstado(env, chat, null);
    cfg = await lerConfig(env);
    if (estado.primeiro) {
      await enviar(env, chat, `Perfeito, <b>${esc(nome)}</b>! 👍\n\n${AJUDA}`);
    }
    return estado.primeiro ? telaInicio(env, cfg, chat) : telaAjustes(env, cfg, chat);
  }
  await salvarEstado(env, chat, null);
  return telaInicio(env, cfg, chat);
}

// ===================================================================
// Botões
// ===================================================================

async function aoTocarBotao(env, cq) {
  const data = cq.data || '';
  const chat = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;

  const r = data.match(/^r:(.+):([01])$/);
  if (r) return respostaAluno(env, cq, r[1], r[2] === '1');

  let cfg = await lerConfig(env);
  if (!cfg.admin || +cfg.admin !== chat) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  let aviso;
  const [area, acao, ...resto] = data.split(':');
  const arg = resto.join(':');

  if (data === 'menu') { await salvarEstado(env, chat, null); await telaInicio(env, cfg, chat, msgId); }
  else if (area === 'ag') await telaAgenda(env, cfg, chat, msgId, +acao || 0);
  else if (area === 'it' && !['env', 'pul', 'vol'].includes(acao)) await telaItem(env, cfg, chat, msgId, data.slice(3));
  else if (area === 'it') {
    const chave = arg;
    const desloc = Math.max(0, Math.round((toEpoch(chave.split('|')[0], '12:00') - toEpoch(localDate(), '12:00')) / 86400000));
    const it = (await montarAgenda(env, cfg, desloc + 1)).find((i) => i.chave === chave);
    if (it && acao === 'env' && it.aluno) {
      const s = await enviarLembrete(env, cfg, it, true);
      aviso = s?.status === 'pendente' ? 'Lembrete enviado ✅' : s?.status === 'sem_telegram' ? 'O aluno ainda não ativou o Telegram' : 'Não consegui enviar';
    } else if (it && acao === 'pul' && it.aluno) {
      await exec(env, 'INSERT OR REPLACE INTO sessoes (chave, aluno_id, nome, chat_id, data, hora, inicio, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        chave, it.aluno.id, it.aluno.nome, it.aluno.chat_id || null, it.data, it.hora, it.inicio, 'pulado');
      aviso = 'Esse lembrete não será enviado';
    } else if (acao === 'vol') {
      await exec(env, "DELETE FROM sessoes WHERE chave = ? AND status = 'pulado'", chave);
    }
    await telaItem(env, cfg, chat, msgId, chave);
  }
  else if (area === 'al') {
    if (acao === 'lista') await telaAlunos(env, cfg, chat, msgId);
    else if (acao === 'novo') await iniciarNovoAluno(env, chat, msgId);
    else if (acao === 'ver') await telaAluno(env, cfg, chat, msgId, arg);
    else if (acao === 'conv') await telaConvite(env, cfg, chat, msgId, arg);
    else if (acao === 'hor') {
      const a = await lerAluno(env, arg);
      await salvarEstado(env, chat, { passo: 'horarios', id: arg });
      await mostrar(env, chat, msgId, `🕒 Novos horários de <b>${esc(a?.nome)}</b>\nAtual: ${textoHorarios(a?.horarios || [])}\n\nDigite <b>todos</b> os horários:\n\n${EXEMPLO_HORARIOS}`, kb([[b('Cancelar', `al:ver:${arg}`)]]));
    } else if (acao === 'nom') {
      await salvarEstado(env, chat, { passo: 'nome_aluno', id: arg });
      await mostrar(env, chat, msgId, 'Digite o novo nome:', kb([[b('Cancelar', `al:ver:${arg}`)]]));
    } else if (acao === 'atv') {
      await exec(env, 'UPDATE alunos SET ativo = 1 - ativo WHERE id = ?', arg);
      await telaAluno(env, cfg, chat, msgId, arg);
    } else if (acao === 'exc') {
      const a = await lerAluno(env, arg);
      await mostrar(env, chat, msgId, `Excluir <b>${esc(a?.nome)}</b>? Ele(a) para de receber lembretes.`, kb([
        [b('🗑 Sim, excluir', `al:exc2:${arg}`)], [b('Cancelar', `al:ver:${arg}`)],
      ]));
    } else if (acao === 'exc2') {
      await exec(env, 'DELETE FROM alunos WHERE id = ?', arg);
      aviso = 'Aluno excluído';
      await telaAlunos(env, cfg, chat, msgId);
    }
  }
  else if (area === 'cf') {
    if (!acao) await telaAjustes(env, cfg, chat, msgId);
    else if (acao === 'ant') {
      const linhas = [];
      for (let i = 0; i < ANTECEDENCIAS.length; i += 2) linhas.push(ANTECEDENCIAS.slice(i, i + 2).map(([v, t]) => b((+cfg.antecedencia === v ? '• ' : '') + t, `cf:antv:${v}`)));
      await mostrar(env, chat, msgId, '⏰ Mandar o lembrete quanto tempo antes do treino?', kb([...linhas, [b('⬅️ Voltar', 'cf')]]));
    } else if (acao === 'antv') {
      await salvarConfig(env, 'antecedencia', +arg || 120);
      cfg = await lerConfig(env);
      aviso = `Lembrete ${textoAntecedencia(cfg.antecedencia)} antes ✅`;
      await telaAjustes(env, cfg, chat, msgId);
    } else if (acao === 'nome') {
      await salvarEstado(env, chat, { passo: 'nome_personal' });
      await mostrar(env, chat, msgId, `Como você quer aparecer nas mensagens? (atual: <b>${esc(cfg.personal)}</b>)`, kb([[b('Cancelar', 'cf')]]));
    } else if (acao === 'pausa') {
      await salvarConfig(env, 'pausado', cfg.pausado === '1' ? '0' : '1');
      cfg = await lerConfig(env);
      aviso = cfg.pausado === '1' ? 'Lembretes pausados ⏸' : 'Lembretes ligados ▶️';
      await telaAjustes(env, cfg, chat, msgId);
    }
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(aviso ? { text: aviso } : {}) }).catch(() => {});
}

// ===================================================================
// Configuração do bot
// ===================================================================

async function configurarComandos(env, adminChat) {
  await tg(env, 'setMyCommands', {
    scope: { type: 'chat', chat_id: adminChat },
    commands: [
      { command: 'menu', description: 'Menu principal' },
      { command: 'hoje', description: 'Treinos de hoje' },
      { command: 'amanha', description: 'Treinos de amanhã' },
      { command: 'alunos', description: 'Ver e editar alunos' },
      { command: 'novo', description: 'Cadastrar aluno' },
      { command: 'ajustes', description: 'Ajustes' },
      { command: 'ajuda', description: 'Como funciona' },
    ],
  }).catch(() => {});
}

async function ativar(env, origem) {
  const segredo = (await sha256hex('webhook:' + env.BOT_TOKEN)).slice(0, 48);
  const eu = await tg(env, 'getMe');
  await tg(env, 'setWebhook', {
    url: `${origem}/telegram`,
    secret_token: segredo,
    allowed_updates: ['message', 'callback_query'],
  });
  await salvarConfig(env, 'bot', eu.username);
  return eu;
}

function paginaHtml(titulo, corpo) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>:root{--bg:#f4f1ec;--card:#fff;--ink:#1c1b19;--muted:#6f6a62;--line:#e4dfd6;--accent:#229ED9}
@media (prefers-color-scheme:dark){:root{--bg:#131311;--card:#1e1d1a;--ink:#f1ede6;--muted:#a19b90;--line:#33312c}}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 18px}.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px 22px}
h1{font-size:25px;line-height:1.2;margin:0 0 10px}p{margin:10px 0}.muted{color:var(--muted)}
a.btn{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:650;border-radius:14px;padding:16px;margin-top:20px}
code{background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}</style></head>
<body><main><div class="card">${corpo}</div></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ===================================================================
// Entrada do Worker
// ===================================================================

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (!env.BOT_TOKEN) {
      return paginaHtml('Falta o token', `<h1>Falta o token do bot</h1><p class="muted">Adicione o segredo <code>BOT_TOKEN</code> nas configurações do Worker (Settings › Variables and Secrets) com o token que o @BotFather te deu.</p>`);
    }

    if (url.pathname === '/telegram' && req.method === 'POST') {
      const segredo = (await sha256hex('webhook:' + env.BOT_TOKEN)).slice(0, 48);
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== segredo) return new Response('proibido', { status: 403 });
      try {
        await prepararBanco(env);
        const u = await req.json();
        if (u.message) await aoReceberMensagem(env, u.message);
        else if (u.callback_query) await aoTocarBotao(env, u.callback_query);
      } catch (e) {
        console.log('erro ao tratar update', e?.stack || e);
      }
      return new Response('ok');
    }

    if (url.pathname === '/' && req.method === 'GET') {
      try {
        await prepararBanco(env);
        const eu = await ativar(env, url.origin);
        const cfg = await lerConfig(env);
        if (!cfg.admin) {
          return paginaHtml('Bot ativado', `<h1>✅ Bot ativado!</h1><p>Agora abra o bot no Telegram e toque em <b>Iniciar</b>. Quem fizer isso primeiro vira o administrador, então faça agora.</p><a class="btn" href="https://t.me/${esc(eu.username)}?start=admin">Abrir @${esc(eu.username)} no Telegram</a>`);
        }
        return paginaHtml('Bot funcionando', `<h1>✅ Bot funcionando</h1><p class="muted">Tudo certo. Os lembretes são enviados automaticamente. Para administrar, use o Telegram.</p><a class="btn" href="https://t.me/${esc(eu.username)}">Abrir @${esc(eu.username)}</a>`);
      } catch (e) {
        const msg = String(e?.message || e);
        const dica = /unauthorized|not found/i.test(msg) ? 'O token do bot parece errado. Copie de novo do @BotFather e atualize o segredo <code>BOT_TOKEN</code>.' : esc(msg);
        return paginaHtml('Erro', `<h1>⚠️ Não consegui ativar</h1><p class="muted">${dica}</p>`);
      }
    }

    return new Response('Não encontrado', { status: 404 });
  },

  async scheduled(evento, env, ctx) {
    if (!env.BOT_TOKEN) return;
    ctx.waitUntil(cron(env, evento.scheduledTime || Date.now()).catch((e) => console.log('erro no cron', e?.stack || e)));
  },
};

// exportado para os testes
export { cron as _cron };
