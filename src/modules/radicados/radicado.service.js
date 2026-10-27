'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../../utils/httpError');
const { sha256 } = require('../../integrations/s3/s3.storage');
const { companyAllowed, canReadAll } = require('../../utils/permissions');
const { inspectPdf, checkPlacement, stampPdf, recognizePdf } = require('../../integrations/pdf/processor');
const { emissionYear, counterKey, formatNumber } = require('./radicado.numbering');
const { DEFAULT_BANDS, ISSUING_COMPANIES } = require('./radicado.constants');

const snapshot = actor => ({ id: actor.id_personal, id_personal: actor.id_personal, id_usuario: actor.id_usuario, name: actor.name });
const event = (evento, actor, motivo = '') => ({ evento, actor: snapshot(actor), fecha: new Date(), motivo });
const safeName = name => path.basename(name.replaceAll('\\', '/')).normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'documento';

class RadicadoService {
  constructor({ models, storage, converter, config, clock = () => new Date() }) { Object.assign(this, { models, storage, converter, config, clock }); }

  async companies(actor) {
    const configured = await this.models.Company.find(actor.admin ? {} : {
      $or: [{ activo: true, usuariosPermitidos: actor.id }, { _id: { $in: ISSUING_COMPANIES.map(company => company._id) } }],
    }).sort({ nombre: 1 }).lean();
    const ids = new Set(configured.map(company => company._id));
    const visible = configured.filter(company => actor.admin || (company.activo && companyAllowed(company, actor)));
    return [...visible, ...ISSUING_COMPANIES.filter(company => !ids.has(company._id))].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
  async saveCompany(data) {
    const { id, ...values } = data;
    // El código de empresa permanece estable. La serie documental DG es global.
    const existing = await this.models.Company.findById(id).lean();
    if (existing && existing.prefijo !== values.prefijo)
      throw new HttpError(409, 'PREFIJO_INMUTABLE', 'El prefijo de una empresa registrada no se puede cambiar');
    return this.models.Company.findOneAndUpdate({ _id: id, prefijo: values.prefijo }, { $set: values }, { upsert: true, new: true, runValidators: true }).lean();
  }
  async getCompany(id, actor) {
    const company = await this.models.Company.findById(id).lean();
    if (!company && (actor.admin || actor.permissions.radicadosEmitir === true)) {
      const standard = ISSUING_COMPANIES.find(item => item._id === id);
      if (standard) return standard;
    }
    if (!company || !company.activo || !companyAllowed(company, actor))
      throw new HttpError(403, 'EMPRESA_NO_AUTORIZADA', 'Empresa inactiva, inexistente o no autorizada para tu usuario');
    return company;
  }
  async prepare(file, actor) {
    if (!file) throw new HttpError(400, 'ARCHIVO_REQUERIDO', 'Adjunta un archivo en el campo documento');
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.pdf', '.docx'].includes(extension)) throw new HttpError(415, 'FORMATO_NO_ADMITIDO', 'Se admite PDF o Word DOCX');
    let pdf;
    if (extension === '.pdf') pdf = file.buffer;
    else pdf = await this.converter(file.buffer);
    const paginas = await inspectPdf(pdf, this.config);
    const id = randomUUID();
    const base = `${this.config.prefix}/preparaciones/${id}`;
    const uploaded = [];
    try {
      // Espera ambas operaciones incluso si una falla, para limpiar todas las claves creadas.
      const uploads = await Promise.allSettled([
        this.storage.put(`${base}/original${extension}`, file.buffer,
          extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', safeName(file.originalname)),
        ...(extension === '.pdf' ? [] : [this.storage.put(`${base}/vista-previa.pdf`, pdf, 'application/pdf', 'vista-previa.pdf')]),
      ]);
      for (const item of uploads) if (item.status === 'fulfilled') uploaded.push(item.value.key);
      const failed = uploads.find(item => item.status === 'rejected');
      if (failed) throw failed.reason;
      const original = uploads[0].value;
      const preview = extension === '.pdf' ? original : uploads[1].value;
      const created = await this.models.Preparation.create({ _id: id, actor: snapshot(actor), original, preview, paginas,
        expiresAt: new Date(Date.now() + this.config.PREVIEW_HOURS * 3600000) });
      return {
        id, expiresAt: created.expiresAt, paginas,
        vistaPrevia: `/api/v1/preparaciones/${id}/pdf`,
        coordenadas: { origen: 'superior-izquierdo', unidad: 'relativa', rango: [0, 1], referencia: 'CropBox visible con rotación aplicada' },
      };
    } catch (error) {
      // Estos objetos aún no pertenecen a un radicado y sus claves son propias de esta solicitud.
      await Promise.allSettled(uploaded.map(key => this.storage.remove(key)));
      throw error;
    }
  }
  async preparation(id, actor) {
    const doc = await this.models.Preparation.findOne({ _id: id, 'actor.id_personal': actor.id_personal }).lean();
    if (!doc) throw new HttpError(404, 'PREPARACION_NO_ENCONTRADA', 'Preparación no encontrada');
    if (doc.expiresAt <= new Date()) throw new HttpError(410, 'PREPARACION_VENCIDA', 'Carga el documento nuevamente; la preparación venció');
    return doc;
  }
  async readStored(file) {
    const bytes = await this.storage.get(file.key);
    if (sha256(bytes) !== file.sha256) throw new HttpError(502, 'OBJETO_ALTERADO', 'El archivo almacenado no coincide con su huella registrada');
    return bytes;
  }
  async preview(id, actor) {
    const doc = await this.preparation(id, actor);
    return { bytes: await this.readStored(doc.preview), nombre: 'vista-previa.pdf', mime: 'application/pdf' };
  }
  publicRecord(doc) {
    const value = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const { idempotencyKey, requestHash, original, pdf, preparacionId, _id, ...fields } = value;
    const describe = file => file ? { nombre: file.nombre, mime: file.mime, bytes: file.bytes, sha256: file.sha256 } : undefined;
    return {
      id: _id, ...fields, original: describe(original), pdf: describe(pdf),
      ...(pdf && ['issued', 'cancelled'].includes(value.estado) ? { descarga: `/api/v1/radicados/${_id}/pdf` } : {}),
    };
  }
  async replay(existing, hash) {
    if (existing.requestHash !== hash) throw new HttpError(409, 'IDEMPOTENCIA_CONFLICTO', 'La clave ya fue utilizada con datos diferentes');
    if (existing.estado === 'processing') throw new HttpError(409, 'EMISION_EN_PROCESO', 'La emisión ya está en proceso. Consulta el registro', { id: existing._id });
    if (existing.estado === 'failed') throw new HttpError(409, 'EMISION_FALLIDA', 'La emisión anterior falló. Prepara nuevamente el documento y usa otra clave', { id: existing._id });
    return { record: this.publicRecord(existing), replayed: true };
  }
  async issue(data, idempotencyKey, actor) {
    const hash = sha256(Buffer.from(JSON.stringify(data)));
    const existing = await this.models.Record.findOne({ 'actor.id_personal': actor.id_personal, idempotencyKey }).lean();
    if (existing) return this.replay(existing, hash);
    const company = await this.getCompany(data.empresaId, actor);
    const area = data.areaNombre
      ? { nombre: data.areaNombre }
      : data.areaId ? company.areas.find(a => a.id === data.areaId) : undefined;
    if (data.areaId && !area) throw new HttpError(422, 'AREA_INVALIDA', 'El área no pertenece a la empresa');
    const prepared = await this.preparation(data.preparacionId, actor);
    const selection = data.ubicaciones[0];
    if (!prepared.paginas.some(page => page.pagina === selection.pagina))
      throw new HttpError(422, 'PAGINA_INEXISTENTE', `No existe la página ${selection.pagina}`);
    const ubicaciones = prepared.paginas.map(page => ({ ...selection, pagina: page.pagina }));
    const pdfBytes = await this.readStored(prepared.preview);
    const originalBytes = await this.readStored(prepared.original);
    // El año se calcula en Colombia al emitir, sin confiar en la fecha enviada por el navegador.
    const year = emissionYear(this.clock());
    const franjasMembrete = company.franjasMembrete || DEFAULT_BANDS;
    const seriesKey = counterKey(year);
    const currentCounter = await this.models.Counter.findById(seriesKey).lean();
    const expectedNumber = (currentCounter?.value || 0) + 1;
    // Comprueba el próximo código real, para admitir selecciones pequeñas del membrete.
    // Si una carrera amplía el número de dígitos, stampPdf vuelve a validar el texto
    // definitivo antes de dibujar. Un fallo conserva su número y queda auditado.
    await checkPlacement(pdfBytes, this.config, ubicaciones, formatNumber(year, expectedNumber), franjasMembrete);
    let record;
    try {
      record = await this.models.Record.create({
        _id: randomUUID(), preparacionId: data.preparacionId, idempotencyKey, requestHash: hash,
        actor: snapshot(actor), empresa: { id: company._id, nombre: company.nombre, prefijo: company.prefijo },
        area, referencia: data.referencia, responsable: data.responsable,
        destinatario: data.destinatario, fechaEmision: data.fechaEmision, ubicaciones, franjasMembrete,
        estado: 'processing', historial: [event('emision_iniciada', actor)],
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const replay = await this.models.Record.findOne({ 'actor.id_personal': actor.id_personal, idempotencyKey }).lean();
      if (replay) return this.replay(replay, hash);
      throw new HttpError(409, 'DOCUMENTO_YA_RADICADO', 'Esta preparación ya está asociada a una emisión');
    }
    const recordId = record._id;
    try {
      let counter;
      try {
        counter = await this.models.Counter.findOneAndUpdate({ _id: seriesKey }, { $inc: { value: 1 } }, { upsert: true, new: true }).lean();
      } catch (error) {
        // Carrera del primer upsert: el índice _id impide crear dos contadores.
        if (error.code !== 11000) throw error;
        counter = await this.models.Counter.findOneAndUpdate({ _id: seriesKey }, { $inc: { value: 1 } }, { new: true }).lean();
      }
      const numero = counter.value;
      const consecutivo = formatNumber(year, numero);
      record = await this.models.Record.findByIdAndUpdate(record._id, { $set: { numero, anio: year, consecutivo } }, { new: true });
      const finalPdf = await stampPdf(pdfBytes, this.config, {
        id: record._id, consecutivo, ubicaciones, franjasMembrete,
        metadata: { referencia: data.referencia, empresaNombre: company.nombre, fechaEmision: data.fechaEmision, emitidoEn: this.clock() },
      });
      const base = `${this.config.prefix}/emitidos/${company._id}/${year}/${record._id}`;
      const ext = path.extname(prepared.original.nombre).toLowerCase();
      const original = await this.storage.put(`${base}/original${ext}`, originalBytes, prepared.original.mime, prepared.original.nombre);
      const pdf = await this.storage.put(`${base}/${consecutivo}.pdf`, finalPdf, 'application/pdf', `${consecutivo}.pdf`);
      record = await this.models.Record.findOneAndUpdate({ _id: record._id, estado: 'processing' }, {
        $set: { estado: 'issued', original, pdf }, $push: { historial: event('emitido', actor) },
      }, { new: true });
      if (!record) throw new Error('No se pudo confirmar la emisión');
      return { record: this.publicRecord(record), replayed: false };
    } catch (error) {
      // No se elimina evidencia ni se recicla el número. Un fallo de confirmación
      // no puede transformar un registro ya emitido en fallido.
      const markedFailed = await this.models.Record.updateOne({ _id: recordId, estado: 'processing' }, {
        $set: { estado: 'failed', error: { code: error.code || 'EMISION_FALLIDA', message: 'No se completó la emisión' } },
        $push: { historial: event('emision_fallida', actor, 'No se completó el procesamiento o almacenamiento') },
      }).catch(() => null);
      error.details = { ...error.details, id: recordId, ...(markedFailed?.modifiedCount === 1 ? { emisionFallida: true } : {}) };
      throw error;
    }
  }
  async readable(id, actor) {
    const record = await this.models.Record.findById(id).lean();
    if (!record) throw new HttpError(404, 'RADICADO_NO_ENCONTRADO', 'Radicado no encontrado');
    if (actor.admin) return record;
    if (record.actor.id_personal === actor.id_personal) return record;
    if (canReadAll(actor)) {
      const company = await this.models.Company.findById(record.empresa.id).lean();
      if (company && companyAllowed(company, actor)) return record;
    }
    throw new HttpError(404, 'RADICADO_NO_ENCONTRADO', 'Radicado no encontrado');
  }
  async get(id, actor) { return this.publicRecord(await this.readable(id, actor)); }
  async list(filters, actor) {
    const query = {};
    if (filters.mios === true) {
      query['actor.id_personal'] = actor.id_personal;
    } else if (!actor.admin) {
      const companies = canReadAll(actor) ? await this.models.Company.find({ usuariosPermitidos: actor.id }).distinct('_id') : [];
      query.$or = [{ 'actor.id_personal': actor.id_personal }, { 'empresa.id': { $in: companies } }];
    }
    if (filters.empresaId) query['empresa.id'] = filters.empresaId;
    if (filters.estado) query.estado = filters.estado;
    if (filters.buscar) {
      const literal = filters.buscar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$and = [{ $or: ['consecutivo', 'referencia', 'destinatario', 'responsable.nombre'].map(key => ({ [key]: { $regex: literal, $options: 'i' } })) }];
    }
    const [items, total] = await Promise.all([
      this.models.Record.find(query).sort({ createdAt: -1, _id: -1 }).skip((filters.pagina - 1) * filters.limite).limit(filters.limite).lean(),
      this.models.Record.countDocuments(query),
    ]);
    return { items: items.map(doc => this.publicRecord(doc)), total, pagina: filters.pagina, limite: filters.limite };
  }
  async download(id, actor, which = 'pdf') {
    const record = await this.readable(id, actor);
    if (!['issued', 'cancelled'].includes(record.estado) || !record[which]) throw new HttpError(409, 'PDF_NO_DISPONIBLE', 'El documento todavía no está disponible');
    return { bytes: await this.readStored(record[which]), nombre: record[which].nombre, mime: record[which].mime };
  }
  async cancel(id, motivo, actor) {
    await this.readable(id, actor);
    const record = await this.models.Record.findOneAndUpdate({ _id: id, estado: 'issued' }, {
      $set: { estado: 'cancelled' }, $push: { historial: event('anulado', actor, motivo) },
    }, { new: true }).lean();
    if (!record) throw new HttpError(409, 'ESTADO_INVALIDO', 'Solo se puede anular un radicado emitido');
    return this.publicRecord(record);
  }
  async verify(file, actor) {
    if (!file) throw new HttpError(400, 'ARCHIVO_REQUERIDO', 'Adjunta el PDF en el campo documento');
    const result = await recognizePdf(file.buffer, this.config);
    const digest = sha256(file.buffer);
    const ids = [...new Set(result.marcas.map(m => m.id))];
    // Si se quitó la imagen pero los bytes son idénticos, la huella aún permite identificarlo.
    const exact = await this.models.Record.findOne({ 'pdf.sha256': digest }).lean();
    if (exact && !ids.includes(exact._id)) ids.push(exact._id);
    const records = [];
    for (const id of ids.slice(0, this.config.MAX_PAGES)) {
      let record;
      try { record = await this.readable(id, actor); }
      catch (error) { if (error.status === 404) continue; throw error; }
      const marks = result.marcas.filter(m => m.id === id);
      records.push({
        id, consecutivo: record.consecutivo, estado: record.estado,
        esMio: record.actor.id_personal === actor.id_personal,
        referencia: record.referencia, empresa: record.empresa, fechaEmision: record.fechaEmision,
        emitidoPor: record.actor.name,
        marcaReconocida: marks.length > 0,
        archivoExacto: record.pdf?.sha256 === digest,
        paginas: marks.map(m => ({ encontrada: m.paginaEncontrada, codificada: m.paginaCodificada })),
      });
    }
    return { sha256: digest, reconocido: records.length > 0, resultados: records,
      alcance: 'PDF digital. La marca identifica un registro; solo archivoExacto confirma igualdad de bytes. Una marca ausente no demuestra falsificación.' };
  }
}
module.exports = { RadicadoService };
