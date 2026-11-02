// Teste local: simula o banco D1 (SQLite do Node) e a API do WhatsApp (Graph API da Meta).
// Rode com: npm run teste
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import worker, { entenderHorarios, _cron, _hmacHex } from '../src/index.js';
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
const DB = { prepare: (s) => stmt(s), batch: async (l) => { for (const s of l) await s.run(); } };

// banco antigo da versão do Telegram, para testar a migração
sqlite.exec(`CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE alunos (id TEXT PRIMARY KEY, nome TEXT NOT NULL, chat_id INTEGER, convite TEXT UNIQUE, ativo INTEGER NOT NULL DEFAULT 1, horarios TEXT NOT NULL DEFAULT '[]', criado INTEGER);
  CREATE TABLE sessoes (chave TEXT PRIMARY KEY, aluno_id TEXT, nome TEXT, chat_id INTEGER, data TEXT, hora TEXT, inicio INTEGER, status TEXT, msg_id INTEGER, enviado INTEGER, respondido INTEGER, erro TEXT);
  INSERT INTO config VALUES ('admin', '1111'), ('bot', 'VelhoBot'), ('personal', 'Prof. Antigo');
  INSERT INTO alunos VALUES ('velho0001', 'Aluno Antigo', 555, 'convVelho01', 1, '[]', 1);
  INSERT INTO sessoes (chave, nome, status) VALUES ('x|y|z', 'Aluno Antigo', 'pendente');`);

// ---------- API do WhatsApp falsa ----------
const API = 'http://graph.falso';
const env = { DB, WA_API: API, WA_TOKEN: 'tok', WA_PHONE_ID: '1001', WA_WABA_ID: '2002', WA_APP_ID: '3003', WA_APP_SECRET: 'segredo-app' };
const ctx = { waitUntil: (p) => p };
const ADMIN = '5599911110000', MARIA = '5599922220000', JOAO = '5599933330000', ESTRANHO = '5599999990000';

const enviadas = [];       // mensagens que o bot mandou
const chamadas = [];       // todas as chamadas à API
const modelos = [];
let seq = 0;
let plataforma = 'NOT_APPLICABLE';
const falhas = { modelo: 0, janelaAdmin: false }; // erros simulados
globalThis.fetch = async (url, opts = {}) => {
  const caminho = url.slice(API.length + 1);
  const corpo = opts.body ? JSON.parse(opts.body) : null;
  const metodo = opts.method || 'GET';
  chamadas.push({ caminho, metodo, corpo, auth: opts.headers?.Authorization });
  const resp = (j, status = 200) => new Response(JSON.stringify(j), { status });
  const erro = (code, message) => resp({ error: { code, message } }, 400);
  if (caminho === '1001/messages') {
    if (corpo.type === 'template' && falhas.modelo) return erro(falhas.modelo, 'Template name does not exist in the translation');
    if (corpo.to === ADMIN && corpo.type !== 'template' && falhas.janelaAdmin) return erro(131047, 'Re-engagement message');
    validar(corpo);
    enviadas.push(corpo);
    return resp({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${++seq}` }] });
  }
  if (caminho.startsWith('1001?')) return resp({ display_phone_number: '+55 99 98888-7777', verified_name: 'Lembretes Prof', platform_type: plataforma, id: '1001' });
  if (caminho === '1001/register') { plataforma = 'CLOUD_API'; return resp({ success: true }); }
  if (caminho === '3003/subscriptions') return resp({ success: true });
  if (caminho === '2002/subscribed_apps') return resp({ success: true });
  if (caminho.startsWith('2002/message_templates?')) return resp({ data: modelos });
  if (caminho === '2002/message_templates') { modelos.push({ name: corpo.name, language: corpo.language, status: 'PENDING' }); return resp({ id: 't' + modelos.length, status: 'PENDING', category: 'UTILITY' }); }
  return erro(100, `rota desconhecida ${metodo} ${caminho}`);
};

// regras da Meta para mensagens interativas
const cp = (s) => [...String(s)].length;
function validar(m) {
  assert.ok(m.to && m.messaging_product === 'whatsapp');
  if (m.type === 'text') { assert.ok(cp(m.text.body) <= 4096 && m.text.body.length > 0); assert.ok(!/undefined|NaN|null/.test(m.text.body), m.text.body); }
  if (m.type === 'interactive') {
    const i = m.interactive;
    assert.ok(!/undefined|NaN/.test(JSON.stringify(i)), JSON.stringify(i));
    if (i.type === 'button') {
      assert.ok(cp(i.body.text) <= 1024);
      assert.ok(i.action.buttons.length >= 1 && i.action.buttons.length <= 3);
      for (const b of i.action.buttons) assert.ok(cp(b.reply.title) <= 20 && b.reply.id.length <= 256, b.reply.title);
      assert.equal(new Set(i.action.buttons.map((b) => b.reply.id)).size, i.action.buttons.length, 'ids repetidos');
    } else if (i.type === 'list') {
      assert.ok(cp(i.body.text) <= 4096 && cp(i.action.button) <= 20);
      const rows = i.action.sections.flatMap((s) => s.rows);
      assert.ok(rows.length >= 1 && rows.length <= 10, `lista com ${rows.length} linhas`);
      for (const r of rows) assert.ok(cp(r.title) <= 24 && (!r.description || cp(r.description) <= 72) && r.id.length <= 200, r.title);
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'ids repetidos');
    } else if (i.type === 'cta_url') {
      assert.ok(cp(i.body.text) <= 1024 && cp(i.action.parameters.display_text) <= 20);
    } else assert.fail('tipo interativo desconhecido ' + i.type);
  }
  if (m.type === 'template') {
    for (const c of m.template.components) for (const p of c.parameters) {
      if (p.type === 'text') assert.ok(p.text && !/[\n\t]| {4}/.test(p.text), 'parâmetro inválido: ' + p.text);
    }
  }
}

// ---------- ajudantes ----------
let mid = 0;
async function webhook(value, assinar = true) {
  const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2002', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1001' }, ...value } }] }] });
  const headers = assinar ? { 'X-Hub-Signature-256': 'sha256=' + (await _hmacHex(env.WA_APP_SECRET, corpo)) } : {};
  const r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/whatsapp', { method: 'POST', headers, body: corpo }), env);
  return r.status;
}
const receber = async (de, msg) => assert.equal(await webhook({ contacts: [{ wa_id: de, profile: { name: 'x' } }], messages: [{ from: de, id: `in.${++mid}`, timestamp: '1', ...msg }] }), 200);
const texto = (de, body) => receber(de, { type: 'text', text: { body } });
const lista = (de, id) => receber(de, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 't' } } });
const botao = (de, id) => receber(de, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 't' } } });
const botaoModelo = (de, payload) => receber(de, { type: 'button', button: { payload, text: 't' } });

const corpoDe = (m) => m.text?.body ?? m.interactive?.body?.text ?? '';
const ultimaPara = (n) => [...enviadas].reverse().find((m) => m.to === n);
const textoPara = (n) => corpoDe(ultimaPara(n) || {});
const opcoesDe = (m) => m.interactive?.action?.buttons?.map((b) => b.reply) || m.interactive?.action?.sections?.flatMap((s) => s.rows) || [];
const paraQuem = (n) => enviadas.filter((m) => m.to === n);
const limpar = () => { enviadas.length = 0; chamadas.length = 0; };

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
console.log('✓ horários');

// ---------- 2. faltando segredos ----------
let r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), { DB });
assert.match(await r.text(), /WA_TOKEN/);
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/privacidade'), { DB });
assert.match(await r.text(), /Política de privacidade/);
console.log('✓ página avisa os segredos que faltam + política de privacidade');

// ---------- 3. ativação pela página ----------
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), env);
let html = await r.text();
assert.match(html, /Bot ativado/, html);
assert.doesNotMatch(html, /Falta resolver/, html);
assert.match(html, /\+5599988887777/);
assert.match(html, /PIN de confirmação/);
assert.match(html, /em análise pela Meta/);
const codigoAdmin = decodeURIComponent(html.match(/wa\.me\/5599988887777\?text=([^"&]+)/)[1]).split(' ')[1];
assert.ok(codigoAdmin);
const sub = chamadas.find((c) => c.caminho === '3003/subscriptions');
assert.equal(sub.corpo.callback_url, 'https://bot.exemplo.workers.dev/whatsapp');
assert.equal(sub.auth, 'Bearer 3003|segredo-app');
assert.ok(chamadas.some((c) => c.caminho === '1001/register' && /^\d{6}$/.test(c.corpo.pin)));
assert.deepEqual(modelos.map((m) => m.name), ['lembrete_treino', 'avisos_personal']);
// recarregar não cria os modelos de novo nem registra de novo
limpar();
modelos.forEach((m) => (m.status = 'APPROVED'));
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), env);
html = await r.text();
assert.match(html, /aprovada/);
assert.ok(!chamadas.some((c) => c.caminho === '2002/message_templates' || c.caminho === '1001/register'));
// verificação do webhook pela Meta
const vt = sub.corpo.verify_token;
r = await worker.fetch(new Request(`https://bot.exemplo.workers.dev/whatsapp?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=4242`), env);
assert.equal(await r.text(), '4242');
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1'), env);
assert.equal(r.status, 403);
assert.equal(await webhook({ messages: [] }, false), 403, 'sem assinatura é recusado');
console.log('✓ ativação: número registrado, webhook ligado, modelos criados');

// migração da versão do Telegram
assert.equal(sqlite.prepare("SELECT v FROM config WHERE k='admin'").get(), undefined);
assert.equal(sqlite.prepare("SELECT v FROM config WHERE k='personal'").get().v, 'Prof. Antigo');
assert.equal(sqlite.prepare("SELECT wa FROM alunos WHERE id='velho0001'").get().wa, null);
assert.equal(sqlite.prepare('SELECT count(*) n FROM sessoes').get().n, 0);
sqlite.prepare("DELETE FROM alunos WHERE id='velho0001'").run();
console.log('✓ migração do banco do Telegram (alunos mantidos, admin zerado)');

// ---------- 4. o personal vira admin ----------
limpar();
await texto(ADMIN, 'admin errado');
assert.match(textoPara(ADMIN), /Código inválido/);
await texto(ADMIN, `admin ${codigoAdmin}`);
assert.match(textoPara(ADMIN), /administrador/);
await texto(ADMIN, 'Prof. Lorran');
assert.match(textoPara(ADMIN), /Lembretes de treino/);
assert.equal(ultimaPara(ADMIN).interactive.type, 'list');
await texto(ESTRANHO, `admin ${codigoAdmin}`);
assert.match(textoPara(ESTRANHO), /Peça o link de convite/);
console.log('✓ administrador definido; estranho não vira admin');

// ---------- 5. cadastrar alunos ----------
const agora = Date.now();
const emUmaHora = agora + 60 * 60000;           // treino daqui a 1h -> lembrete (2h antes) já deve sair
const em5h = agora + 5 * 3600000;               // treino daqui a 5h -> ainda não
const diaTxt = (ms) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][weekday(localDate(ms))];
const codigoDoConvite = () => {
  const m = [...enviadas].reverse().find((x) => x.to === ADMIN && x.interactive?.type === 'cta_url');
  const convite = decodeURIComponent(m.interactive.action.parameters.url.split('text=')[1]);
  const link = convite.match(/https:\/\/wa\.me\/5599988887777\?text=(\S+)/)[1];
  return decodeURIComponent(link);
};

await lista(ADMIN, 'al:novo');
await texto(ADMIN, 'Maria Souza');
await texto(ADMIN, 'xyz');
assert.match(textoPara(ADMIN), /Não entendi/);
await texto(ADMIN, `${diaTxt(emUmaHora)} ${localTime(emUmaHora)}`);
const cta = paraQuem(ADMIN).at(-2);
assert.equal(cta.interactive.type, 'cta_url');
assert.match(corpoDe(cta), /Maria Souza\* cadastrado/);
assert.match(cta.interactive.action.parameters.url, /^https:\/\/wa\.me\/\?text=/);
const msgMaria = codigoDoConvite();
assert.match(msgMaria, /^Quero receber os lembretes de treino \(código \w{10}\)$/);

await texto(ADMIN, 'novo');
await texto(ADMIN, 'João Pedro');
await texto(ADMIN, `${diaTxt(em5h)} ${localTime(em5h)}`);
const msgJoao = codigoDoConvite();
console.log('✓ alunos cadastrados com link de convite');

// ---------- 6. aluno ativa pelo link ----------
limpar();
await texto(MARIA, msgMaria);
assert.match(textoPara(MARIA), /Pronto!/);
assert.match(textoPara(ADMIN), /Maria Souza\* ativou/);
await texto(MARIA, 'Quero receber os lembretes de treino (código AAAAAAAAAA)');
assert.match(textoPara(MARIA), /não vale mais/);
console.log('✓ aluno ativou, personal avisado');

// ---------- 7. cron manda o lembrete ----------
limpar();
await _cron(env, agora);
let lemb = paraQuem(MARIA);
assert.equal(lemb.length, 1);
assert.equal(lemb[0].type, 'template');
assert.equal(lemb[0].template.name, 'lembrete_treino');
const params = lemb[0].template.components[0].parameters.map((p) => p.text);
assert.deepEqual(params, ['Maria', `hoje às ${localTime(emUmaHora)}`, 'Prof. Lorran']);
const vou = lemb[0].template.components[1].parameters[0].payload;
const naoVou = lemb[0].template.components[2].parameters[0].payload;
assert.match(vou, /^r:.+:1$/);
assert.equal(paraQuem(ADMIN).length, 0, 'João ainda não tem lembrete (treino em 5h)');
await _cron(env, agora + 60000);
assert.equal(paraQuem(MARIA).length, 1, 'não pode repetir');
console.log('✓ lembrete (modelo aprovado) enviado uma vez só');

// ---------- 8. aluno toca nos botões ----------
limpar();
await botaoModelo(MARIA, vou);
assert.match(textoPara(MARIA), /Presença confirmada/);
assert.equal(opcoesDe(ultimaPara(MARIA))[0].id, naoVou);
assert.match(textoPara(ADMIN), /✅ \*Maria Souza\* confirmou/);
limpar();
await botaoModelo(MARIA, vou);
assert.equal(paraQuem(ADMIN).length, 0, 'tocar de novo não avisa de novo');
await botao(MARIA, naoVou); // o "↩️ Não vou mais" da resposta
assert.match(textoPara(ADMIN), /mudou de ideia: \*não vai\*/);
await botaoModelo(JOAO, vou);
assert.match(textoPara(JOAO), /não foi encontrado/);
console.log('✓ botões Sim, vou / Não vou + aviso ao personal');

// ---------- 9. mensagem repetida pela Meta é ignorada ----------
limpar();
const repetida = { contacts: [], messages: [{ from: MARIA, id: 'dup.1', type: 'text', text: { body: 'oi prof' } }] };
await webhook(repetida);
await webhook(repetida);
assert.equal(paraQuem(MARIA).length, 1);
console.log('✓ mensagem duplicada tratada uma vez só');

// ---------- 10. agenda do personal ----------
limpar();
await texto(ADMIN, 'hoje');
assert.match(textoPara(ADMIN), /Maria Souza\n\s+❌ não vai/);
console.log('✓ agenda:\n' + textoPara(ADMIN).split('\n').map((l) => '    ' + l).join('\n'));

// ---------- 11. João sem WhatsApp ativado: personal é avisado na hora do lembrete ----------
limpar();
await _cron(env, em5h - 2 * 3600000 + 1000);
assert.match(textoPara(ADMIN), /João Pedro\* tem treino .* ainda não ativou/);
await texto(JOAO, msgJoao);
const chaveJoao = sqlite.prepare("SELECT chave FROM sessoes WHERE nome = 'João Pedro'").get().chave;
limpar();
await lista(ADMIN, `it:env:${chaveJoao}`);
assert.equal(paraQuem(JOAO).filter((m) => m.type === 'template').length, 1);
assert.match(textoPara(ADMIN), /^✅ Lembrete enviado\./);
console.log('✓ aviso de aluno sem WhatsApp + reenviar pela agenda');

// ---------- 12. Meta avisa que não entregou ----------
const wamidJoao = sqlite.prepare("SELECT wamid FROM sessoes WHERE nome = 'João Pedro'").get().wamid;
limpar();
await webhook({ statuses: [{ id: wamidJoao, status: 'failed', recipient_id: JOAO, errors: [{ code: 131026, title: 'Message undeliverable' }] }] });
assert.match(textoPara(ADMIN), /João Pedro\* .* não foi entregue/);
assert.ok(opcoesDe(ultimaPara(ADMIN)).some((o) => o.id.startsWith('al:conv:')));
assert.equal(sqlite.prepare("SELECT status FROM sessoes WHERE nome = 'João Pedro'").get().status, 'erro');
console.log('✓ aviso quando a Meta não consegue entregar');

// ---------- 13. mensagem do aluno é encaminhada ----------
limpar();
await texto(MARIA, 'Prof, posso ir 18h em vez de 17h?');
assert.match(textoPara(ADMIN), /Mensagem de \*Maria Souza\*:\nProf, posso ir 18h/);
assert.match(textoPara(ADMIN), /wa\.me\/5599922220000/);
assert.match(textoPara(MARIA), /Passei sua mensagem para Prof\. Lorran/);
await receber(MARIA, { type: 'audio', audio: { id: 'a1' } });
assert.match(textoPara(ADMIN), /mandou um áudio/);
assert.match(textoPara(MARIA), /só consigo repassar mensagens de texto/);
console.log('✓ mensagem do aluno encaminhada');

// ---------- 14. personal fora da janela de 24h: avisos guardados ----------
sqlite.prepare("UPDATE config SET v = ? WHERE k = 'admin_ultimo'").run(String(Date.now() - 25 * 3600000));
limpar();
await texto(MARIA, 'primeira');
await texto(MARIA, 'segunda');
let paraAdmin = paraQuem(ADMIN);
assert.equal(paraAdmin.length, 1, 'só um modelo de avisos');
assert.equal(paraAdmin[0].template.name, 'avisos_personal');
assert.equal(paraAdmin[0].template.components[0].parameters[0].text, '1');
// a Meta recusa mensagem livre mesmo achando que a janela estava aberta
falhas.janelaAdmin = true;
sqlite.prepare("UPDATE config SET v = ? WHERE k = 'admin_ultimo'").run(String(Date.now()));
await texto(MARIA, 'terceira');
falhas.janelaAdmin = false;
assert.equal(sqlite.prepare('SELECT count(*) n FROM avisos').get().n, 3);
limpar();
await botaoModelo(ADMIN, 'avisos');
paraAdmin = paraQuem(ADMIN);
assert.match(corpoDe(paraAdmin[0]), /Avisos enquanto você estava fora\* \(3\)/);
assert.match(corpoDe(paraAdmin[0]), /primeira[\s\S]*segunda[\s\S]*terceira/);
assert.match(corpoDe(paraAdmin[1]), /Lembretes de treino/);
assert.equal(sqlite.prepare('SELECT count(*) n FROM avisos').get().n, 0);
console.log('✓ fora da janela de 24h: avisos guardados e entregues depois');

// ---------- 15. modelo não aprovado ----------
const amanha = addDays(localDate(), 1);
const idMaria = sqlite.prepare("SELECT id FROM alunos WHERE nome = 'Maria Souza'").get().id;
sqlite.prepare("UPDATE alunos SET horarios = ? WHERE id = ?").run(JSON.stringify([{ dia: weekday(amanha), hora: '10:00' }]), idMaria);
falhas.modelo = 132001;
limpar();
await _cron(env, toEpoch(amanha, '08:00'));
assert.match(textoPara(ADMIN), /Não consegui mandar o lembrete para \*Maria Souza\*.*\nA mensagem do lembrete ainda não foi aprovada/);
falhas.modelo = 0;
sqlite.prepare('DELETE FROM sessoes WHERE aluno_id = ?').run(idMaria);
console.log('✓ aviso quando o modelo ainda não foi aprovado');

// ---------- 16. ajustes, pausa e pular ----------
await lista(ADMIN, 'cf:antv:60');
assert.equal(sqlite.prepare("SELECT v FROM config WHERE k='antecedencia'").get().v, '60');
assert.match(textoPara(ADMIN), /^✅ Lembrete 1 hora antes/);
await lista(ADMIN, 'cf:pausa');
limpar();
await _cron(env, toEpoch(amanha, '09:30'));
assert.equal(enviadas.length, 0, 'pausado não envia');
await lista(ADMIN, 'cf:pausa');
await botao(ADMIN, `it:pul:${amanha}|${idMaria}|10:00`);
limpar();
await _cron(env, toEpoch(amanha, '09:30'));
assert.equal(paraQuem(MARIA).length, 0, 'pulado não envia');
await botao(ADMIN, `it:vol:${amanha}|${idMaria}|10:00`);
limpar();
await _cron(env, toEpoch(amanha, '09:00') - 1000);
assert.equal(enviadas.length, 0, 'com 1h de antecedência, 9:00 ainda é cedo');
await _cron(env, toEpoch(amanha, '09:00'));
assert.equal(paraQuem(MARIA).length, 1);
console.log('✓ antecedência, pausa e "não enviar este lembrete"');

// ---------- 17. editar horários, pausar e excluir aluno ----------
await lista(ADMIN, `al:hor:${idMaria}`);
await texto(ADMIN, 'segunda a sexta 7h');
assert.match(textoPara(ADMIN), /Seg 07:00 · Ter 07:00 · Qua 07:00 · Qui 07:00 · Sex 07:00/);
await lista(ADMIN, `al:atv:${idMaria}`);
assert.match(textoPara(ADMIN), /Lembretes pausados/);
await botao(ADMIN, `al:exc2:${idMaria}`);
assert.equal(sqlite.prepare('SELECT count(*) n FROM alunos').get().n, 1);
console.log('✓ editar horários, pausar e excluir');

// ---------- 18. muitos alunos: lista paginada ----------
for (let i = 1; i <= 12; i++) sqlite.prepare("INSERT INTO alunos (id, nome, convite, horarios) VALUES (?, ?, ?, '[]')").run('ext' + i, `Aluno Extra Com Nome Bem Comprido ${i}`, 'cv' + i);
await lista(ADMIN, 'al:lista');
assert.match(textoPara(ADMIN), /página 1 de 2/);
await lista(ADMIN, 'al:lista:1');
assert.match(textoPara(ADMIN), /página 2 de 2/);
console.log('✓ lista de alunos paginada');

// ---------- 19. todas as telas abrem sem erro ----------
for (const d of ['menu', 'ag:0', 'ag:1', 'al:lista', 'cf', 'cf:ant', 'cf:nome', 'menu', 'al:novo', 'menu', 'ajuda', 'al:ver:ext1', 'al:conv:ext1']) await lista(ADMIN, d);
for (const t of ['menu', 'hoje', 'amanhã', 'alunos', 'ajustes', 'ajuda', 'qualquer coisa']) await texto(ADMIN, t);
r = await worker.fetch(new Request('https://bot.exemplo.workers.dev/'), env);
assert.match(await r.text(), /Bot funcionando/);
console.log('✓ todas as telas ok (e dentro dos limites da Meta)');

console.log('\nTODOS OS TESTES PASSARAM ✅');
