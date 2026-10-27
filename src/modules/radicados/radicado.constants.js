'use strict';

const DEFAULT_BANDS = { encabezado: 0.15, pie: 0.15 };

const ISSUING_COMPANIES = [
  { _id: 'fastway', nombre: 'Fastway', prefijo: 'FW' },
  { _id: 'harvest', nombre: 'Harvest', prefijo: 'HV' },
  { _id: 'greenway', nombre: 'Greenway', prefijo: 'GW' },
].map(company => ({ ...company, activo: true, areas: [], franjasMembrete: DEFAULT_BANDS }));

module.exports = { DEFAULT_BANDS, ISSUING_COMPANIES };
