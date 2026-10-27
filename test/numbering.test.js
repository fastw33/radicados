'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emissionYear, counterKey, formatNumber } = require('../src/modules/radicados/radicado.numbering');

test('DG usa mínimo tres dígitos y continúa después de 999 sin truncar', () => {
  assert.equal(formatNumber(2026, 1), 'DG-2026-001');
  assert.equal(formatNumber(2026, 999), 'DG-2026-999');
  assert.equal(formatNumber(2026, 1000), 'DG-2026-1000');
  assert.equal(counterKey(2027), 'DG:2027');
  assert.throws(() => formatNumber(2026, 0));
});
test('el año cambia en medianoche de Bogotá, no en medianoche UTC', () => {
  assert.equal(emissionYear(new Date('2027-01-01T04:59:59.999Z')), 2026);
  assert.equal(emissionYear(new Date('2027-01-01T05:00:00.000Z')), 2027);
});
