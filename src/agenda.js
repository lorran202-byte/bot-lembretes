import { db, save, newId, normalizePhone } from './store.js';
import { localDate, addDays, weekday, toEpoch, relativeDay, shortLabel } from './time.js';
import * as WA from './whatsapp.js';

const PUBLIC_URL = () => (process.env.URL_PUBLICA || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

export const STATUS = {
  agendado: 'Agendado',
  enviando: 'Enviando…',
  pendente: 'Aguardando resposta',
  confirmado: 'Confirmou',
  cancelado: 'Não vai',
  pulado: 'Não enviar',
  erro: 'Erro no envio',
  perdido: 'Não enviado',
};

const key = (date, alunoId, hora) => `${date}|${alunoId}|${hora}`;

/** Lista os treinos de hoje até daqui a N dias, com o status de cada lembrete. */
export function agenda(dias = 2, now = Date.now()) {
  const { alunos, sessoes, config } = db();
  const hoje = localDate(now);
  const lead = (+config.antecedenciaMin || 0) * 60000;
  const itens = [];
  for (let i = 0; i < dias; i++) {
    const date = addDays(hoje, i);
    const wd = weekday(date);
    for (const a of alunos) {
      for (const h of a.horarios || []) {
        if (+h.dia !== wd) continue;
        const k = key(date, a.id, h.hora);
        const inicio = toEpoch(date, h.hora);
        const s = sessoes[k];
        let status = s?.status || 'agendado';
        if (!s && !a.ativo) continue;
        if (!s && inicio <= now) status = 'perdido';
        itens.push({
          chave: k, data: date, hora: h.hora, inicio,
          envioEm: inicio - lead,
          alunoId: a.id, nome: a.nome, telefone: a.telefone,
          status, rotulo: STATUS[status] || status,
          respondidoEm: s?.respondidoEm || null,
          erro: s?.erro || null,
          dia: relativeDay(date, now), diaCurto: shortLabel(date),
        });
      }
    }
  }
  // sessões criadas manualmente/antigas de hoje que não batem mais com os horários (aluno editado)
  for (const s of Object.values(sessoes)) {
    if (s.data >= hoje && s.data < addDays(hoje, dias) && !itens.find((i) => i.chave === s.chave)) {
      itens.push({
        chave: s.chave, data: s.data, hora: s.hora, inicio: s.inicio, envioEm: s.inicio - lead,
        alunoId: s.alunoId, nome: s.nome, telefone: s.telefone,
        status: s.status, rotulo: STATUS[s.status] || s.status, respondidoEm: s.respondidoEm || null,
        erro: s.erro || null, dia: relativeDay(s.data, now), diaCurto: shortLabel(s.data),
      });
    }
  }
  itens.sort((a, b) => a.inicio - b.inicio || a.nome.localeCompare(b.nome));
  return itens;
}

export function montarMensagem(sessao, now = Date.now()) {
  const { config } = db();
  const primeiro = (sessao.nome || '').trim().split(/\s+/)[0] || '';
  const link = `${PUBLIC_URL()}/c/${sessao.token}`;
  return (config.mensagem || '')
    .replaceAll('{nome}', primeiro)
    .replaceAll('{nomecompleto}', sessao.nome || '')
    .replaceAll('{dia}', relativeDay(sessao.data, now))
    .replaceAll('{hora}', sessao.hora)
    .replaceAll('{link}', link)
    .replaceAll('{personal}', config.personal || '');
}

let enviando = false;

async function enviar(item, aluno) {
  const d = db();
  const tel = normalizePhone(aluno.telefone);
  const sessao = {
    chave: item.chave, token: newId(9), alunoId: aluno.id, nome: aluno.nome, telefone: tel,
    data: item.data, hora: item.hora, inicio: item.inicio,
    status: 'enviando', criadoEm: Date.now(), historico: [],
  };
  d.sessoes[item.chave] = sessao;
  save();
  try {
    const jid = await WA.resolverJid(tel);
    aluno.jid = jid;
    await WA.enviarTexto(jid, montarMensagem(sessao));
    sessao.status = 'pendente';
    sessao.enviadoEm = Date.now();
    sessao.erro = null;
    console.log(`[lembrete] enviado para ${aluno.nome} (${item.data} ${item.hora})`);
  } catch (e) {
    sessao.status = 'erro';
    sessao.erro = String(e?.message || e);
    console.error(`[lembrete] falhou para ${aluno.nome}:`, sessao.erro);
  }
  save();
  return sessao;
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda a cada 30s: envia os lembretes que chegaram na hora. */
export async function tick(now = Date.now()) {
  if (enviando) return;
  const d = db();
  if (d.config.pausado || !WA.conectado()) return;
  enviando = true;
  try {
    const fila = agenda(2, now).filter(
      (i) => i.status === 'agendado' && now >= i.envioEm && now < i.inicio - 5 * 60000,
    );
    for (const item of fila) {
      const aluno = d.alunos.find((a) => a.id === item.alunoId);
      if (!aluno || !aluno.ativo) continue;
      await enviar(item, aluno);
      // intervalo aleatório entre mensagens para parecer uso normal
      if (fila.length > 1) await pausa(4000 + Math.random() * 6000);
    }
  } finally {
    enviando = false;
  }
}

/** Envia (ou reenvia) agora um lembrete da agenda. */
export async function enviarAgora(chave) {
  const d = db();
  const item = agenda(8).find((i) => i.chave === chave);
  if (!item) throw new Error('Treino não encontrado');
  const aluno = d.alunos.find((a) => a.id === item.alunoId);
  if (!aluno) throw new Error('Aluno não encontrado');
  if (!WA.conectado()) throw new Error('Conecte o WhatsApp primeiro');
  delete d.sessoes[chave];
  return enviar(item, aluno);
}

export function pular(chave, pularSim) {
  const d = db();
  if (pularSim) {
    const item = agenda(8).find((i) => i.chave === chave);
    if (!item) throw new Error('Treino não encontrado');
    d.sessoes[chave] = {
      chave, token: newId(9), alunoId: item.alunoId, nome: item.nome, telefone: item.telefone,
      data: item.data, hora: item.hora, inicio: item.inicio, status: 'pulado', criadoEm: Date.now(), historico: [],
    };
  } else if (d.sessoes[chave]?.status === 'pulado') {
    delete d.sessoes[chave];
  }
  save();
}

/** Registra a resposta do aluno (pelo link ou por mensagem) e avisa o personal. */
export async function responder(sessao, vai, via) {
  const novo = vai ? 'confirmado' : 'cancelado';
  const mudou = sessao.status !== novo;
  sessao.status = novo;
  sessao.respondidoEm = Date.now();
  sessao.historico = [...(sessao.historico || []), { status: novo, via, em: Date.now() }];
  save();
  const { config } = db();
  if (mudou && config.avisarPersonal && config.telefonePersonal && WA.conectado()) {
    const quando = `${relativeDay(sessao.data)} às ${sessao.hora}`;
    const txt = vai
      ? `✅ *${sessao.nome}* confirmou o treino de ${quando}.`
      : `❌ *${sessao.nome}* avisou que *não vai* ao treino de ${quando}.`;
    try {
      const jid = await WA.resolverJid(normalizePhone(config.telefonePersonal));
      await WA.enviarTexto(jid, txt);
    } catch (e) {
      console.error('[aviso] não consegui avisar o personal:', e?.message || e);
    }
  }
  return mudou;
}

export function sessaoPorToken(token) {
  return Object.values(db().sessoes).find((s) => s.token === token) || null;
}

// só aceita respostas curtas e claras, pra não confundir com conversa normal
const SIM = /^\s*(1|sim|vou|eu vou|confirmo|confirmado|👍|✅)[\s!.]*$/iu;
const NAO = /^\s*(2|n[aã]o|n[aã]o vou|❌)[\s!.]*$/iu;

/** Trata respostas "1" / "2" por mensagem. */
export async function mensagemRecebida({ jids, texto }) {
  const vai = SIM.test(texto) ? true : NAO.test(texto) ? false : null;
  if (vai === null) return;
  const d = db();
  const digitos = jids.map((j) => j.split('@')[0].split(':')[0]);
  const ultimos = (s) => String(s || '').replace(/\D/g, '').slice(-8);
  const aluno = d.alunos.find((a) =>
    (a.jid && jids.includes(a.jid)) ||
    digitos.some((x) => x.length >= 10 && ultimos(x) === ultimos(a.telefone)),
  );
  if (!aluno) return;
  const now = Date.now();
  // lembrete mais recente desse aluno, ainda válido (até 2h depois do horário)
  const s = Object.values(d.sessoes)
    .filter((x) => x.alunoId === aluno.id && ['pendente', 'confirmado', 'cancelado'].includes(x.status) && now < x.inicio + 2 * 3600000)
    .sort((a, b) => (b.enviadoEm || 0) - (a.enviadoEm || 0))[0];
  if (!s) return;
  const mudou = await responder(s, vai, 'mensagem');
  if (mudou) {
    const resp = vai ? 'Presença confirmada! ✅ Até lá 💪' : 'Tudo certo, avisei que você não vai. Até a próxima! 👋';
    try { await WA.enviarTexto(aluno.jid || jids[0], resp); } catch {}
  }
}
