'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { HttpError } = require('../../utils/httpError');
const { OfficeRunner } = require('./office.runner');
const run = promisify(execFile);

function validateDocx(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new HttpError(422, 'DOCX_INVALIDO', 'El archivo Word no es un DOCX válido'));
      let total = 0;
      let count = 0;
      let document = false;
      let contentTypes = false;
      let stopped = false;
      const fail = message => {
        if (stopped) return;
        stopped = true;
        zip.close();
        reject(new HttpError(422, 'DOCX_INVALIDO', message));
      };
      zip.on('error', () => fail('DOCX dañado'));
      zip.on('entry', entry => {
        total += entry.uncompressedSize;
        count++;
        const name = entry.fileName;
        if (total > 100 * 1024 * 1024 || count > 10000 || (entry.generalPurposeBitFlag & 1))
          return fail('DOCX comprimido fuera de límites o cifrado');
        if (/vbaProject|word\/embeddings\//i.test(name)) return fail('No se admiten macros ni objetos incrustados');
        if (name === 'word/document.xml') document = true;
        if (name === '[Content_Types].xml') contentTypes = true;
        if (name.endsWith('.rels')) {
          if (entry.uncompressedSize > 2 * 1024 * 1024) return fail('Relaciones DOCX demasiado grandes');
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail('No se pudieron leer las relaciones DOCX');
            const parts = [];
            let size = 0;
            stream.on('error', () => fail('Relaciones DOCX dañadas'));
            stream.on('data', chunk => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) { stream.destroy(); return fail('Relaciones DOCX fuera de límites'); }
              parts.push(chunk);
            });
            stream.on('end', () => {
              if (stopped) return;
              try {
                const xml = Buffer.concat(parts).toString('utf8');
                if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return fail('Relaciones XML no admitidas');
                const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml);
                const relations = parsed.Relationships?.Relationship;
                for (const relation of relations ? Array.isArray(relations) ? relations : [relations] : []) {
                  const type = String(relation['@_Type'] || '');
                  const mode = String(relation['@_TargetMode'] || '').toLowerCase();
                  const target = String(relation['@_Target'] || '');
                  if (!type.endsWith('/hyperlink') && (mode === 'external' || /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(target)))
                    return fail('El DOCX contiene recursos externos que deben incrustarse antes de convertir');
                }
                zip.readEntry();
              } catch { fail('Relaciones XML inválidas'); }
            });
          });
        } else zip.readEntry();
      });
      zip.on('end', () => {
        if (stopped) return;
        if (!document || !contentTypes) return reject(new HttpError(422, 'DOCX_INVALIDO', 'El ZIP no es un documento Word'));
        resolve();
      });
      zip.readEntry();
    });
  });
}

function createConverter(config, exec = run) {
  const office = exec === run && config.CONVERSION_MODE !== 'process' ? new OfficeRunner(config) : null;
  const convert = async bytes => {
    await validateDocx(bytes);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genika-radicado-'));
    try {
      await fs.writeFile(path.join(directory, 'documento.docx'), bytes);
      if (office) await office.convert(path.join(directory, 'documento.docx'), path.join(directory, 'documento.pdf'));
      else try {
        await exec(config.LIBREOFFICE_PATH, [
          `-env:UserInstallation=${pathToFileURL(path.join(directory, 'perfil')).href}`,
          '--headless', '--nologo', '--nodefault', '--nofirststartwizard',
          '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory,
          path.join(directory, 'documento.docx'),
        ], { timeout: config.CONVERSION_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, cwd: directory });
      } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(503, 'CONVERSOR_NO_DISPONIBLE', 'La conversión de Word no está disponible en este servidor. Puedes cargar un PDF exportado desde Word');
        throw error;
      }
      const output = path.join(directory, 'documento.pdf');
      const stat = await fs.stat(output);
      if (stat.size > config.maxBytes * 5) throw new HttpError(413, 'PDF_GRANDE', 'El PDF convertido supera el límite');
      return await fs.readFile(output);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error.killed || error.signal) throw new HttpError(504, 'CONVERSION_TIMEOUT', 'La conversión superó el tiempo permitido');
      throw new HttpError(422, 'CONVERSION_FALLIDA', 'No fue posible convertir el Word a PDF');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
  convert.warm = () => office ? office.start() : Promise.resolve();
  convert.close = () => office ? office.close() : Promise.resolve();
  return convert;
}
module.exports = { createConverter, validateDocx };
