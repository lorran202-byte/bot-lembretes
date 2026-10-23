// Datas e horas sempre no fuso do personal, independente do fuso do servidor.
export const TZ = 'America/Fortaleza';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// Diferença (ms) entre o horário local do fuso e o UTC naquele instante.
function offsetAt(ms) {
  const p = parts(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 'AAAA-MM-DD' de hoje (ou do instante informado) no fuso local. */
export function localDate(ms = Date.now()) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:MM' do instante no fuso local. */
export function localTime(ms = Date.now()) {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

/** Converte data + hora locais em timestamp (ms). */
export function toEpoch(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetAt(guess);
  // segunda passada cobre mudanças de horário de verão, caso voltem a existir
  ts = guess - offsetAt(ts);
  return ts;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** 0 = domingo ... 6 = sábado */
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** 'sex, 23/10' */
export function shortLabel(date) {
  const [, m, d] = date.split('-');
  return `${DIAS_CURTOS[weekday(date)]}, ${d}/${m}`;
}

/** 'hoje', 'amanhã' ou 'na segunda (26/10)' em relação a hoje. */
export function relativeDay(date, now = Date.now()) {
  const today = localDate(now);
  if (date === today) return 'hoje';
  if (date === addDays(today, 1)) return 'amanhã';
  const [, m, d] = date.split('-');
  const dia = DIAS[weekday(date)];
  const prep = weekday(date) === 0 || weekday(date) === 6 ? 'no' : 'na';
  return `${prep} ${dia} (${d}/${m})`;
}
