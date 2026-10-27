'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { OfficeRunner } = require('../src/integrations/office/office.runner');
const { testConfig } = require('./helpers');

function fakeOffice({ failFirst = false, timeoutFirst = false, restartFirst = false } = {}) {
  const state = { starts: 0, active: 0, maxActive: 0, inputs: [], stopped: 0 };
  let requests = 0;
  state.launch = () => {
    state.starts++;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.exitCode = null;
    const timers = new Set();
    const exit = () => {
      if (child.exitCode !== null) return;
      for (const timer of timers) clearTimeout(timer);
      state.stopped++;
      child.exitCode = 0;
      child.emit('exit', 0);
      child.stdout.end();
    };
    child.kill = exit;
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const data = JSON.parse(chunk.toString());
      callback();
      if (data.stop) { exit(); return; }
      requests++;
      state.inputs.push(data.input);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      if (timeoutFirst && requests === 1) { state.active--; return; }
      const ok = !(failFirst && requests === 1);
      const restart = restartFirst && requests === 1;
      const timer = setTimeout(() => {
        state.active--;
        child.stdout.write(JSON.stringify({ id: data.id, ok, restart }) + '\n');
        if (restart) exit();
      }, 5);
      timers.add(timer);
    } });
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  };
  return state;
}

test('el motor preparado reutiliza el proceso y convierte en serie sin cruzar solicitudes', async () => {
  const fake = fakeOffice();
  const runner = new OfficeRunner(testConfig(), fake.launch);
  try {
    await runner.start();
    await Promise.all([runner.convert('/documento-a.docx', '/a.pdf'), runner.convert('/documento-b.docx', '/b.pdf')]);
    assert.equal(fake.starts, 1);
    assert.equal(fake.maxActive, 1);
    assert.deepEqual(fake.inputs, ['/documento-a.docx', '/documento-b.docx']);
  } finally { await runner.close(); }
  assert.equal(fake.stopped, 1);
  await assert.rejects(runner.convert('/c.docx', '/c.pdf'), { code: 'CONVERSOR_NO_DISPONIBLE' });
});

test('un documento no convertible no impide convertir el siguiente', async () => {
  const fake = fakeOffice({ failFirst: true });
  const runner = new OfficeRunner(testConfig(), fake.launch);
  try {
    await assert.rejects(runner.convert('/mal.docx', '/mal.pdf'), { code: 'CONVERSION_FALLIDA' });
    await runner.convert('/bien.docx', '/bien.pdf');
    assert.equal(fake.starts, 1);
  } finally { await runner.close(); }
});

test('un trabajo bloqueado se interrumpe y el siguiente reinicia el motor', async () => {
  const fake = fakeOffice({ timeoutFirst: true });
  const runner = new OfficeRunner({ ...testConfig(), CONVERSION_TIMEOUT_MS: 100 }, fake.launch);
  try {
    await assert.rejects(runner.convert('/bloqueado.docx', '/bloqueado.pdf'), { code: 'CONVERSION_TIMEOUT' });
    await runner.convert('/bien.docx', '/bien.pdf');
    assert.equal(fake.starts, 2);
  } finally { await runner.close(); }
});

test('conserva una conversión terminada y renueva el motor si falla el cierre de Writer', async () => {
  const fake = fakeOffice({ restartFirst: true });
  const runner = new OfficeRunner(testConfig(), fake.launch);
  try {
    await runner.convert('/primero.docx', '/primero.pdf');
    await runner.convert('/segundo.docx', '/segundo.pdf');
    assert.equal(fake.starts, 2);
    assert.deepEqual(fake.inputs, ['/primero.docx', '/segundo.docx']);
  } finally { await runner.close(); }
});
