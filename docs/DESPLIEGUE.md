# Despliegue de Radicaciones

API pública: `https://radicados.appfastway.com`. FrontWms: `https://www.appfastway.com`.

## Entorno privado

`.env.production` conserva el JWT compartido con `wmsBack` y la clave de marcas existente. Usa la base independiente `radicados` y el bucket propio `radicados`, nombres confirmados para el módulo. Está excluido de Git y Docker. `.env.production.example` es la plantilla sin secretos que se puede versionar. El entorno local también apunta a la base y el bucket independientes.

Las rutas de LibreOffice son de Linux, iguales a las del Dockerfile. La configuración de Leads suministrada se usó como referencia del servidor y las credenciales: el nombre de la base en `MONGO_URI` se cambió a `radicados`, y `MONGO_DB_NAME=radicados` selecciona explícitamente esa base aunque una URI copiada conserve otro nombre. El módulo crea allí sus cuatro colecciones e índices al arrancar, materializando la nueva base Mongo si el usuario tiene permisos. No se copian variables de correo, API públicas ni integraciones exclusivas de Leads.

En el MinIO del VPS, crear el bucket privado `radicados` y permitir el acceso al usuario de la API. El entorno usa `S3_BUCKET=radicados` y `S3_PREFIX=radicados`. La API no crea automáticamente el bucket ni modifica las políticas de MinIO.

Las direcciones Mongo y MinIO son nombres internos de contenedores: ambos servicios deben ser accesibles desde la red Docker de esta aplicación en Coolify. Se validó el formato de configuración; no se comprobó conectividad con esos nombres internos desde este equipo. Dentro de un contenedor, `127.0.0.1` y `localhost` apuntan al propio contenedor. `S3_ENDPOINT` de MinIO apunta a su API S3 en 9000, no a la consola 9001. En AWS S3, dejar el endpoint vacío y `S3_FORCE_PATH_STYLE=false`.

Conservar `MARK_SECRET`: permite reconocer los documentos ya emitidos. Respaldar la clave junto con Mongo y los objetos S3; si se trasladan documentos existentes, conservar las colecciones, contadores y archivos actuales.

En este equipo se copiaron los nueve registros, diez preparaciones y el contador desde la base anterior a `radicados`, y 31 objetos al nuevo bucket local `radicados`; se verificaron sus hashes. El origen se conservó. El resumen está en `.runtime/migration-radicados/resumen.json`. Esta copia es local: no se ha ejecutado una migración ni creado recursos en el VPS. Para conservar esos documentos en el VPS, trasladar las colecciones y objetos del entorno local junto con la clave de marcas, antes de comenzar a emitir, para mantener la secuencia y la verificación.

## JWT de WMS

El código actual de WMS firma tokens HS256 con `JWT_SECRET` y vencimiento de 15 horas. Radicaciones verifica el mismo token: no crea otro login ni recibe nuevamente la contraseña. El front envía `Authorization: Bearer <token de WMS>`. La propiedad depende del `id_personal` firmado; `id_usuario` y los permisos también provienen del JWT.

Se comprobó que el secreto local de WMS coincide con Radicaciones. En el servidor debe coincidir **exactamente con el de WMS de producción**. Si producción utiliza otra clave, actualizar `JWT_SECRET` en el entorno privado de Radicaciones antes de arrancar. No generar una clave independiente ni incluirla en variables `VITE_*`.

WMS actualmente no emite `iss` ni `aud`; mantener `JWT_ISSUER` y `JWT_AUDIENCE` vacíos. Exigirlos solo en Radicaciones rechazaría las sesiones existentes.

## FrontWms y CORS

Agregar esta variable al entorno de compilación del front y conservar sus demás URLs de producción:

```dotenv
VITE_RADICADOS_API_URL=https://radicados.appfastway.com/api/v1
```

También está en `FrontWms/.env.production.example`, como fragmento del módulo. Compilar y desplegar el front después del cambio. El backend ya tiene `CORS_ORIGINS=https://www.appfastway.com`: origen exacto del navegador, sin ruta ni barra final.

## Arranque

Node 22 o 24 y LibreOffice Writer/Python UNO en Linux:

```sh
npm ci --omit=dev
npm run start:production
```

Para Docker, usar el Dockerfile incluido y cargar las variables de `.env.production` como variables privadas de la plataforma. No copiar el archivo dentro de la imagen. El contenedor ya incluye Node 24, Writer, Python UNO y fuentes.

El Dockerfile incluye un healthcheck que consulta `/ready` con el propio Node, sin depender de curl o wget. Coolify puede usar el healthcheck de la imagen; no es necesario agregar otro chequeo HTTP desde el panel.

Se construyó y probó la imagen localmente en Docker Linux: dos conversiones reales del membrete Word, estampado, metadatos Genika, reconocimiento de marcas y respuesta del healthcheck tanto con disponibilidad como sin ella. La prueba se ejecutó sin red ni credenciales reales y confirmó que la imagen usa un usuario sin privilegios y excluye los archivos `.env`. Esto valida la imagen, pero no comprueba la conectividad ni los recursos del VPS.

Configurar HTTPS para `radicados.appfastway.com` hacia el puerto interno `3010`, cargas de al menos 25 MiB y timeout de al menos 180 segundos. Configurar `TRUST_PROXY_HOPS=1` cuando el único proxy delante de la aplicación sea Traefik de Coolify. Mantener vacío el mapeo de puertos públicos: el puerto 3010 debe ser accesible a través del proxy, sin un acceso directo que permita suplantar las cabeceras. El valor por defecto es `0` para acceso directo local; si hay más proxies, ajustar el número a la topología real. No se usa confianza ilimitada ni se desactivan las comprobaciones de express-rate-limit.

### Error NoSuchBucket al preparar un documento

`NoSuchBucket` indica que el servicio S3 alcanzado no encuentra el bucket configurado. En la consola del MinIO del VPS, crear **radicados** con acceso privado y conceder al usuario de la API permisos para guardar, leer y eliminar objetos de ese bucket. Comprobar en las variables de ejecución de Coolify:

```dotenv
S3_BUCKET=radicados
S3_PREFIX=radicados
S3_FORCE_PATH_STYLE=true
TRUST_PROXY_HOPS=1
```

`S3_ENDPOINT` debe apuntar a la API S3 del MinIO correcto, con puerto `9000`. La consola usa `9001`. Un bucket creado localmente o en otro MinIO no existe en el almacenamiento del VPS. Después de cambiar variables, guardar y redesplegar la aplicación. La API devolverá `503 ALMACENAMIENTO_SIN_BUCKET` con una referencia de atención si falta el bucket; no creará recursos automáticamente ni cambiará sus políticas de acceso.

Comprobar `/health` y `/ready`; después probar con una sesión WMS la preparación de DOCX, emisión, descarga y verificación. `/ready` comprueba Mongo, pero no S3 ni LibreOffice; el flujo documental verifica esas integraciones. El log `Conversor de Word preparado` confirma el arranque del motor.

## Revisión de secretos: 27 de octubre de 2026

Se revisaron fuentes, scripts, pruebas, documentación y configuración de Radicaciones y FrontWms, excluyendo dependencias, entornos privados, binarios y temporales. Se buscaron coincidencias con secretos locales sin imprimirlos, credenciales en URLs, claves AWS, claves privadas y JWT literales. Se encontró y eliminó una clave AES real de la plantilla `FrontWms/.env.qa.example`, dejándola vacía. La revisión final no encontró credenciales reales incrustadas en las fuentes y plantillas actuales. La clave de `test/helpers.js` es ficticia y exclusiva de pruebas; el Dockerfile no incluye las pruebas. Radicaciones no tiene un historial Git local para auditar. Esta revisión no cubre de forma exhaustiva el historial remoto ni secretos de la plataforma de despliegue.

**Hallazgo previo en FrontWms:** `src/components/GestionBodega/Inventario/UbicarProducto.jsx` lee `VITE_AES_SECRET_KEY` para ubicación/QR. Su valor aparece en el JavaScript compilado de `dist` y coincide con `AES_SECRET_KEY` de WMS: toda variable `VITE_*` usada por el cliente es visible al navegador. La clave también estaba en la versión `HEAD` de la plantilla de QA. Quitar el valor del archivo actual no lo elimina del historial ni lo oculta en la aplicación compilada mientras esta operación siga en el cliente; debe tratarse como un valor expuesto. Se conservó el entorno real sin rotar esa clave, porque puede romper los QR actuales. Si esa operación necesita confidencialidad, debe trasladarse al servidor con una migración compatible de los códigos existentes y rotación de la clave. Esta clave es diferente del JWT de Radicaciones.
