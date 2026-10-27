# Contrato HTTP de Radicados

Base local: `http://127.0.0.1:3010/api/v1`. Autenticación: `Authorization: Bearer <token Genika>`. Errores en JSON; archivos en binario. Los UUID e ids de ejemplo deben reemplazarse con los devueltos por la API. Todos los datos comerciales del ejemplo son ilustrativos.

## 1. Registrar empresa y áreas

Fastway (`fastway`), Harvest (`harvest`) y Greenway (`greenway`) están disponibles para usuarios con permiso de emisión sin registrar previamente un catálogo. Se puede escribir el área mediante `areaNombre`. Si un administrador configura explícitamente una de esas empresas, se respetan su estado, sus franjas y sus usuarios autorizados.

`PUT /empresas/mi-empresa` — requiere administración. Repetir para actualizar áreas o usuarios autorizados. El código de empresa (`prefijo`) es único e inmutable. La numeración documental es global: `DG-2026-001`, `DG-2026-002`; en 2027 comienza `DG-2027-001`.

```json
{
  "id": "mi-empresa",
  "nombre": "Nombre real de la empresa",
  "prefijo": "GEN",
  "activo": true,
  "franjasMembrete": { "encabezado": 0.15, "pie": 0.15 },
  "areas": [{ "id": "administracion", "nombre": "Administración" }],
  "usuariosPermitidos": ["123", "456"]
}
```

`GET /empresas` devuelve `{ "items": [...] }` con las empresas permitidas. Un administrador puede ver también las inactivas.

## 2. Preparar documento

`POST /preparaciones` — permiso de emisión. `multipart/form-data`, un único campo de archivo `documento`, sin otros campos multipart. Acepta `.pdf` y `.docx`. No se admiten `.doc` antiguos.

```sh
curl -X POST http://127.0.0.1:3010/api/v1/preparaciones \
  -H "Authorization: Bearer TOKEN" \
  -F "documento=@carta.docx"
```

Respuesta `201`:

```json
{
  "id": "368b3a35-2d83-4847-847e-5c4c5cdb3192",
  "expiresAt": "2026-10-27T20:00:00.000Z",
  "paginas": [
    { "pagina": 1, "anchoPt": 612, "altoPt": 792, "rotacion": 0 }
  ],
  "vistaPrevia": "/api/v1/preparaciones/368b3a35-2d83-4847-847e-5c4c5cdb3192/pdf",
  "coordenadas": {
    "origen": "superior-izquierdo",
    "unidad": "relativa",
    "rango": [0, 1],
    "referencia": "CropBox visible con rotación aplicada"
  }
}
```

`GET /preparaciones/:id/pdf` devuelve el PDF listo para mostrar al usuario, con autenticación del propietario y `Content-Disposition: inline`. No es un enlace público de S3. El cliente debe obtenerlo mediante fetch con Bearer y crear un blob local. Usar el `vistaPrevia` relativo contra el origen de esta API.

## 3. Emitir

`POST /radicados` — JSON, permiso de emisión y encabezado `Idempotency-Key` (8 a 100 caracteres alfanuméricos, `_` y `-`; se recomienda UUID).

```json
{
  "preparacionId": "368b3a35-2d83-4847-847e-5c4c5cdb3192",
  "empresaId": "fastway",
  "areaNombre": "Dirección de Operaciones",
  "referencia": "Carta de presentación",
  "responsable": { "id": "123", "nombre": "Nombre del responsable" },
  "destinatario": "Nombre del destinatario",
  "fechaEmision": "2026-10-26",
  "ubicaciones": [
    { "pagina": 1, "zona": "encabezado", "x": 0.43, "y": 0.075, "ancho": 0.28, "alto": 0.025, "tamanoFuente": 9 }
  ]
}
```

El área emisora es opcional y ya no se solicita en el formulario. Para integraciones anteriores se aceptan `areaNombre` o `areaId`, como máximo uno de los dos; los valores vacíos se omiten. Si se envía `areaId`, debe pertenecer al catálogo de la empresa. `responsable.nombre` es editable y obligatorio; su `id` es opcional. El actor real se obtiene del JWT y queda registrado por separado, con el `id_personal` de quien emite. El usuario no puede enviar un consecutivo ni una ruta S3.

`destinatario` es opcional: se puede omitir o enviar vacío y se conserva como `""`. Si se completa, admite hasta 500 caracteres. No bloquea la emisión cuando no corresponde indicar una persona o empresa de destino.

`ubicaciones` es obligatorio y contiene exactamente un rectángulo, seleccionado en cualquiera de las páginas existentes. El backend repite esa posición relativa y el mismo consecutivo en todas las páginas, y guarda en el registro las ubicaciones expandidas. El rectángulo exige `zona` igual a `encabezado` o `pie`. Debe caber completo en la franja del membrete autorizada por la empresa: 15% superior o inferior por defecto; se puede configurar `franjasMembrete` entre 0.01 y 0.35 por zona. El cuerpo se rechaza con `FUERA_DEL_MEMBRETE`. Las medidas son relativas a cada página visible, no al archivo Word. `tamanoFuente` es opcional y vale 10 por defecto. Se soportan de 8 a 18 puntos. Las coordenadas no pueden salir de la página y el texto debe caber con cuatro puntos de margen total. Se comprueban todas las hojas, incluso con tamaños o rotaciones diferentes, usando el siguiente número esperado; si alguna no permite colocar el texto, devuelve `422 RADICADO_NO_CABE` con la página que falla antes de reservar número. La emisión vuelve a validar el código definitivo. Si otra solicitud cruza simultáneamente un cambio de dígitos y el código más largo deja de caber, el intento queda fallido con su número reservado, sin superponer texto ni reutilizar el número.

Respuesta `201` en primera emisión; `200` en repetición de la misma clave y datos:

```json
{
  "id": "69b5c0da-6393-4ef1-a434-f44fe1feb2ed",
  "consecutivo": "DG-2026-001",
  "numero": 1,
  "anio": 2026,
  "estado": "issued",
  "referencia": "Carta de presentación",
  "empresa": { "id": "fastway", "nombre": "Fastway", "prefijo": "FW" },
  "area": { "nombre": "Dirección de Operaciones" },
  "responsable": { "id": "123", "nombre": "Nombre del responsable" },
  "destinatario": "Nombre del destinatario",
  "fechaEmision": "2026-10-26",
  "actor": { "id": "123", "id_personal": "123", "id_usuario": "7", "name": "Usuario autenticado" },
  "pdf": { "nombre": "DG-2026-001.pdf", "mime": "application/pdf", "bytes": 12345, "sha256": "HUELLA_HEXADECIMAL" },
  "descarga": "/api/v1/radicados/69b5c0da-6393-4ef1-a434-f44fe1feb2ed/pdf",
  "repetido": false
}
```

Además incluye `original`, `ubicaciones`, `historial`, `createdAt` y `updatedAt`. No expone claves del bucket, credenciales ni clave de idempotencia. El esquema exacto de datos reales puede consultarse con `GET /radicados/:id`.

**Respuesta binaria:** `POST /radicados?respuesta=pdf` devuelve el PDF como cuerpo y mantiene los códigos `201/200`. Encabezados `X-Radicado-Id`, `X-Radicado-Consecutivo` y `Location` identifican el registro. Ante fallo de descarga posterior a confirmar la emisión, repetir la misma clave recupera el mismo radicado.

## 4. Consulta y descarga

| Método y ruta | Resultado |
| --- | --- |
| `GET /radicados` | `{items,total,pagina,limite}` |
| `GET /radicados/:id` | Registro y trazabilidad |
| `GET /radicados/:id/pdf` | PDF emitido como archivo adjunto |
| `GET /radicados/:id/pdf?vista=inline` | Mismo archivo para visualización |
| `GET /radicados/:id/original` | Archivo original, sin modificar |

Para el listado personal usar `mios=true`; se aplica al `id_personal` firmado incluso si la persona es administradora. No enviar id_personal ni id_usuario como parámetros: los filtros desconocidos se rechazan. `usuariosPermitidos` en empresas contiene id_personal.

Filtros de listado: `mios` (`true`/`false`), `pagina` (1), `limite` (25, máximo 100), `empresaId`, `estado` (`processing`, `issued`, `failed`, `cancelled`), `buscar` (texto literal sobre consecutivo, referencia, destinatario o responsable). Ejemplo: `/radicados?empresaId=mi-empresa&buscar=carta&pagina=1&limite=25`.

No hay borrado ni sustitución de archivos emitidos. Para una corrección se anula el anterior y se prepara una nueva emisión. La descarga compara la huella con el registro antes de entregar los bytes. El historial de `emitido` acredita emisión por el sistema, no envío ni recepción por el destinatario.

## 5. Anular

`POST /radicados/:id/anulaciones` — administración:

```json
{ "motivo": "Documento reemplazado por corrección de contenido" }
```

Motivo de 5 a 1000 caracteres. Solo un radicado `issued` pasa a `cancelled`. El archivo original emitido no se vuelve a escribir: su estado vigente se consulta en la API, no mediante un cambio retroactivo del PDF.

## 6. Reconocer y verificar

`POST /verificaciones` — permiso de consulta o emisión. Multipart con el único campo `documento` que contiene un PDF.

```json
{
  "sha256": "HUELLA_HEXADECIMAL",
  "reconocido": true,
  "resultados": [
    {
      "id": "69b5c0da-6393-4ef1-a434-f44fe1feb2ed",
      "consecutivo": "DG-2026-001",
      "estado": "issued",
      "esMio": true,
      "referencia": "Carta de presentación",
      "empresa": { "id": "fastway", "nombre": "Fastway", "prefijo": "FW" },
      "fechaEmision": "2026-10-26",
      "emitidoPor": "Usuario autenticado",
      "marcaReconocida": true,
      "archivoExacto": true,
      "paginas": [{ "encontrada": 1, "codificada": 1 }]
    }
  ],
  "alcance": "PDF digital. La marca identifica un registro; solo archivoExacto confirma igualdad de bytes. Una marca ausente no demuestra falsificación."
}
```

Una marca conservada en un archivo modificado devuelve `marcaReconocida:true` y `archivoExacto:false`. Un PDF combinado puede contener marcas de varios radicados; el arreglo separa sus resultados. Las páginas encontradas/codificadas permiten advertir cambios de orden. Solo se muestran los registros autorizados para el usuario. No se intenta identificar a un usuario ajeno ni se publica la base de datos. Escaneos, fotografías e imágenes de página completa no están soportados por el detector actual.

## Errores

```json
{
  "error": {
    "codigo": "RADICADO_NO_CABE",
    "mensaje": "El radicado no cabe en el rectángulo seleccionado. Amplía el espacio o reduce la fuente",
    "detalles": { "pagina": 1, "texto": "DG-2026-9999999999", "anchoMinimoPt": 180, "altoMinimoPt": 14 }
  },
  "requestId": "UUID_DE_LA_SOLICITUD"
}
```

| HTTP | Códigos principales |
| --- | --- |
| 400 | `ARCHIVO_REQUERIDO`, límites multipart, JSON inválido |
| 401 | `SESION_INVALIDA` |
| 403 | `SIN_PERMISO`, `EMPRESA_NO_AUTORIZADA`, `CAMBIAR_PASSWORD`, `ORIGEN_NO_PERMITIDO` |
| 404 | Preparación/radicado inexistente o no accesible |
| 409 | `IDEMPOTENCIA_CONFLICTO`, `EMISION_EN_PROCESO`, `DOCUMENTO_YA_RADICADO`, `EMISION_FALLIDA`, `ESTADO_INVALIDO`, `PREFIJO_INMUTABLE` |
| 410 | `PREPARACION_VENCIDA` |
| 413 | Archivo o PDF convertido demasiado grande |
| 415 | `FORMATO_NO_ADMITIDO` |
| 422 | `DATOS_INVALIDOS`, `RADICADO_NO_CABE`, `FUERA_DEL_MEMBRETE`, `PAGINA_INEXISTENTE`, `PDF_INVALIDO`, `PDF_YA_FIRMADO`, `PDF_ACTIVO`, `DOCX_INVALIDO`, `CONVERSION_FALLIDA` |
| 429 | Límite de solicitudes por IP |
| 500 | Fallo de procesamiento o S3; consultar antes de emitir de nuevo |
| 502 | `OBJETO_ALTERADO`: contenido S3 distinto de su huella |
| 503 | `CAPACIDAD_OCUPADA`, `CONVERSOR_NO_DISPONIBLE`, `ALMACENAMIENTO_NO_DISPONIBLE`, base de datos no disponible |
| 504 | `CONVERSION_TIMEOUT` |

No cambiar automáticamente `Idempotency-Key` después de un error 500 o timeout. Consultar el estado o repetir primero la misma solicitud. Los errores `EMISION_EN_PROCESO` y `EMISION_FALLIDA` incluyen el id del registro en detalles. Para una nueva emisión después de `failed`, volver a preparar y emplear una clave nueva: la preparación anterior permanece asociada a la evidencia del intento.
