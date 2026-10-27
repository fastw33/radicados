'use strict';

const { z } = require('zod');
const { DEFAULT_BANDS } = require('./radicado.constants');
const name = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const emptyToUndefined = value => typeof value === 'string' && !value.trim() ? undefined : value;
const area = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/), nombre: name }).strict();
const bandsSchema = z.object({
  encabezado: z.number().min(0.01).max(0.35),
  pie: z.number().min(0.01).max(0.35),
}).strict();
const companySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/),
  nombre: name,
  prefijo: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  franjasMembrete: bandsSchema.default(DEFAULT_BANDS),
  areas: z.array(area).min(1).max(100).refine(a => new Set(a.map(x => x.id)).size === a.length, 'Áreas repetidas'),
  // Se conservó el nombre del campo del catálogo; sus valores son id_personal.
  usuariosPermitidos: z.array(z.string().trim().min(1).max(100)).max(1000).default([]),
  activo: z.boolean().default(true),
}).strict();
const placementSchema = z.object({
  pagina: z.number().int().min(1),
  zona: z.enum(['encabezado', 'pie']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  ancho: z.number().gt(0).max(1),
  alto: z.number().gt(0).max(1),
  tamanoFuente: z.number().min(8).max(18).default(10),
}).strict().superRefine((v, ctx) => {
  if (v.x + v.ancho > 1.00000001 || v.y + v.alto > 1.00000001)
    ctx.addIssue({ code: 'custom', message: 'El rectángulo sale de la página' });
});
const issueSchema = z.object({
  preparacionId: uuid,
  empresaId: companySchema.shape.id,
  areaId: z.preprocess(emptyToUndefined, area.shape.id.optional()),
  areaNombre: z.preprocess(emptyToUndefined, name.optional()),
  referencia: name,
  responsable: z.object({ nombre: name, id: z.string().trim().min(1).max(100).optional() }).strict(),
  destinatario: z.string().trim().max(500).default(''),
  fechaEmision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === v;
  }, 'Fecha inexistente'),
  ubicaciones: z.array(placementSchema).length(1, 'Selecciona una ubicación; se aplicará a todas las páginas'),
}).strict().refine(value => !(value.areaId && value.areaNombre), {
  path: ['areaNombre'], message: 'Indica solo un área del catálogo o un nombre de área',
});
const listSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(25),
  empresaId: companySchema.shape.id.optional(),
  estado: z.enum(['processing', 'issued', 'failed', 'cancelled']).optional(),
  buscar: z.string().trim().max(120).optional(),
  mios: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
}).strict();
const idParamsSchema = z.object({ id: uuid }).strict();
const idempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const cancellationSchema = z.object({ motivo: z.string().trim().min(5).max(1000) }).strict();
module.exports = { companySchema, issueSchema, placementSchema, listSchema, uuid, DEFAULT_BANDS, idParamsSchema, idempotencyKeySchema, cancellationSchema };
