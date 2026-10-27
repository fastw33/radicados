'use strict';

const PREFIX = 'DG';
function emissionYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Bogota' }).format(now));
}
function counterKey(year) { return `${PREFIX}:${year}`; }
function formatNumber(year, number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Contador de radicados fuera de rango');
  return `${PREFIX}-${year}-${String(number).padStart(3, '0')}`;
}
module.exports = { emissionYear, counterKey, formatNumber };
