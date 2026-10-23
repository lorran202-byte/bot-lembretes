import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.PASTA_DADOS || path.resolve('dados');
const FILE = path.join(DATA_DIR, 'dados.json');

export const MENSAGEM_PADRAO =
  'Olá, {nome}! 💪\n' +
  'Lembrete do seu treino *{dia} às {hora}*.\n\n' +
  'Toque no link para confirmar sua presença:\n{link}\n\n' +
  'Se preferir, responda *1* (vou) ou *2* (não vou).\n' +
  '— {personal}';

const defaults = () => ({
  config: {
    personal: 'Seu personal',
    telefonePersonal: '',
    antecedenciaMin: 120,
    mensagem: MENSAGEM_PADRAO,
    avisarPersonal: true,
    pausado: false,
  },
  alunos: [],
  sessoes: {},
});

let data;
let saveTimer = null;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const d = defaults();
    data = { ...d, ...raw, config: { ...d.config, ...(raw.config || {}) } };
  } else {
    data = defaults();
    saveNow();
  }
  return data;
}

export function db() {
  return data;
}

export function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 300);
}

export function newId(bytes = 6) {
  return randomBytes(bytes).toString('base64url');
}

/** Deixa só os dígitos e coloca o 55 do Brasil quando faltar. */
export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

/** Remove sessões com mais de 45 dias. */
export function cleanup() {
  const limite = Date.now() - 45 * 86400000;
  let mudou = false;
  for (const [k, s] of Object.entries(data.sessoes)) {
    if ((s.inicio || 0) < limite) {
      delete data.sessoes[k];
      mudou = true;
    }
  }
  if (mudou) save();
}

process.on('exit', () => { if (saveTimer) saveNow(); });
