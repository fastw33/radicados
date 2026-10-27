# Radicados Genika — API independiente

Backend de correspondencia en Node.js, Express y MongoDB. Usa una base independiente `radicados` y un bucket propio `radicados` en el servidor S3/MinIO, con el prefijo `radicados/`. No depende de la API de Leads ni incluye frontend. Acepta PDF y DOCX, permite revisar el PDF antes de emitir, aplica el consecutivo en las coordenadas elegidas y conserva original y PDF definitivo.

## Arquitectura por capas

Sigue la organización de `wmsBack`, con módulos y archivos `.model.js`, `.service.js`, `.controller.js`, `.routes.js` y `.validator.js`. Mongoose proporciona el mapeo de objetos y modelos para MongoDB (ODM); en WMS esa función la cumple Sequelize para SQL. Radicados conserva MongoDB y las colecciones e índices existentes.

```text
src/
  app.js                         # Express, middlewares globales y montaje de rutas
  server.js                      # Inicio HTTP, composición de dependencias y cierre
  config/
    env.js                       # Validación de variables de entorno
    db.js                        # Conexión Mongoose y creación aditiva de índices
  middlewares/                   # JWT, permisos, validación, cargas, capacidad y errores
  modules/radicados/
    radicado.routes.js           # Endpoints y cadena de middlewares
    radicado.controller.js       # Entrada/salida HTTP y descarga de archivos
    radicado.service.js          # Emisión, preparación, consulta y verificación
    radicado.validator.js        # Contratos y validación de datos
    radicado.model.js            # Modelo documental y sus índices
    empresa.model.js             # Catálogo y restricciones de empresa
    preparacion.model.js         # Original y vista previa
    contador.model.js            # Consecutivo anual atómico
    radicado.schemas.js          # Subdocumentos compartidos
    radicado.constants.js        # Empresas iniciales y franjas del membrete
    radicado.numbering.js        # Formato DG y año de Colombia
    index.js                     # Registro de modelos por conexión
  integrations/
    s3/s3.storage.js             # Acceso al almacenamiento
    office/                      # Conversión Word y motor persistente UNO
    pdf/                         # Procesamiento, estampado y reconocimiento
  utils/                         # Errores HTTP, respuestas de archivo y reglas de acceso
```

El flujo de una solicitud es `app → routes → validación/permisos → controller → service → model/integrations`. Los controllers no consultan MongoDB directamente y los services reciben datos y el actor autenticado, sin depender de `req` o `res`. La conexión y los servicios se inyectan al crear la aplicación para permitir pruebas con Mongo temporal y almacenamiento aislado.

`app.js` no abre puertos ni conexiones al importarlo. `server.js` usa `config/db.js`, construye las integraciones y el servicio, prepara el conversor, inicia HTTP y registra el cierre de recursos. La API pública continúa bajo `/api/v1` con el mismo contrato para FrontWms.

## Ejecutar

La preparación para `https://radicados.appfastway.com`, los entornos y la revisión de secretos están en [Despliegue](docs/DESPLIEGUE.md). El archivo privado `.env.production` se carga con `npm run start:production`; el arranque de desarrollo conserva `.env`.

Requiere Node.js 22 o 24, MongoDB y acceso al S3 existente. Para DOCX necesita LibreOffice Writer y su integración Python UNO. En Windows se utiliza el `python.exe` incluido con LibreOffice; en Linux, `/usr/bin/python3` con `python3-uno`. El Dockerfile incluye estas dependencias y fuentes básicas.

```powershell
npm ci
npm run config:genika
npm start
```

`config:genika` crea `.env` local reutilizando el servidor y credenciales Mongo/S3 del backend de Leads y el secreto de validación JWT de wmsBack, desde la carpeta vecina `Sistemas Genika`. Cambia la base de la URI a `radicados`, fija `MONGO_DB_NAME=radicados` y selecciona el bucket propio `radicados`. Genera una clave propia de marcas y usa puerto 3010. No modifica las otras APIs, no imprime secretos y no contacta los servicios. Si `.env` ya existe, se detiene sin sobrescribirlo. Para otras rutas:

```powershell
node scripts/configure-genika.js --leads "C:/ruta/leads/.env" --identity "C:/ruta/wmsBack/.env"
```

Copiar la configuración no comprueba que S3 esté disponible. Si `S3_ENDPOINT` apunta a `http://127.0.0.1:9000`, debe existir un servicio compatible con S3 escuchando allí; es una configuración local, no una conexión automática a AWS. El proceso de inicio no crea ese servicio ni su bucket. Si se usa AWS S3, configura el bucket, región y credenciales reales y deja `S3_ENDPOINT` vacío, salvo que la infraestructura requiera otro endpoint. No sustituyas un almacenamiento por otro sin identificar el que usa Genika.

También puedes copiar `.env.example` a `.env` y configurarlo. Conserva y respalda `MARK_SECRET`: cambiarlo impide reconocer las marcas antiguas. Las credenciales S3 se resuelven con la cadena estándar del SDK de AWS; se pueden usar roles en lugar de claves estáticas. No colocar credenciales en el frontend.

En Windows configura `LIBREOFFICE_PATH` con la ruta del ejecutable de LibreOffice; para uso por consola se prefiere `soffice.com`.

En este equipo se dejó una distribución local de LibreOffice en `.runtime/libreoffice/`, extraída del instalador oficial verificado, y `.env` apunta a `.runtime/libreoffice/program/soffice.com` mediante una ruta absoluta. No requiere registrar una instalación de escritorio. Conserva esa carpeta mientras uses esta configuración: `.runtime/` no forma parte del código versionado. Si cambias `LIBREOFFICE_PATH`, detén y vuelve a iniciar la API para que vuelva a leer `.env`.

`CONVERSION_MODE=persistent` es el modo predeterminado: la API prepara un motor de Writer al arrancar y lo reutiliza por un pipe local privado, sin abrir un puerto UNO. El primer arranque tiene un costo de inicialización; el log `Conversor de Word preparado` confirma que terminó. Los trabajos se procesan en serie, con cola acotada, tiempo máximo, cierre de cada documento y renovación del motor tras 100 conversiones. El proceso y sus hijos se cierran con la API. `LIBREOFFICE_PYTHON` permite indicar otro intérprete con UNO; `CONVERSION_MODE=process` conserva el arranque aislado por archivo si se necesita compatibilidad con ese despliegue.

Las preparaciones Word guardan original y PDF en paralelo. Si una carga falla, se espera la otra y se limpian los objetos creados antes de responder. Para archivos que ya son PDF se guarda una única copia durante la preparación, compartida como original y vista previa. Los archivos emitidos se conservan como antes.

Para iniciar con el Node 24 incluido en este equipo, sin cambiar el Node global:

```powershell
& "$env:USERPROFILE/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe" --env-file=.env src/server.js
```

Inicio con Docker:

```sh
docker build -t genika-radicados .
docker run --rm --env-file .env -e HOST=0.0.0.0 -p 3010:3010 genika-radicados
```

La conexión Mongo debe ser accesible desde el contenedor. En Docker se utiliza `/usr/bin/soffice` (si `.env` contiene una ruta Windows, añadir `-e LIBREOFFICE_PATH=/usr/bin/soffice` al comando). Usar HTTPS a través del proxy existente en producción. `CORS_ORIGINS` admite orígenes separados por coma. Configurar el límite de cuerpo del proxy por encima de `MAX_FILE_MB`. Si se coloca detrás de un proxy, definir y revisar explícitamente la confianza en ese proxy antes de habilitar `trust proxy`; no se confía por defecto en cabeceras reenviadas.

## Identidad y permisos

Cada llamada `/api/v1` requiere `Authorization: Bearer <JWT de Genika>`. Se valida HS256, vencimiento y `id_usuario` (o `sub`) y `id_personal` (en la raíz o en `personal.id_personal`), sin llamar a otras APIs. La propiedad de preparaciones, emisiones, historial e idempotencia se basa en `id_personal` firmado; `id_usuario` se conserva únicamente como dato de auditoría de la cuenta. No hay bypass de desarrollo ni usuarios de prueba. Un usuario que deba cambiar contraseña no tiene acceso. Puedes exigir `JWT_ISSUER` y `JWT_AUDIENCE` si la identidad los emite.

| Permiso en `permisos` del JWT | Acceso |
| --- | --- |
| `esAdmin` o `radicadosAdministrar` | Administrar empresas, emitir, consultar todos y anular |
| `radicadosEmitir` | Preparar y emitir para empresas que autoricen su id_personal; leer documentos propios |
| `radicadosConsultar` | Consultar y verificar documentos propios |
| `radicadosConsultarTodos` | Leer también documentos de las empresas que autoricen su id_personal |

Fastway (`fastway`), Harvest (`harvest`) y Greenway (`greenway`) están disponibles con permiso de emisión, sin configurar catálogos ni crear documentos de empresa automáticamente en Mongo. El formulario no solicita área emisora. `areaNombre` y `areaId` siguen disponibles como campos opcionales para integraciones anteriores; se puede emitir sin ninguno. El nombre del responsable es editable y la persona que emite queda identificada por el `id_personal` firmado de su sesión.

Las empresas se administran con `PUT /api/v1/empresas/:id`; incluyen nombre, código de empresa (`prefijo`), áreas, franjas del membrete y `usuariosPermitidos` (valores de id_personal, no de id_usuario). Una configuración explícita también prevalece sobre las tres empresas iniciales, conservando las restricciones y el estado que establezca el administrador. El código de empresa es único e inmutable, pero no determina el radicado: todos usan la serie documental DG. Los cambios de permisos en Genika se reflejan en un JWT nuevo; no se implementa revocación inmediata de tokens desde esta API.

## Flujo para el futuro frontend

1. `GET /api/v1/empresas`: obtener empresas y áreas autorizadas.
2. `POST /api/v1/preparaciones`: enviar **solo un archivo**, campo multipart `documento`.
3. La respuesta devuelve `id`, vencimiento, dimensiones/rotación de páginas y URL de vista previa. Descargarla con el mismo Bearer y mostrarla usando un blob en el navegador. El usuario selecciona allí el rectángulo para el radicado.
4. `POST /api/v1/radicados`: enviar JSON con los datos y las coordenadas; incluir `Idempotency-Key` único para esa emisión. Reintentar exactamente la misma solicitud con la misma clave. Si el usuario modifica los datos después de un error, emplear una clave nueva según el estado retornado.
5. El backend asigna el consecutivo, marca el PDF, conserva original y resultado en S3, registra sus huellas y devuelve el registro. Descargar usando su enlace `descarga`. Usar `?respuesta=pdf` en la emisión si se quiere recibir directamente el binario; id y consecutivo llegan en encabezados.

**Nunca se emite sin coordenadas.** El frontend no convierte ni marca documentos ni decide el número. La selección se realiza sobre el PDF convertido por esta API; no sobre la representación local del Word, que puede paginar diferente. La misma preparación es inmutable, pertenece a quien la cargó y solo puede originar una emisión.

El frontend integrado está en `Sistemas Genika/FrontWms`, ruta `/radicaciones`. Consulta siempre `/radicados?mios=true` para el listado personal, incluso con sesión de administrador. El servidor aplica el filtro con el `id_personal` del JWT y rechaza parámetros de identidad enviados por el navegador. Los registros antiguos sin `actor.id_personal` no se atribuyen automáticamente por coincidencia de números con `id_usuario`; requieren una asociación administrativa validada.

El destinatario es opcional: puede omitirse o enviarse vacío. El formulario permite completar los datos mientras se procesa el archivo. La pestaña `Validar PDF` permite comprobar propiedad, coincidencia exacta del archivo, reconocimiento de la marca y estado del registro sin crear otro radicado ni guardar el archivo cargado.

Contrato detallado, ejemplos y errores: [docs/API.md](docs/API.md). Solicitudes reutilizables: [docs/solicitudes.http](docs/solicitudes.http).

## Coordenadas

Usamos el rectángulo visible de la página (CropBox), con su rotación aplicada. Origen superior izquierdo y coordenadas relativas de 0 a 1. Número de página comienza en 1.

```json
{
  "pagina": 1,
  "zona": "encabezado",
  "x": 0.43,
  "y": 0.075,
  "ancho": 0.28,
  "alto": 0.025,
  "tamanoFuente": 9
}
```

Si el usuario dibuja en píxeles sobre una página de `W × H`, calcular `x=izquierda/W`, `y=arriba/H`, `ancho=anchoSeleccion/W`, `alto=altoSeleccion/H`. Medir respecto a esa página, excluyendo bordes, controles y desplazamiento del contenedor; no aplicar el devicePixelRatio a coordenadas CSS. Rotaciones PDF de 0/90/180/270 y CropBox desplazados están soportadas. Las rotaciones temporales agregadas por el visor deben deshacerse antes de calcular la selección. Se rechazan UserUnit especiales y geometrías no admitidas.

La ubicación debe indicar `zona: "encabezado"` o `zona: "pie"` y quedar completamente dentro de la franja autorizada de ese membrete. Por defecto se reserva el 15% superior y el 15% inferior, y se rechaza el cuerpo con `FUERA_DEL_MEMBRETE`. Un administrador puede ajustar `franjasMembrete` de la empresa (entre 1% y 35% por franja). La selección manual debe evitar logos y datos existentes dentro de esa franja. Se envía exactamente una ubicación, con fuente entre 8 y 18 puntos, y el backend aplica la misma posición relativa y el mismo consecutivo a todas las páginas. La marca oculta también se aplica a todas. Se comprueba cada hoja antes de reservar número y se guarda cada ubicación en el registro. Se rechazan páginas inexistentes, selecciones fuera de límites y rectángulos donde el texto no cabe. No se coloca un fondo blanco ni se reduce automáticamente la fuente. La persona debe escoger un espacio libre: no se promete detección automática de contenido importante.

## Marca gráfica oculta y verificación

Al emitir se reemplazan los metadatos Info y XMP del PDF por datos de Genika: título con consecutivo y referencia, autor `Genika | empresa`, asunto, palabras clave, aplicación y generador `Genika`. Las fechas de creación/modificación corresponden al procesamiento de emisión; la fecha documental indicada en el formulario queda por separado en XMP. Se eliminan campos personalizados de Info y los XMP anteriores, incluidos los asociados a páginas. El original archivado se conserva intacto. La normalización ocurre antes de calcular el hash y guardar el PDF en S3; las marcas y la verificación siguen operando independientemente de los metadatos.

Cada página contiene dos patrones gráficos de micropuntos negros, de 36 × 36 puntos, a opacidad 4%. Cada punto mide 0,5 puntos; el fondo es transparente. Se busca que sean discretos a escala normal, no que sean físicamente imposibles de ver al ampliar o aumentar contraste.

El patrón codifica versión, UUID del radicado, número de página y un HMAC-SHA256 truncado a 128 bits. El detector lee los píxeles de esas imágenes gráficas invocadas en los flujos del PDF, incluyendo formularios XObject anidados. No depende del título, propiedades ni un logo fijo en los metadatos.

`POST /api/v1/verificaciones` recibe un PDF y devuelve por separado `marcaReconocida`, `archivoExacto` y `esMio` (comparado con el `id_personal` firmado). Solo revela datos de registros propios o autorizados. La huella SHA-256 registrada se calcula **después** de aplicar consecutivo y marcas. Una marca válida relaciona el patrón con un registro, pero puede ser copiada a contenido modificado. Solo `archivoExacto: true` indica igualdad de bytes con el PDF archivado. No es una firma digital con certificado. La ausencia de marca se reporta como no reconocido, nunca como prueba de falsificación.

**Alcance actual: PDF digital con los patrones gráficos conservados como imágenes Flate RGB.** Se probó guardar nuevamente el PDF y eliminar metadatos, así como envolverlo en otro PDF. Rasterizar páginas, convertir sus imágenes a JPEG, eliminar los puntos, imprimir, escanear o fotografiar puede impedir el reconocimiento. El detector no realiza OCR ni búsqueda visual en fotos o escaneos. Para extender ese alcance se necesita una fase específica de desarrollo y pruebas físicas. Un logo UV o tinta físicamente invisible exige materiales de impresión especiales.

## Persistencia y fallos

La base independiente `radicados` contiene las colecciones `radicados`, `radicados_contadores`, `radicados_preparaciones` y `radicados_empresas`. `MONGO_DB_NAME` selecciona explícitamente esta base y prevalece sobre el nombre que figure en `MONGO_URI`; su valor predeterminado es `radicados`. Se usan índices únicos para idempotencia, preparación y consecutivo. El servidor crea estas colecciones e índices al iniciar sin borrar índices existentes; la primera puesta en marcha necesita permiso Mongo para crearlos en la nueva base. La API no crea buckets: preparar el bucket `radicados` en MinIO/S3 antes de emitir.

La serie es `DG-AÑO-NÚMERO`, compartida entre todas las empresas, con mínimo tres dígitos: `DG-2026-001`, `DG-2026-002`. El contador reinicia en `001` al comenzar cada año según `America/Bogota`: `DG-2027-001`. Después de `999` continúa con `1000`, sin truncar ni reutilizar números. La fecha documental indicada por el usuario se conserva por separado. La asignación usa `$inc` atómico y no requiere Mongo en replica set. Si falla después de reservar número, el registro queda `failed` con historial y **el número no se reutiliza**; pueden existir saltos auditables. El registro no se reemplaza ni se borra. Un radicado emitido se puede anular con motivo; se conserva su PDF original emitido y la consulta muestra `cancelled`.

Las preparaciones vencen tras 24 horas (configurable). En S3 quedan en `radicados/preparaciones/`. Los archivos definitivos se copian a `radicados/emitidos/EMPRESA/AÑO/UUID/`. Configurar una regla de ciclo de vida para **solo** el prefijo `radicados/preparaciones/` con retención mayor a `PREVIEW_HOURS` (por ejemplo siete días), y una tarea de retención Mongo para las preparaciones vencidas según la política de la empresa. Esta API no cambia la política del bucket ni elimina documentos emitidos. No se configura TTL automático porque se conserva la evidencia y la política debe acordarse.

S3 y Mongo no forman una transacción distribuida. Un cierre abrupto puede dejar una emisión en `processing` o archivos parciales. Revisar registros antiguos en ese estado, sus objetos S3 y los logs por requestId; recuperar o marcar como fallidos de forma administrativa, sin bajar el contador ni reutilizar números. El mismo `Idempotency-Key` devuelve conflicto mientras una emisión está procesándose. No lanzar una segunda emisión automáticamente ante un timeout: consultar el id o reintentar la misma clave.

Los PDF firmados digitalmente se rechazan para no invalidar su firma: radicar primero y firmar después. Si se firma posteriormente, el archivo ya no será idéntico por SHA-256, aunque puede conservar su marca. Esta versión no incorpora un flujo de firma posterior. Se rechazan PDF cifrados, acciones activas y DOCX con macros/objetos incrustados. Los recursos externos de Word, como imágenes o plantillas remotas, deben incrustarse antes de cargar; los hipervínculos se permiten. La conversión Word puede variar según las fuentes instaladas; revisar la vista previa antes de emitir.

El procesamiento de PDF se ejecuta en workers con cola acotada, tiempo máximo de 30 segundos por operación y límite de memoria de JavaScript. La lectura de marcas limita la expansión de flujos comprimidos; no bloquea el hilo HTTP con el parsing del archivo. La API admite hasta cuatro operaciones pesadas HTTP simultáneas y procesa hasta tres operaciones PDF a la vez.

## Pruebas

```sh
npm run check
npm test
npm run qa:pdf
```

Las pruebas usan MongoDB temporal aislado y un adaptador S3 en memoria; no cargan `.env`, no escriben en el bucket real y no usan cuentas reales. La primera ejecución de `mongodb-memory-server` puede descargar un binario MongoDB. Cubren concurrencia, idempotencia, permisos, fallos S3, conservación del original, conversión simulada, límites geométricos, CropBox/rotaciones, recuperación de marcas y distinción entre reconocimiento e integridad.

`qa:pdf` genera una muestra de cuatro rotaciones en `.runtime/pdf-qa` para renderizar e inspeccionar. Las pruebas del conversor verifican argumentos, aislamiento, errores y limpieza. La conversión con LibreOffice real requiere instalarlo o construir el contenedor; no se presenta una simulación como prueba de conversión real.

`GET /health` comprueba el proceso; `GET /ready` comprueba la conexión Mongo. No comprueban credenciales S3 ni la instalación de LibreOffice. Respaldar MongoDB, los objetos S3 y `MARK_SECRET` según la política del Ecosistema.

`ALMACENAMIENTO_NO_DISPONIBLE` (HTTP 503) indica un fallo de conexión o resolución DNS al almacenamiento. El log identifica `servicio: S3`, la operación y la causa, por ejemplo `ECONNREFUSED`. Comprueba primero que el endpoint configurado esté activo; volver a instalar el conversor de Word no resuelve un fallo de almacenamiento.
