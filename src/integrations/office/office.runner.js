'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { HttpError } = require('../../utils/httpError');

const unavailable = () => new HttpError(503, 'CONVERSOR_NO_DISPONIBLE', 'El conversor de Word no está disponible. Revisa el motor LibreOffice y su Python con UNO');

class OfficeRunner {
  constructor(config, launch = spawn) {
    this.config = config;
    this.launch = launch;
    this.tail = Promise.resolve();
    this.queued = 0;
    this.exitHandler = () => this.kill();
    process.once('exit', this.exitHandler);
  }
  kill() {
    const child = this.child;
    this.child = null;
    if (child?.pid && child.exitCode === null) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill(); }
    } else child?.kill();
  }
  start() {
    if (this.closed) return Promise.reject(unavailable());
    if (this.starting) return this.starting;
    this.starting = this.boot().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }
  async boot() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genika-office-'));
    const python = this.config.LIBREOFFICE_PYTHON || (process.platform === 'win32'
      ? path.join(path.dirname(this.config.LIBREOFFICE_PATH), 'python.exe') : '/usr/bin/python3');
    const child = this.launch(python, ['-u', path.join(__dirname, 'office.worker.py'), this.config.LIBREOFFICE_PATH,
      path.join(directory, 'perfil'), `genika_${randomUUID().replaceAll('-', '')}`, String(this.config.CONVERSION_TIMEOUT_MS / 1000)], {
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    child.stdin.on('error', () => {});
    this.jobs = 0;
    const lines = createInterface({ input: child.stdout });
    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => { this.kill(); reject(new HttpError(504, 'CONVERSION_TIMEOUT', 'El conversor de Word superó el tiempo de inicio')); }, this.config.CONVERSION_TIMEOUT_MS);
      const failed = () => {
        clearTimeout(timer);
        lines.close();
        if (this.child === child) {
          this.child = null;
          this.starting = null;
          this.pending?.reject(unavailable());
          this.pending = null;
        }
        if (!ready) reject(unavailable());
        fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      };
      child.once('error', failed);
      child.once('exit', failed);
      lines.on('line', line => {
        let result;
        try { result = JSON.parse(line); } catch { return; }
        if (result.ready) { ready = true; clearTimeout(timer); resolve(); }
        else if (this.pending?.id === result.id) {
          const pending = this.pending;
          this.pending = null;
          if (result.restart) {
            this.starting = null;
            this.child = null;
          }
          if (result.ok) pending.resolve();
          else pending.reject(new HttpError(422, 'CONVERSION_FALLIDA', 'No fue posible convertir el Word a PDF'));
        }
      });
    });
  }
  convert(input, output) {
    if (this.queued >= 8) return Promise.reject(new HttpError(503, 'CAPACIDAD_OCUPADA', 'Hay varios documentos convirtiéndose. Intenta nuevamente'));
    this.queued++;
    const task = this.tail.then(async () => {
      await this.start();
      await new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.pending = null;
          this.kill(); this.starting = null;
          reject(new HttpError(504, 'CONVERSION_TIMEOUT', 'La conversión superó el tiempo permitido'));
        }, this.config.CONVERSION_TIMEOUT_MS);
        const finish = callback => value => { clearTimeout(timer); callback(value); };
        this.pending = { id, resolve: finish(resolve), reject: finish(reject) };
        this.child.stdin.write(JSON.stringify({ id, input, output }) + '\n', error => {
          if (error) { this.pending?.reject(unavailable()); this.pending = null; }
        });
      });
      this.jobs++;
      if (this.jobs >= 100) await this.stop();
    }).finally(() => { this.queued--; });
    this.tail = task.catch(() => {});
    return task;
  }
  async stop() {
    const child = this.child;
    this.starting = null;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.kill(); resolve(); }, 3500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end(JSON.stringify({ stop: true }) + '\n');
    });
  }
  async close() {
    this.closed = true;
    await this.tail;
    await this.stop();
    process.removeListener('exit', this.exitHandler);
  }
}
module.exports = { OfficeRunner };
