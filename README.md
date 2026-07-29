# ticket-parsing-cloud

El backend AWS que recibe los tickets crudos de cada
[print-capture-agent](../print-capture-agent) instalado, los parsea y
guarda el resultado estructurado. Multi-tenant desde el diseño: varios
negocios usando el mismo backend al mismo tiempo, cada uno aislado del
resto.

**Stack:** 100% serverless (API Gateway + Lambda + DynamoDB + S3, con SQS
solo como cola de fallos), definido con AWS CDK en TypeScript. Se eligió
serverless porque el tráfico real es bajo (unos pocos negocios, cientos de
tickets/día cada uno, solo en horario comercial) — no tiene sentido pagar
por infraestructura siempre prendida.

## Estado: desplegado en AWS real

- ✅ `npx tsc --noEmit` — tipos correctos.
- ✅ `npm test` — 6 suites / 40 tests: síntesis del stack, el Stream de la
  tabla habilitado, el parser real contra las 5 fixtures sintéticas
  (`test/parsing/`), validación del body de ingesta (`test/ingest/`,
  incluida la escritura condicional/idempotencia), el handler de parseo
  disparado por Stream (`test/parser/`), y el endpoint de lectura
  (`test/read/`) — con los clientes de AWS mockeados, no pega contra AWS
  real.
- ✅ `npx cdk synth` — genera el CloudFormation completo, bundlea los Lambdas con esbuild sin errores.
- ✅ **Desplegado con `cdk deploy`** en una cuenta AWS real (ver PROYECTO.md sección 9 para los outputs) — no es solo código validado localmente.

## Arquitectura

```
Agente (por negocio) ──POST + API key──► API Gateway ──► Lambda ingest
  (ticketId propio,                                          │
   idempotente en                              guarda raw en S3
   reintentos)                    guarda ticket "pending" en DynamoDB
                                   (escritura condicional — un reintento
                                    con el mismo ticketId no duplica nada)
                                        responde 202 sin esperar el parseo
                                                              │
                                                              ▼
                                          Stream de la tabla Tickets
                                          (dispara solo, sin paso intermedio
                                           que pueda fallar por separado)
                                                              │
                                                              ▼
                                                       Lambda parser
                                                              │
                                                    resuelve el tenant → su parserId
                                                    lee el raw de S3
                                                    parsea, actualiza DynamoDB
                                                              │
                                                              ▼
                                                       DLQ (si falla de forma
                                                       persistente, no se pierde)
```

**Por qué Streams y no una cola SQS entre `ingest` y `parser`:** si el
ingest escribiera en DynamoDB y *después*, como paso separado, mandara un
mensaje a SQS, un fallo justo entre esos dos pasos dejaría el ticket en
`pending` para siempre — nada lo dispararía nunca. Con el Stream, el
disparo del parseo es una consecuencia directa y garantizada de la
escritura en DynamoDB, no un paso aparte.

## Aislamiento multi-tenant

- Cada negocio tiene su propia **API key** de API Gateway (`onboard-tenant`
  la crea) asociada a un **usage plan** compartido (throttling por tenant
  sin código extra).
- El Lambda de ingest **nunca confía en un `tenantId` del body** — lo
  resuelve del lado del servidor a partir de la API key usada
  (`resolveTenantByApiKeyId`). Un agente mal configurado no puede escribir
  en los datos de otro negocio.
- Tabla `Tickets` (single-table): `PK = TENANT#<id>`, así que cada query
  ya viene acotada a un solo tenant. GSI por `TENANT#<id>#STATUS#<status>`
  para la cola de revisión de tickets pendientes/fallidos.
- Tabla `Tenants`: qué parser usa cada negocio (`parserId`) — cada uno
  puede tener un POS distinto, el Lambda de parseo lo despacha
  explícitamente, sin adivinar por heurística.
- **Parser por puerto, no solo por tenant** (`portParsers` en `Tenants`):
  un mismo negocio puede tener varios periféricos con formatos distintos
  a la vez (ej. impresora en COM3 + datáfono/TPV en COM7, o un periférico
  TCP configurado en el agente) — el Lambda de parseo mira primero
  `portParsers[<puerto>]` y si no hay nada asignado ahí, cae al
  `parserId` default del tenant. Se asigna con `scripts/assign-port-parser.ts`.
- **Alcance de lo que se captura de datáfonos/TPVs:** el ticket crudo que
  sube el agente es lo que el periférico ya emite por su puerto/socket —
  nunca datos de tarjeta (PAN, pista, CVV). Este backend no tiene, ni
  debería tener, ese tipo de dato pasando por acá.

## Estructura

```
src/
├── ingest/handler.ts    # Lambda detrás de POST /tickets
├── read/handler.ts       # Lambda detrás de GET /tickets
├── parser/handler.ts    # Lambda disparado por el Stream de la tabla Tickets
├── parsing/              # el mismo TicketParser/registry portado de print-capture-agent,
│                          # pero con dispatch explícito por parserId en vez de auto-detección
└── shared/
    ├── dynamo.ts          # clientes + construcción de claves de la tabla single-table
    ├── tenant.ts           # resolver tenant por apiKeyId (nunca por input del cliente)
    └── types.ts
lib/ticket-parsing-cloud-stack.ts        # toda la infra (CDK)
scripts/onboard-tenant.ts                 # alta de un negocio nuevo (API key + registro Tenant)
scripts/assign-port-parser.ts              # asigna el parser de un puerto puntual a un tenant existente
fixtures/sample-tickets/                    # mismas fixtures sintéticas que en los otros proyectos
```

## Cómo probarlo (sin desplegar)

```bash
npm install
npx tsc --noEmit   # tipos
npm test            # sintetiza el stack y verifica los recursos clave
npx cdk synth        # ver el CloudFormation completo en cdk.out/
```

## Puesta en marcha en AWS

**Ya está hecho** — este entorno tiene AWS CLI configurado y el stack ya
está desplegado (ver "Estado" arriba y PROYECTO.md sección 9 para los
outputs reales). Lo que sigue es la referencia completa por si hace falta
repetir el proceso desde cero (una PC nueva, otra cuenta AWS, etc.) — son
tres niveles: preparar la cuenta (una sola vez en la vida), desplegar el
stack (cada vez que cambia el código de infraestructura), y dar de alta
un negocio (cada vez que sumás un cliente nuevo).

### 1. Preparar la cuenta de AWS (una sola vez)

**a) Tené una cuenta de AWS.** Se crea en [aws.amazon.com](https://aws.amazon.com)
con una tarjeta. El nivel gratuito de Lambda, API Gateway y DynamoDB es
permanente (no de 12 meses), así que con el volumen de este proyecto vas
a pagar muy poco o nada al principio.

**b) No uses el usuario root para el día a día.** La cuenta root es la
que tiene acceso total y sin restricciones — usarla para operaciones de
rutina (como desplegar) es un riesgo innecesario si esa credencial se
filtra alguna vez. En su lugar: **consola de AWS → IAM → Users → Create
user**, creá un usuario (ej. `deploy-ticket-parsing`) y asignale la
política `AdministratorAccess` para empezar (es lo más simple; el CDK en
concreto necesita permisos sobre CloudFormation, IAM, Lambda, API
Gateway, DynamoDB, S3 y SQS — administrator ya los cubre todos).

**c) Generá credenciales para ese usuario.** Dentro del usuario recién
creado: **Security credentials → Create access key → Command Line
Interface (CLI)**. Te da un `Access Key ID` y un `Secret Access Key` —
copiá el secreto ahí mismo, AWS no lo vuelve a mostrar después.

**d) Instalá y configurá AWS CLI en tu PC:**

```bash
winget install Amazon.AWSCLI
aws configure
```

Te va a pedir el Access Key ID, el Secret, una región por default y el
formato de salida (`json` está bien). El CLI guarda esto en
`~/.aws/credentials` — es lo que usan tanto el CDK como el SDK que corre
dentro de `onboard-tenant.ts` para autenticarse contra tu cuenta.

**e) Elegí la región.** Para un negocio en Argentina, `sa-east-1` (São
Paulo) da menor latencia que `us-east-1` — es la región de AWS más
cercana geográficamente. La región que hayas puesto en `aws configure` es
la que va a usar `cdk deploy` si no la sobreescribís explícitamente en
`bin/ticket-parsing-cloud.ts`.

**f) (Recomendado) Poné una alarma de presupuesto.** **Billing → Budgets
→ Create budget** — un budget mensual de, digamos, USD 10-20 con alerta
por mail apenas se acerque. Con este stack (serverless, bajo volumen) no
debería ni acercarse, pero te avisa temprano si algo quedó mal
configurado — por ejemplo un loop de reintentos que no corta nunca.

**g) `cdk bootstrap`** — se corre una sola vez por combinación de cuenta
+ región, no una vez por deploy. Prepara el "terreno" que el CDK
necesita para poder desplegar cualquier stack: crea un bucket S3 (donde
sube los assets — el código bundleado de los Lambdas, por ejemplo) y
unos roles IAM que CloudFormation usa internamente.

```bash
cd ticket-parsing-cloud
npx cdk bootstrap
```

### 2. Desplegar el stack

```bash
npm install
npx cdk deploy
```

CDK primero sintetiza el stack a CloudFormation (lo mismo que hace
`cdk synth`), te muestra un resumen de qué recursos va a crear o cambiar
en tu cuenta real, y pide confirmación (`y`) antes de tocar nada — es tu
última oportunidad de revisar antes de que se facture algo. Al terminar,
imprime los **outputs** del stack — **guardalos**, los vas a necesitar
en el paso siguiente:

| Output | Para qué sirve |
|---|---|
| `ApiUrl` | la URL base de la API — va en `CLOUD_UPLOAD_URL` del agente, agregándole `/tickets` |
| `UsagePlanId` | lo pide `onboard-tenant` para asociar la API key nueva al usage plan |
| `TenantsTableName` | lo pide `onboard-tenant` para escribir el registro del tenant |
| `TicketsTableName` / `RawTicketsBucketName` | útiles si después querés consultar datos a mano desde la consola |

Cada vez que cambies algo en `lib/ticket-parsing-cloud-stack.ts` o en el
código de los Lambdas, repetís `npx cdk deploy` — no hace falta volver a
bootstrapear.

### 3. Dar de alta un negocio (cada vez que sumás un cliente)

```bash
TICKET_STACK_USAGE_PLAN_ID=<el output UsagePlanId> \
TENANTS_TABLE=<el output TenantsTableName> \
npm run onboard-tenant -- --business "La Esquina del Sabor" --parser example-38col
```

Este script (`scripts/onboard-tenant.ts`) hace tres cosas en tu cuenta:
crea una API key nueva en API Gateway, la asocia al usage plan (para que
comparta el throttling configurado en el stack), y escribe el registro
del tenant en la tabla `Tenants` con el `parserId` que le indicaste. Al
terminar imprime la API key generada — **es la única vez que se muestra**
(igual que el secret del usuario IAM), copiala ahí mismo.

Esa API key va en la configuración del `print-capture-agent` que se
instale en la PC de ese negocio:

- `CLOUD_UPLOAD_URL` = `<ApiUrl>/tickets`
- `CLOUD_API_KEY` = la API key que imprimió `onboard-tenant`

El `--parser` que le pasás tiene que ser el `id` de un parser que ya
exista en `src/parsing/registry.ts` — hoy el único disponible es
`example-38col` (la plantilla sintética, todavía sin validar contra un
POS real).

**Si ese negocio suma un segundo periférico** (ej. un datáfono además de
la impresora), no hace falta crear otro tenant — se le asigna un parser
a ese puerto puntual:

```bash
TENANTS_TABLE=<el output TenantsTableName> \
npm run assign-port-parser -- --tenant <tenantId> --port COM7 --parser ingenico-v1
```

El Lambda de parseo va a usar ese parser solo para lo que llegue por
`COM7` de ese tenant — el resto de sus puertos sigue con el `parserId`
default.

## Lo que falta antes de que esto sirva con un POS real

1. Escribir el parser real (`src/parsing/parsers/`) contra una muestra
   real de ticket — hoy solo existe `example-38col`, la misma plantilla
   inventada que se usaba en el agente antes de migrar el parseo acá.
   Depende de validar la captura contra hardware real primero (ver
   PROYECTO.md sección 8).
2. Definir cómo un negocio nuevo con un POS distinto obtiene su propio
   `parserId` — hoy es un valor que se pasa a mano en `onboard-tenant`.
