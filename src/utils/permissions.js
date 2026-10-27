'use strict';

function canReadAll(actor) { return actor.admin || actor.permissions.radicadosConsultarTodos === true; }
function companyAllowed(company, actor) { return actor.admin || company.usuariosPermitidos.includes(actor.id); }

module.exports = { canReadAll, companyAllowed };
