import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const AUTH_DIR = path.resolve(process.env.PASTA_DADOS || 'dados', 'sessao-whatsapp');
const MOCK = process.env.MOCK_WA === '1';

export const wa = new EventEmitter();
wa.estado = { status: 'desconectado', qr: null, numero: null, erro: null };
wa.enviadas = []; // usado só no modo de teste

let sock = null;
let lib = null;
let pairing = null; // { phone, resolve, reject }
let reconnectTimer = null;

function setEstado(patch) {
  Object.assign(wa.estado, patch);
  wa.emit('estado', wa.estado);
}

async function loadLib() {
  if (lib) return lib;
  const B = await import('baileys');
  const L = B.makeWASocket ? B : (B.default && B.default.makeWASocket ? B.default : B);
  lib = {
    makeWASocket: L.makeWASocket || L.default || B.default,
    useMultiFileAuthState: L.useMultiFileAuthState,
    DisconnectReason: L.DisconnectReason,
    fetchLatestBaileysVersion: L.fetchLatestBaileysVersion,
    Browsers: L.Browsers,
  };
  return lib;
}

export async function start() {
  if (MOCK) {
    setEstado({ status: 'conectado', numero: '5599999999999 (teste)', qr: null });
    return;
  }
  clearTimeout(reconnectTimer);
  const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = await loadLib();
  const { default: pino } = await import('pino');

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a padrão */ }

  setEstado({ status: 'conectando', erro: null });
  const s = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: Browsers ? Browsers.ubuntu('Chrome') : undefined,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (u) => {
    if (sock !== s) return;
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      setEstado({ status: 'qr', qr });
      if (pairing && !pairing.pedido) {
        pairing.pedido = true;
        try {
          const code = await s.requestPairingCode(pairing.phone);
          pairing.resolve(code);
        } catch (e) {
          pairing.reject(e);
        }
        pairing = null;
      }
    }

    if (connection === 'open') {
      const id = s.user?.id || '';
      setEstado({ status: 'conectado', qr: null, numero: id.split(':')[0].split('@')[0], erro: null });
      console.log('[whatsapp] conectado como', wa.estado.numero);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const deslogado = code === DisconnectReason.loggedOut;
      console.log('[whatsapp] conexão fechada, código', code);
      sock = null;
      if (deslogado) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setEstado({ status: 'desconectado', qr: null, numero: null, erro: 'O WhatsApp foi desconectado. Conecte de novo.' });
      } else {
        setEstado({ status: 'conectando', qr: null });
      }
      reconnectTimer = setTimeout(() => start().catch(err), deslogado ? 1000 : 4000);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const jid = m.key.remoteJid || '';
      if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      const texto =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.ephemeralMessage?.message?.conversation ||
        m.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
        '';
      if (!texto) continue;
      const jids = [m.key.remoteJid, m.key.remoteJidAlt, m.key.senderPn, m.key.participant, m.key.participantAlt].filter(Boolean);
      wa.emit('mensagem', { jids, texto: texto.trim() });
    }
  });
}

function err(e) {
  console.error('[whatsapp] erro ao conectar:', e?.message || e);
  setEstado({ status: 'conectando', erro: String(e?.message || e) });
  reconnectTimer = setTimeout(() => start().catch(err), 15000);
}

export function iniciar() {
  start().catch(err);
}

/** Pede o código de 8 letras para conectar sem QR Code (Aparelhos conectados > Conectar com número). */
export function pedirCodigo(phone) {
  if (MOCK) return Promise.resolve('TESTE123');
  if (wa.estado.status === 'conectado') return Promise.reject(new Error('O WhatsApp já está conectado.'));
  return new Promise((resolve, reject) => {
    pairing = { phone, resolve, reject };
    const t = setTimeout(() => {
      if (pairing && pairing.phone === phone) { pairing = null; reject(new Error('Demorou demais. Tente de novo.')); }
    }, 60000);
    const done = (fn) => (v) => { clearTimeout(t); fn(v); };
    pairing.resolve = done(resolve);
    pairing.reject = done(reject);
    // reinicia a conexão para gerar um novo pedido na hora
    if (sock) { try { sock.end(undefined); } catch {} sock = null; }
    clearTimeout(reconnectTimer);
    start().catch(err);
  });
}

export async function desconectar() {
  if (MOCK) return;
  if (sock) {
    try { await sock.logout(); } catch {}
  }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

/**
 * Descobre o "endereço" de WhatsApp do número. No Brasil, muitas contas antigas
 * estão registradas sem o 9 extra, então testa com e sem ele.
 */
export async function resolverJid(phone) {
  if (MOCK) return phone + '@s.whatsapp.net';
  if (!sock || wa.estado.status !== 'conectado') throw new Error('WhatsApp desconectado');
  const cands = [phone];
  if (phone.startsWith('55') && phone.length === 13 && phone[4] === '9') cands.push(phone.slice(0, 4) + phone.slice(5));
  if (phone.startsWith('55') && phone.length === 12) cands.push(phone.slice(0, 4) + '9' + phone.slice(4));
  for (const c of cands) {
    const r = await sock.onWhatsApp(c);
    const hit = r && r.find((x) => x.exists);
    if (hit) return hit.jid;
  }
  throw new Error('Esse número não tem WhatsApp');
}

export async function enviarTexto(jid, texto) {
  if (MOCK) {
    wa.enviadas.push({ jid, texto, em: new Date().toISOString() });
    console.log(`\n[teste] mensagem para ${jid}:\n${texto}\n`);
    return;
  }
  if (!sock || wa.estado.status !== 'conectado') throw new Error('WhatsApp desconectado');
  await sock.sendMessage(jid, { text: texto });
}

export function conectado() {
  return wa.estado.status === 'conectado';
}
