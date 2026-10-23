// Teste local: simula o banco D1 (SQLite do Node) e a API do Telegram.
// Rode com: npm run teste
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import worker, { entenderHorarios, _cron } from '../src/index.js';
import { localDate, localTime, weekday, toEpoch, addDays } from '../src/tempo.js';

// ---------- D1 falso ----------
const sqlite = new DatabaseSync(':memory:');
const conv = (v) => (typeof v === 'boolean' ? +v : v);
function stmt(sql, params = []) {
  return {
    bind: (...p) => stmt(sql, p.map(conv)),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => { const r = sqlite.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
  };
}
const DB = { prepare: (s) => stmt(s), batch: async (l) => Promise.all(l.map((s) => s.run())) };

// ---------- Telegram falso ----------
const chamadas = [];
let msgSeq = 100;
const bloqueados = new Set();
globalThis.fetch = async (url, opts) => {
  const metodo = url.split('/').pop();
  const corpo = JSON.parse(opts.body || '{}');
  chamadas.push({ metodo, ...corpo });
  if (metodo === 'sendMessage' && bloqueados.has(corpo.chat_id)) {
    return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  }
  const result = metodo === 'getMe' ? { id: 1, username: 'LembreteTesteBot' }
    : metodo === 'sendMessage' ? { message_id: ++msgSeq, chat: { id: corpo.chat_id } } : true;
  return new Response(JSON.stringify({ ok: true, result }));
};

const env = { DB, BOT_TOKEN: '123:ABC', TG_API: 'http://tg.falso' };
const ctx = { waitUntil: (p) => p };
const ADMIN = 1111, MARIA = 2222, JOAO = 3333, ESTRANHO = 9999;

let segredo;
async function update(u) {
  const r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': segredo }, body: JSON.stringify(u),
  }), env);
  assert.equal(r.status, 200);
}
let uid = 1;
const texto = (chat, text) => update({ update_id: uid++, message: { message_id: uid, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const botao = (chat, data, message_id = 1) => update({ update_id: uid++, callback_query: { id: 'cq' + uid, from: { id: chat }, data, message: { message_id, chat: { id: chat, type: 'private' } } } });
const ultimas = (n = 1) => chamadas.slice(-n);
const ultimaPara = (chat) => [...chamadas].reverse().find((c) => (c.metodo === 'sendMessage' || c.metodo === 'editMessageText') && c.chat_id === chat);
const botoes = (c) => (c.reply_markup?.inline_keyboard || []).flat();
const limpar = () => { chamadas.length = 0; };

// ---------- 1. horários ----------
const H = (t) => entenderHorarios(t).map((x) => `${x.dia}@${x.hora}`).join(' ');
assert.equal(H('seg qua sex 17h'), '1@17:00 3@17:00 5@17:00');
assert.equal(H('ter qui 6:30, sab 9h'), '2@06:30 4@06:30 6@09:00');
assert.equal(H('Segunda a sexta às 18h'), '1@18:00 2@18:00 3@18:00 4@18:00 5@18:00');
assert.equal(H('terça-feira 7h e quinta-feira 19h30'), '2@07:00 4@19:30');
assert.equal(H('seg qua 7h e 18h'), '1@07:00 1@18:00 3@07:00 3@18:00');
assert.equal(H('Sábado 9 h'), '6@09:00');
assert.equal(H('dom 1730'), '0@17:30');
assert.equal(H('bom dia'), '');
assert.equal(H('sex a seg 10h'), '1@10:00 5@10:00 6@10:00 0@10:00'.split(' ').sort((a, b) => ((+a[0] + 6) % 7) - ((+b[0] + 6) % 7)).join(' '));
console.log('✓ horários');

// ---------- 2. ativação pela página ----------
let r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), env);
let html = await r.text();
assert.match(html, /Bot ativado/);
assert.match(html, /t\.me\/LembreteTesteBot\?start=admin/);
const sw = chamadas.find((c) => c.metodo === 'setWebhook');
assert.equal(sw.url, 'https://bot.exemplo.workers.dev/telegram');
segredo = sw.secret_token;
const proib = await worker.fetch(new Request('https://bot.exemplo.workers.dev/telegram', { method: 'POST', body: '{}' }), env);
assert.equal(proib.status, 403);
console.log('✓ ativação + webhook protegido');

// ---------- 3. o personal vira admin ----------
await texto(ADMIN, '/start admin');
assert.match(ultimaPara(ADMIN).text, /administrador/);
await texto(ADMIN, 'Prof. Lorran');
assert.match(ultimaPara(ADMIN).text, /Lembretes de treino/);
await texto(ESTRANHO, '/start admin');
assert.match(ultimaPara(ESTRANHO).text, /Peça o link de convite/);
console.log('✓ administrador definido; estranho não vira admin');

// ---------- 4. cadastrar alunos ----------
const agora = Date.now();
const emUmaHora = agora + 60 * 60000;           // treino daqui a 1h -> lembrete (2h antes) já deve sair
const em5h = agora + 5 * 3600000;               // treino daqui a 5h -> ainda não
const diaTxt = (ms) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][weekday(localDate(ms))];

await botao(ADMIN, 'al:novo');
await texto(ADMIN, 'Maria Souza');
await texto(ADMIN, 'xyz');
assert.match(ultimaPara(ADMIN).text, /Não entendi/);
await texto(ADMIN, `${diaTxt(emUmaHora)} ${localTime(emUmaHora)}`);
let tela = ultimaPara(ADMIN);
assert.match(tela.text, /Maria Souza<\/b> cadastrado/);
const linkMaria = tela.text.match(/start=([\w]+)/)[1];
assert.ok(botoes(tela).some((x) => x.url?.startsWith('https://wa.me/?text=')));

await texto(ADMIN, '/novo');
await texto(ADMIN, 'João Pedro');
await texto(ADMIN, `${diaTxt(em5h)} ${localTime(em5h)}`);
const linkJoao = ultimaPara(ADMIN).text.match(/start=([\w]+)/)[1];
console.log('✓ alunos cadastrados com link de convite');

// ---------- 5. aluno ativa pelo link ----------
limpar();
await texto(MARIA, `/start ${linkMaria}`);
assert.match(ultimaPara(MARIA).text, /Pronto!/);
assert.match(ultimaPara(ADMIN).text, /Maria Souza<\/b> ativou/);
await texto(MARIA, '/start xxxxxxxx');
assert.match(ultimaPara(MARIA).text, /não vale mais/);
console.log('✓ aluno ativou, personal avisado');

// ---------- 6. cron manda o lembrete ----------
limpar();
await _cron(env, agora);
let lemb = chamadas.filter((c) => c.metodo === 'sendMessage' && c.chat_id === MARIA);
assert.equal(lemb.length, 1);
assert.match(lemb[0].text, /Lembrete do seu treino <b>hoje às/);
assert.deepEqual(botoes(lemb[0]).map((x) => x.text), ['✅ Vou', '❌ Não vou']);
// João ainda não ativou, mas o treino dele é em 5h: nada ainda
assert.equal(chamadas.filter((c) => c.chat_id === ADMIN).length, 0);
await _cron(env, agora + 60000);
assert.equal(chamadas.filter((c) => c.metodo === 'sendMessage' && c.chat_id === MARIA).length, 1, 'não pode repetir');
console.log('✓ lembrete enviado uma vez só');

// ---------- 7. aluno toca nos botões ----------
const vou = botoes(lemb[0])[0].callback_data;
const naoVou = botoes(lemb[0])[1].callback_data;
limpar();
await botao(MARIA, vou, 101);
assert.match(ultimaPara(MARIA).text, /Presença confirmada/);
assert.match(ultimaPara(ADMIN).text, /✅ <b>Maria Souza<\/b> confirmou/);
limpar();
await botao(MARIA, vou, 101);
assert.equal(chamadas.filter((c) => c.chat_id === ADMIN).length, 0, 'tocar de novo não avisa de novo');
await botao(MARIA, naoVou, 101);
assert.match(ultimaPara(ADMIN).text, /mudou de ideia: <b>não vai<\/b>/);
await botao(JOAO, vou, 101);
assert.match(chamadas.at(-1).text, /não encontrado/);
console.log('✓ botões Vou / Não vou + aviso ao personal');

// ---------- 8. agenda do personal ----------
limpar();
await texto(ADMIN, '/hoje');
tela = ultimaPara(ADMIN);
assert.match(tela.text, /Maria Souza\n\s+❌ não vai/);
console.log('✓ agenda:\n' + tela.text.replace(/<[^>]+>/g, '').split('\n').map((l) => '    ' + l).join('\n'));

// ---------- 9. João sem Telegram: personal é avisado na hora do lembrete ----------
limpar();
await _cron(env, em5h - 2 * 3600000 + 1000);
assert.match(ultimaPara(ADMIN).text, /João Pedro<\/b> tem treino .* ainda não ativou/);
// depois ele ativa e o personal reenvia pela agenda
await texto(JOAO, `/start ${linkJoao}`);
const chaveJoao = sqlite.prepare("SELECT chave FROM sessoes WHERE nome = 'João Pedro'").get().chave;
limpar();
await botao(ADMIN, `it:env:${chaveJoao}`, 50);
assert.equal(chamadas.filter((c) => c.metodo === 'sendMessage' && c.chat_id === JOAO).length, 1);
assert.equal(chamadas.find((c) => c.metodo === 'answerCallbackQuery').text, 'Lembrete enviado ✅');
console.log('✓ aviso de aluno sem Telegram + reenviar pela agenda');

// ---------- 10. aluno bloqueou o bot ----------
bloqueados.add(JOAO);
limpar();
await botao(ADMIN, `it:env:${chaveJoao}`, 50);
assert.match(chamadas.find((c) => c.chat_id === ADMIN && c.metodo === 'sendMessage').text, /bloqueou/);
bloqueados.delete(JOAO);
console.log('✓ aviso quando o aluno bloqueia o bot');

// ---------- 11. mensagem do aluno é encaminhada ----------
limpar();
await texto(MARIA, 'Prof, posso ir 18h em vez de 17h?');
assert.match(ultimaPara(ADMIN).text, /Mensagem de <b>Maria Souza<\/b>/);
assert.match(ultimaPara(MARIA).text, /Passei sua mensagem para Prof\. Lorran/);
console.log('✓ mensagem do aluno encaminhada');

// ---------- 12. ajustes, pausa e pular ----------
await botao(ADMIN, 'cf:antv:60');
assert.equal(sqlite.prepare("SELECT v FROM config WHERE k='antecedencia'").get().v, '60');
await botao(ADMIN, 'cf:pausa');
const amanha = addDays(localDate(), 1);
sqlite.prepare("UPDATE alunos SET horarios = ? WHERE nome = 'Maria Souza'").run(JSON.stringify([{ dia: weekday(amanha), hora: '10:00' }]));
limpar();
await _cron(env, toEpoch(amanha, '09:30'));
assert.equal(chamadas.length, 0, 'pausado não envia');
await botao(ADMIN, 'cf:pausa');
const idMaria = sqlite.prepare("SELECT id FROM alunos WHERE nome = 'Maria Souza'").get().id;
await botao(ADMIN, `it:pul:${amanha}|${idMaria}|10:00`);
limpar();
await _cron(env, toEpoch(amanha, '09:30'));
assert.equal(chamadas.filter((c) => c.chat_id === MARIA).length, 0, 'pulado não envia');
await botao(ADMIN, `it:vol:${amanha}|${idMaria}|10:00`);
limpar();
await _cron(env, toEpoch(amanha, '09:00') - 1000);
assert.equal(chamadas.length, 0, 'com 1h de antecedência, 9:00 ainda é cedo');
await _cron(env, toEpoch(amanha, '09:00'));
assert.equal(chamadas.filter((c) => c.chat_id === MARIA).length, 1);
console.log('✓ antecedência, pausa e "não enviar este lembrete"');

// ---------- 13. editar horários, pausar e excluir aluno ----------
await botao(ADMIN, `al:hor:${idMaria}`);
await texto(ADMIN, 'segunda a sexta 7h');
assert.match(ultimaPara(ADMIN).text, /Seg 07:00 · Ter 07:00 · Qua 07:00 · Qui 07:00 · Sex 07:00/);
await botao(ADMIN, `al:atv:${idMaria}`);
assert.match(ultimaPara(ADMIN).text, /Lembretes pausados/);
await botao(ADMIN, `al:exc2:${idMaria}`);
assert.equal(sqlite.prepare('SELECT count(*) n FROM alunos').get().n, 1);
console.log('✓ editar horários, pausar e excluir');

// ---------- 14. todas as telas abrem sem erro ----------
for (const d of ['menu', 'ag:0', 'ag:1', 'al:lista', 'cf', 'cf:ant', 'cf:nome', 'al:novo']) await botao(ADMIN, d);
assert.ok(!chamadas.some((c) => /undefined|NaN/.test(c.text || '')), 'nenhuma tela com undefined/NaN');
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), env);
assert.match(await r.text(), /Bot funcionando/);
console.log('✓ todas as telas ok');

console.log('\nTODOS OS TESTES PASSARAM ✅');
