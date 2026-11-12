import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { checkAssistantRateLimit } from "./rateLimit.js";
import { saveReport } from "./reportStore.js";
import { formatBusinessContextBlock, loadAskBusinessContext, type AskBusinessContext } from "./businessContext.js";
import { analyticsToolSpec, analyzeBusinessTool } from "./analyticsTools.js";
import { explainMatterTool, listMattersTool } from "./matterTools.js";
import { listWidgetsTool } from "./widgetTools.js";
import { resolveActiveTenantFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { userViewFor } from "../shared/userView.js";
import { AGENTS_TABLE, ddb, TICKETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { AgentRecord, TicketRecord, TicketStatus, WidgetAggregation, WidgetFilters, WidgetRecord, WidgetVisualization } from "../shared/types.js";
import { PAYMENT_METHODS, resolvePaymentMethodFilter } from "../parsing/bedrockShared.js";
import { AthenaTimeoutError, runWidgetQuery as runAthenaQuery, type WidgetDataPoint } from "../widgets/athenaQuery.js";
import { dateFilterError } from "../widgets/dateFilters.js";
import { extractProductVolume } from "./productVolume.js";
import {
  AGGREGATIONS,
  CATEGORICAL_FIELDS,
  EVENT_COUNT_FIELD,
  NUMERIC_FIELDS,
  TEMPORAL_FIELDS,
  isItemLevelGroupBy,
  isTemporalGroupByField,
  isTicketLevelField,
  isTimeOfDayGroupBy,
  isValidAggregation,
  isValidGroupByField,
  isValidTimeZone,
  isValidMetricField,
} from "../widgets/fields.js";
import { buildWidgetQuery, undatedQueryCoverage } from "../widgets/queryBuilder.js";
import { internalMatterId } from "../advisor/matterApi.js";

const bedrock = new BedrockRuntimeClient({});

const MAX_QUESTION_LENGTH = 500;
// Cada turno es una llamada a Bedrock; con tool-use, una pregunta típica
// necesita 2 (pedir la herramienta -> responder con el resultado). El tope
// evita que una pregunta rara entre en un ciclo largo y caro.
const MAX_TURNS = 4;

// API Gateway corta a los 29 s y el cliente recibe un 504 pelado, sin mensaje.
// Se trabaja con presupuesto propio: las consultas a Athena (las que se encolan)
// deben terminar antes de TOOL_DEADLINE_MS y todo el pedido antes de REQUEST_BUDGET_MS,
// dejando margen para la última llamada a Bedrock que redacta la respuesta.
const TOOL_DEADLINE_MS = 18_000;
const REQUEST_BUDGET_MS = 26_000;

const TICKET_STATUSES: TicketStatus[] = ["pending", "parsed", "needs_review", "failed"];
// Menos que el tope de los widgets (MAX_GROUPS en queryBuilder.ts): cada
// fila le llega al modelo como tokens de entrada, y para contestar "¿qué
// producto vendió más?" alcanza con los primeros 50 ordenados por valor.
const ASSISTANT_MAX_GROUPS = 50;
// Tope de puntos de las series por día/hora; debe coincidir con MAX_TIME_POINTS en queryBuilder.ts.
const MAX_TIME_POINTS = 800;
const LIST_TICKETS_DEFAULT_LIMIT = 10;
const LIST_TICKETS_MAX_LIMIT = 15;
// Páginas de 1 MB de Dynamo que recorre la búsqueda por cliente antes de rendirse.
const CUSTOMER_SEARCH_MAX_PAGES = 30;

/** Minúsculas y sin tildes, para que "castaño" y "CASTANO" coincidan. */
function normalizeSearchText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
const MAX_DESCRIPTION_FILTER_LENGTH = 50;
const REPORT_MAX_SECTIONS = 6;
const REPORT_MAX_TITLE_LENGTH = 100;

const SYSTEM_PROMPT = `Sos Innova, el especialista del negocio en InnoApp. Ayudás al dueño a entender ventas, sucursales, productos, medios de pago, horas pico, robots de captura y avisos del día, con los datos REALES de ESTE negocio. Contestá siempre en español, en pocas oraciones, directo al grano. Hablá como alguien que conoce el local, no como un analista anónimo.

Tenés herramientas para consultar los datos REALES del negocio — nunca inventes números, causas operativas ni métricas que no vinieron de una tool:
Las métricas de venta cuentan por defecto los tickets confirmados (parsed) y los pendientes de revisión (needs_review), este último un ticket leído por un modelo de IA que el negocio aún no confirmó; excluyen líneas anuladas al consultar productos. Un value null significa que no hay observaciones para esa métrica: no lo conviertas en cero ni calcules un porcentaje contra una base ausente. sampleCount, cuando aparece, indica el número de observaciones del promedio. Si el usuario pregunta por ventas confirmadas, filtrá por estado parsed; si una consulta explícita por estado incluye needs_review, aclaralo.
- "run_widget_query": totales/promedios/conteos, opcionalmente agrupados por sucursal/estado/producto o por día. Usala para preguntas de agregados ("¿cuánto vendí?", "¿qué producto vendió más?", "comparame las sucursales", "¿qué día vendí más?").
- "list_tickets": los tickets más recientes (fecha, sucursal, puerto, estado, total y, en facturas electrónicas, cliente y número de factura), opcionalmente filtrados por estado. Usala para preguntas puntuales sobre ventas concretas o para listados fila por fila, no para totales.
- "list_matters": lista avisos (matters) del Advisor — anomalías de venta, robot offline, captura en cero, cola de revisión, fallos de parseo. Usala cuando pregunten qué hay que revisar, qué avisos hay o el estado de Innova/avisos. Por defecto trae los abiertos (new/seen).
- "explain_matter": detalla UN aviso por matterId (id público). Usala si el usuario pregunta por un aviso concreto o el mensaje trae un matterId. Devolvé evidence/expected/actual y sugerí los chequeos de la herramienta; no inventes por qué falló una impresora o un POS — pedí que confirmen en Agentes. Podés contrastar el aviso con ventas vía run_widget_query o list_tickets.

- "analyze_business": análisis calculado por el servidor para las preguntas guía. SIEMPRE usala (y no run_widget_query) para: "¿cómo va mi negocio hoy?" (intent business_status_today, day "today"), "¿cómo estuvo el negocio ayer?" / cualquier pregunta de estado del negocio de "ayer" (intent business_status_today con day "yesterday": el servidor usa el día local CERRADO de ayer; NUNCA presentes el parcial de hoy como si fuera ayer), "¿por qué vendí menos esta semana?" (intent weekly_sales_decline, week "current"), "¿por qué vendí menos la semana pasada?" / "semana pasada" cerrada (intent weekly_sales_decline con week "last_closed": lun–dom ISO ya cerrados; NUNCA mapees "semana pasada" a la semana en curso parcial), "¿cómo vamos este mes?" / "lo que va del mes contra el mes anterior" / "este mes vs octubre del 1 al 12" (intent month_to_date: el servidor compara el acumulado del día 1 a hoy con el día 1 al mismo número de día del mes anterior; NUNCA lo sustituyas por la comparación con la semana pasada y, si no existe una comparación pedida, decilo en vez de cambiarla en silencio), "¿qué puedo hacer para vender más mañana?" (intent increase_tomorrow_sales), "¿cuáles son mis productos estrella?" / productos que más venden y crecen (intent product_stars) y "¿qué local/sucursal está funcionando mejor?" (intent location_performance; period por defecto last_7_days; usá period "today" solo si piden explícitamente hoy). La herramienta ya compara la misma franja horaria, descompone tickets y ticket medio y avisa la calidad de los datos. Respondé en unas 100-150 palabras con las cifras del resultado tal cual (metrics, breakdowns, summary), sin recalcular, redondear distinto ni agregar números: es el mismo principio de "nunca inventes cifras". Reglas: (1) distinguí lo observado de las hipótesis y nunca afirmes causas; solo "coincide con" o "habría que revisar". (2) Un valor null o "sin base comparable" se dice así, nunca como cero ni como un porcentaje inventado. (3) Respetá los warnings de quality (sin costes, sin objetivo, histórico insuficiente, captura sin ventas): mencioná los relevantes en una frase y no prometas visión completa del negocio si la captura es parcial. (4) En location_performance no elijas un único "mejor local": nombrá el ganador por cada dimensión y aclará que sin costes no hay rentabilidad. (5) Si metrics.margin dice available false, no hables de margen ni de "el más rentable". (6) Cerrá con UNA acción concreta y verificable, sin sugerir descuentos. (7) En weekly_sales_decline: la primera frase dice qué cayó, cuánto y contra qué periodo; después los efectos de tickets y ticket medio (suman la variación) y los topDrivers (cortes distintos de la misma caída: no los sumes); separá "hechos detectados" de "posibles explicaciones" (kind hypothesis) y, si status es no_decline, decí "no se observa una caída comparable" y explicá la variación; la acción es investigar la franja, el producto o la sucursal de mayor pérdida, nunca bajar precios ni dar descuentos. (8) En increase_tomorrow_sales: presentá el rango esperado de mañana como escenario (nunca "vas a vender"), y las acciones de recommendations en su orden de prioridad, cada una con qué hacer, por qué, cuándo/dónde, impacto, confianza y cómo hacer el seguimiento. Si impact.available es false, decí que no se puede cuantificar; no inventes cifras de impacto, de margen ni de stock. El potencial (metrics.potential) cubre solo la acción cuantificada: no sumes impactos. No recomiendes promociones con descuento ni afirmes que algo es "rentable". Si status es likely_closed o insufficient_history, explicá por qué no hay recomendaciones. (9) Fechas: day/week/period los fija el servidor en la TZ del negocio; no inventes dateFrom/dateTo ni digas "ayer" si el resultado es de hoy.

- "build_report": arma un reporte descargable (varias secciones, cada una con su consulta). Usala SOLO cuando el usuario pida un reporte, informe o resumen para descargar. Las tablas las calcula la herramienta con datos reales; vos no transcribas números. Después de llamarla, contestá en pocas oraciones con los hallazgos principales y decí que el reporte está listo para descargar.

- "list_widgets": lista los widgets/KPIs ya creados en el dashboard (título, tipo, campo, filtros). Usala ANTES de create_widget. Si ya hay uno equivalente (misma métrica/agrupación/filtros o título muy parecido), decilo, nombralo y ofrecé usarlo o ajustarlo en vez de duplicar.
- "create_widget": agrega un widget al dashboard. Usala cuando el usuario pida crear/agregar/hacer un KPI, gráfica o widget con condiciones (una sucursal, un producto, un medio de pago). Antes de crearlo, mirá list_widgets: no dupliques uno equivalente. Pasá esas condiciones como filtros "branch", "descriptionContains" y "paymentMethod": nunca las ignores ni las metas solo en el título. Un widget de un producto usa "subtotal" (plata) o "quantity" (unidades), nunca "total". Si piden ventas Y cantidad de un producto en un mismo seguimiento, creá UN solo KPI con field "subtotal" y secondaryField "quantity" (la tarjeta muestra la plata grande y las unidades al lado); no lo uses en KPIs de ventas totales. Un widget "line" solo admite groupBy day/hour y "bar"/"donut" solo categorías: si lo pedido no se puede crear tal cual, decilo en vez de cambiarlo en silencio. Cada respuesta crea un solo widget. Escribí el producto sin tildes y con una raíz corta ("cafe con leche"). La herramienta devuelve "preview" con el valor actual: contale al usuario qué filtros quedaron aplicados y cuánto da hoy; si preview viene vacío o en cero, decilo y sugerí revisar el nombre del producto. Si la sucursal no existe o es ambigua, mostrale las opciones y no crees nada. REGLA DURA: solo podés decir que creaste, agregaste o añadiste un widget si en ESTE turno llamaste a create_widget y devolvió ok; el historial no cuenta (tus mensajes anteriores que dicen "creé…" no crean nada nuevo, no los imites). Cada pedido de un widget nuevo exige su propia llamada a create_widget, aunque se parezca al anterior o ya tengas las cifras. Los widgets no admiten rango de fechas: acumulan todo el historial, así que no pongas meses, años ni periodos en el título ("Ventas 5 litros · Por cliente", no "· Noviembre") y avisá que no filtra por fecha si el usuario pidió un periodo. Para "descriptionContains" usá el nombre completo de la medida ("5 litros"), no fragmentos como "5 l" que también coinciden con "25 L" o "15 L".

Sucursales: cada robot ("agent") es una sucursal/local del negocio. Para "¿qué sucursal/local/sede…?", "comparame las sucursales" o "ventas por sucursal" agrupá por "agent": el resultado ya trae el nombre de cada sucursal, usalo tal cual en la respuesta. NO uses "port" para eso: "port" es el puerto/periférico (por ejemplo una caja registradora, TPV-CAJA1) y un mismo local puede tener varios; solo agrupá por "port" si piden explícitamente comparar cajas o puertos.
Para los datos de UNA sola sucursal ("¿qué se vende más en la sucursal Sol?", "ventas de Chapinero en octubre") usá el filtro "branch" con el nombre que dijo el usuario, junto con el resto de la consulta (por ejemplo agrupado por producto). Sin ese filtro el resultado es de TODO el negocio: nunca atribuyas a una sucursal un resultado que no consultaste con "branch". Si la herramienta responde que la sucursal no existe o es ambigua, mostrale al usuario las sucursales que te devuelve y pedile que elija.

Clientes: si el negocio factura con factura electrónica, las ventas traen el cliente. Para "¿qué cliente compró más?" o "ventas por cliente" agrupá por "customer" (con "total" o "subtotal"). Si todo sale como "sin dato", ese negocio no registra clientes: decilo. Para una lista de ventas/facturas con el nombre del cliente en una columna, usá "list_tickets": cada ticket trae customerName, customerId y documentNumber (solo las facturas electrónicas los tienen; si un ticket no los trae, ponelo como "sin dato" y no digas que el sistema no captura clientes). Para las facturas de UN cliente concreto ("¿qué facturas son de X?") usá "list_tickets" con "customerContains" (un fragmento del nombre): busca en todo el historial. "list_tickets" sin ese filtro solo trae los más recientes, así que NUNCA concluyas que un cliente no existe porque no salió en esa lista; si un cliente salió en una consulta agrupada por "customer", existe. "list_tickets" trae como máximo 15 facturas: si el resultado viene con truncated true, la lista está incompleta y NUNCA la uses para totales, resúmenes por semana/mes ni para decir "sin datos" en un período. Para un resumen o totales de UN cliente en un período ("ventas de D1 las últimas 3 semanas, por semana") usá "run_widget_query" con el filtro customerContains, el rango dateFrom/dateTo de cada semana (una consulta por semana con "total" y otra con "event_count" para el número de facturas) o groupBy "day" para el detalle diario; nunca armes los totales a mano desde "list_tickets".

Medio de pago: las ventas de los negocios cuyo ticket lo imprime traen con qué pagó el cliente (Efectivo, QR, Datafono, Tarjeta, Nequi, Daviplata, Transferencia, Rappi, Mixto u Otro). Para "¿cuánto vendí en efectivo vs QR?" o "ventas por medio de pago" agrupá por "paymentMethod" (con "total" para ventas del negocio, o "event_count" para cantidad de tickets). Para UN medio concreto ("¿cuánto pagaron con datafono?", "ventas en QR") usá el filtro "paymentMethod" con ese valor. NUNCA busques un medio de pago con "descriptionContains": no es un producto. Si el filtro o la agrupación no devuelve nada para un medio, la respuesta es que NO hay ventas pagadas con ese medio (decilo así, en cero); nunca la contestes con el total de otra consulta ni vuelvas a consultar sin el filtro de medio de pago para "encontrar" algo. Si preguntan por un medio y la agrupación solo muestra otros, decí cuáles medios hay y que ese no aparece. Los tickets anteriores a que se capturara este dato (o que no lo traen) salen como "sin dato": mencionalo, no lo repartas entre los demás medios. "list_tickets" trae paymentMethod en cada ticket.

Horas pico y días fuertes: para "¿a qué hora vendo más?", "horas pico" o "en qué horario…" agrupá por "hourOfDay" (hora 00–23 en la zona del negocio, juntando todos los días); para "¿qué día de la semana vendo más?" agrupá por "weekday" (1 = lunes … 7 = domingo). Hacé una consulta con "total" (plata) y otra con "event_count" (tickets) y armá la tabla con TODAS las horas (o días) que devolvió la herramienta, en orden, marcando las más fuertes. NUNCA uses "hour" ni "day" para esto: dan una fila por cada fecha y hora concreta (cientos de filas) y terminás eligiendo y ordenando filas vos mismo, donde se cometen errores. "Las horas pico de un día" o "cuándo se mueve más el negocio en un día" es un día típico: usá "hourOfDay" con todo el historial (o el período que pidan), no un día puntual como "hoy"; solo usá una fecha concreta si el usuario la nombra. Decí qué período cubre la tabla (desde qué fecha). Las horas sin ventas no aparecen en el resultado: aclaralo en vez de inventarlas. Armá la tabla con las horas de menor a mayor (de cuando abre a cuando cierra) y las columnas que dio la herramienta, y no omitas ni repitas filas. Decí solo lo que está en las filas devueltas: no inventes patrones ("poco movimiento después de las 20") que no estén en la tabla, y la hora pico es la de mayor valor.

Formato de la respuesta: texto plano. Podés resaltar con **negrita** lo más importante (el nombre de la sucursal o producto y la cifra clave). Si piden una lista o una tabla con columnas, armala como tabla markdown (| col | col | con la fila |---|---|); fuera de eso, nada de #, tablas ni viñetas con asteriscos. Moneda: si el contexto del negocio trae una moneda definida, usala al nombrar montos; si dice "(no definida)", escribí solo el número (con separador de miles y hasta 2 decimales), sin símbolo. Abierto/cerrado: solo si hay Horarios cargados; si no, hablá de horas con/sin ventas, nunca afirmes que el local debería estar cerrado.

No pidas aclaraciones si la pregunta se puede contestar con una suposición razonable: consultá, contestá y decí en una frase qué supusiste. Supuestos por defecto:
- "Ventas" es plata: "subtotal" si es por producto, "total" si es del negocio entero.
- Para "lo más vendido" o "el producto que más se vende" usá "quantity" (unidades vendidas) con sum, agrupado por producto. "event_count" cuenta tickets que incluyen el producto (un ticket con 3 horneadas cuenta 1): usalo solo si piden transacciones, tickets o clientes. Nunca mezcles las dos métricas en una misma comparación y decí siempre cuál usaste ("unidades" o "tickets"). En los títulos de las secciones de un reporte nombrá la métrica ("Unidades vendidas por producto", "Tickets por producto").
- Un mes o un día sin año es el más reciente que ya empezó, según la fecha de hoy (va al final).
- "Las horneadas", "lo que diga empanadas" y parecidos son un tipo de producto: usá el filtro "descriptionContains" con una raíz corta de la palabra, una consulta por cada tipo. La suma la hace la herramienta, no la calcules vos.
- "Envases", "botellas", "presentaciones", "tamaños", "tipos" o "referencias" vendidas NO son una palabra que aparezca en los nombres: el tipo de envase/presentación viene dentro del nombre del producto (por ejemplo "AGUA TRATADA 350 ML SIN GAS", "AGUA TRATADA 600 ML BALA CON GAS"). NUNCA filtres con "descriptionContains" por una categoría genérica como "envase", "botella" o "producto". Agrupá por "description" con "quantity" (sum) —y si piden plata, también "subtotal"— en el periodo pedido, y presentá cada producto como una fila: el nombre del producto es el tipo de envase y la cantidad es el número de envases/unidades. Cada fila agrupada por producto trae "volume" (la medida que figura en el nombre, ej. "350 ML"; ausente si no tiene): si piden el volumen separado, ponelo en su propia columna (Producto | Volumen | Unidades) copiando "volume" tal cual, sin calcularlo vos. Si piden totales POR VOLUMEN (todo lo de 350 ML junto, con y sin gas), agrupá por "volume" (con "quantity" o "subtotal"): la herramienta ya suma por medida; las filas "(sin dato)" son productos sin medida en el nombre. Nunca sumes filas por volumen vos.
- Totales de una consulta agrupada: el resultado trae "groupsTotal" (suma de TODOS los grupos, calculada por la herramienta) y "groupCount" (cuántos grupos hay). Para el total general ("ventas totales", "unidades vendidas") y para porcentajes de participación ("el 78% de los ingresos") usá "groupsTotal" como total; NUNCA sumes las filas vos ni inventes un total. Si "groupsTruncated" es true, la lista trae solo los primeros 50 grupos por valor y hay más: decilo ("mostrando los 50 principales de más"), y no presentes la lista como completa ni sumes sus filas como total. Si te piden "todas las referencias" y vienen menos filas que las que pide el usuario, avisá cuántas muestra la tabla. Si tampoco viene "groupsTotal", consultá aparte sin groupBy para obtener el total.
- Si piden el "total del ticket"/"total de la factura" desglosado por producto, volumen o medida, ese total no se puede repartir entre los ítems: usá "subtotal" (valor de las líneas, antes de los impuestos del ticket) y decí explícitamente en la respuesta que usaste subtotal y por qué. El encabezado de la columna de cifras nombra la métrica real que devolvió la herramienta (campo "metric": "Subtotal", "Unidades"…), no la que pidió el usuario.
- Cada cifra de una tabla se copia tal cual del resultado de la herramienta. Nunca multipliques, dividas ni derives importes (por ejemplo cantidad × precio) ni inventes precios: si te falta una cifra, volvé a consultar. Solo usá "descriptionContains" si el usuario nombra una palabra concreta que sí figura en los productos (una medida, "bala", "con gas"). Si el resultado viene vacío o con match "none" con un filtro de producto ("descriptionContains"), la respuesta es que NO hay coincidencias de ese producto: decilo así; NUNCA vuelvas a consultar sin ese filtro ni sustituyas con el total del negocio o el catálogo completo. Lo mismo con "paymentMethod" o "branch": vacío o en cero ES la respuesta.
- Si el resultado de "run_widget_query" trae "coverageFrom" / "lookbackYears", la consulta NO cubre todo el historial: decí explícitamente la ventana de cobertura (desde coverageFrom, lookbackYears años) y NUNCA presentes esas cifras como totales absolutos "desde siempre" o "en total histórico".
Pedí aclaración solo si no hay ninguna interpretación razonable.

Alcance: tickets, ventas, productos vendidos, sucursales/robots, parseo/revisión, avisos Advisor, reportes y KPIs del dashboard. Fuera de eso (nómina, personal, impuestos, costos unitarios, inventario teórico, proveedores, asesoría legal/fiscal): rechazá en una frase ("Con los datos que tengo…" / "No tengo costos ni inventario…") y volvé al dominio.

Promos y campañas (solo ancladas en ventas): si piden ideas de promoción, campañas, combos u "oportunidades de promo" BASADAS EN SUS DATOS DE VENTA, SÍ contestá. Primero consultá con run_widget_query / list_tickets / build_report / list_widgets (productos fuertes/débiles por quantity o subtotal, hourOfDay / weekday flojos, sucursales/agent débiles). Con esos hallazgos, proponé HASTA TRES campañas: para cada una, nombre corto, objetivo medible en volumen/tickets (no en margen) y a qué patrón de venta responde. NUNCA inventes costos, precios de compra, margen, utilidad ni "riesgo de margen" numérico: no hay esos datos. Si piden "riesgos para el margen", "impacto en margen" o similar, decí explícitamente que no tenés costos/márgenes y, en su lugar, listá riesgos de VOLUMEN basados solo en el patrón de ventas (canibalización de productos que ya venden bien, descontar en horas/días/sucursales que ya son fuertes, mover demanda sin subir tickets totales, concentrar descuento en un producto top). Estrategia creativa SIN datos ("inventá 3 campañas", "pensá promos creativas" sin mirar ventas): rechazá en una frase y pedí basarlo en productos/horarios/sucursales reales, o consultá vos los datos y entonces proponé. Preguntas solo de margen/costo/utilidad sin pedido de promo ("¿cuál es mi margen?"): rechazá — no inventes cifras.

Basá la respuesta únicamente en lo que devolvió la herramienta — si no hay datos, decilo en vez de inventar. Cuando uses datos reales, mencioná brevemente sobre qué te basaste (ej. cantidad de tickets).

Puede haber preguntas anteriores de la misma conversación antes de la actual — usalas para interpretar referencias ambiguas ("¿y por producto?", "¿y la semana pasada?"), pero siempre volvé a llamar a la herramienta correspondiente para traer datos frescos, nunca reuses un número que hayas dado antes sin volver a consultarlo.

Si una herramienta devuelve un error, no adivines por qué falló ni le atribuyas la causa a los datos del negocio (por ejemplo al estado de los tickets). Si el error dice que un parámetro es inválido, corregilo y probá de nuevo. Si es otro tipo de error, decile al usuario que hubo un problema técnico al consultar los datos y que pruebe de nuevo en un rato, y ofrecé lo que sí hayas podido consultar.`;

type PromptZoneOwner = "business" | "user" | "utc";

/**
 * El modelo no sabe qué día es: sin esto, "ventas de octubre" terminaba en
 * "¿octubre de qué año?" (2026-10-16). UTC, igual que el agrupado por "day".
 * P0 también inyecta ficha mínima del negocio (nombre, zona, sucursales).
 */
function buildSystemPrompt(
  now: Date,
  timeZone: string | undefined,
  zoneOwner: PromptZoneOwner,
  business: AskBusinessContext,
): string {
  const localDate = timeZone
    ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    : now.toISOString().slice(0, 10);
  const contextBlock = formatBusinessContextBlock(business, localDate, zoneOwner, timeZone);

  if (timeZone && zoneOwner === "business") {
    // Las horas son las del local aunque el usuario consulte desde otro país. Sin esta
    // aclaración el modelo "confirmaba" otra zona (le dijo "hora colombiana" a horas de Madrid).
    return (
      `${SYSTEM_PROMPT}\n\n${contextBlock}\n\nHoy es ${localDate} (zona horaria del negocio: ${timeZone}). ` +
      `Todas las fechas y horas de las consultas están en la hora local del negocio (${timeZone}), sin importar desde dónde consulte el usuario. ` +
      `Al nombrar una hora, es la hora del negocio. No conviertas horas a otra zona ni afirmes que están en otra: ` +
      `si el usuario pregunta por otra zona horaria, explicale que las horas están en la del negocio (${timeZone}).`
    );
  }
  if (timeZone) {
    return `${SYSTEM_PROMPT}\n\n${contextBlock}\n\nHoy es ${localDate} (zona horaria del usuario: ${timeZone}). Las fechas y horas de las consultas están en esa zona.`;
  }
  return `${SYSTEM_PROMPT}\n\n${contextBlock}\n\nHoy es ${localDate} (fecha UTC).`;
}

function widgetQueryProperties() {
  return {
      field: {
        type: "string",
        enum: [...NUMERIC_FIELDS, EVENT_COUNT_FIELD],
        description: "Campo a agregar. 'event_count' cuenta tickets en vez de sumar un campo.",
      },
      aggregation: { type: "string", enum: [...AGGREGATIONS], description: "Cómo agregar el campo." },
      groupBy: {
        type: "string",
        // Sin "day" acá el modelo no tenía forma de contestar "¿qué
        // día vendí más?" — runWidgetQueryTool ya lo aceptaba
        // (isValidGroupByField), solo faltaba ofrecerlo.
        enum: [...CATEGORICAL_FIELDS, ...TEMPORAL_FIELDS],
        description:
          "Campo para desglosar el resultado (opcional, omitir para un solo total). 'agent' desglosa por sucursal/local (devuelve el nombre de cada una). 'port' desglosa por puerto/periférico (caja), NO por sucursal. 'volume' agrupa por la medida del nombre del producto (350 ML, 600 ML, 20 L…); solo con 'subtotal', 'quantity', 'unitPrice' o 'event_count'. 'day' agrupa por fecha (YYYY-MM-DD) y 'hour' por hora (YYYY-MM-DD HH, 24h), ordenados de lo más viejo a lo más nuevo: son UNA FILA POR CADA FECHA/HORA concreta, para ver la evolución en el tiempo, NO para buscar horas pico. 'hourOfDay' agrupa por hora del día (00–23) juntando todos los días y 'weekday' por día de la semana (1 = lunes … 7 = domingo), ambos en la zona horaria del negocio y ordenados por etiqueta: son los que responden '¿a qué hora/qué día vendo más?'.",
      },
      filters: {
        type: "object",
        properties: {
          dateFrom: { type: "string", description: "Fecha desde, YYYY-MM-DD (opcional)." },
          dateTo: { type: "string", description: "Fecha hasta, YYYY-MM-DD, incluye ese día entero (opcional)." },
          port: { type: "string", description: "Filtrar por un puerto/periférico puntual, p. ej. TPV-CAJA1 (opcional). No sirve para filtrar por sucursal." },
          status: { type: "string", enum: TICKET_STATUSES, description: "Filtrar por estado del ticket (opcional)." },
          branch: {
            type: "string",
            description:
              "Solo los datos de esta sucursal/local, por su nombre tal cual lo dijo el usuario, p. ej. 'Sol' (opcional). Sin este filtro la consulta abarca todas las sucursales.",
          },
          paymentMethod: {
            type: "string",
            enum: [...PAYMENT_METHODS],
            description:
              "Solo las ventas pagadas con este medio de pago (opcional). Es la forma de preguntar por efectivo, QR, datafono, etc.: NUNCA uses 'descriptionContains' para eso, un medio de pago no es un producto. Si no hay ventas con ese medio, el resultado viene en cero/vacío y eso ES la respuesta: no hay ventas pagadas así.",
          },
          customerContains: {
            type: "string",
            description:
              "Solo las ventas (facturas electrónicas) cuyo cliente contiene este texto, sin distinguir mayúsculas ni tildes, p. ej. 'd1' (opcional). Es la forma de totalizar UN cliente: combinalo con dateFrom/dateTo y groupBy 'day' para resúmenes por semana o por día. Nunca lo reemplaces por 'list_tickets', que solo trae los 15 más recientes.",
          },
          descriptionContains: {
            type: "string",
            description:
              "Solo productos cuyo nombre contiene este texto, sin distinguir mayúsculas (opcional). Usá una raíz corta ('horne', 'empa') porque los nombres pueden venir abreviados. No sirve para categorías genéricas ('envase', 'botella'): para eso agrupá por 'description'. Solo con 'subtotal', 'quantity', 'unitPrice' o 'event_count'.",
          },
        },
      },
  };
}

function buildTools(): Tool[] {
  const queryProperties = widgetQueryProperties();
  return [
    {
      toolSpec: {
        name: "run_widget_query",
        description:
          "Calcula un agregado (suma, promedio, máximo, mínimo o cantidad) sobre los tickets de venta ya parseados del negocio, opcionalmente agrupado por una categoría o por día y filtrado por fecha/puerto/estado.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              ...queryProperties,
            },
            required: ["field", "aggregation"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "build_report",
        description: `Arma un reporte descargable con hasta ${REPORT_MAX_SECTIONS} secciones; cada sección es una consulta de datos con su título. Solo cuando el usuario pida un reporte/informe. Cada KPI con dateFrom y dateTo se compara solo con el periodo anterior (campo previous). Armá el reporte con 1 o 2 KPIs (sin groupBy), una tendencia (groupBy day) y un ranking (por description, port, etc.). Devuelve los datos para que redactes los hallazgos.`,
        inputSchema: {
          json: {
            type: "object",
            properties: {
              title: { type: "string", description: "Título del reporte (incluí el periodo si aplica)." },
              sections: {
                type: "array",
                maxItems: REPORT_MAX_SECTIONS,
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string", description: "Título de la sección, ej. 'Ventas por día'." },
                    ...queryProperties,
                  },
                  required: ["heading", "field", "aggregation"],
                },
              },
            },
            required: ["title", "sections"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "list_widgets",
        description:
          "Lista los widgets/KPIs ya creados en el dashboard del negocio (título, tipo de gráfica, campo, agregación, filtros resumidos). Usala antes de create_widget para no duplicar uno equivalente: si hay uno parecido, nombralo y ofrecé usarlo o ajustarlo.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Máximo de widgets a devolver (por defecto 30, tope 50)." },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: "create_widget",
        description:
          "Agrega un widget (KPI, barras, línea o dona) al dashboard del usuario. Antes de crearlo, consultá list_widgets y evitá duplicar uno equivalente. Valida la consulta con datos reales y devuelve una vista previa del valor. Un KPI es un solo número (sin groupBy); bar/donut necesitan groupBy; line necesita groupBy 'day' u 'hour'. Los widgets no admiten rango de fechas ni estado: solo los filtros branch, descriptionContains y paymentMethod.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              name: { type: "string", description: "Título del widget, descriptivo y corto, p. ej. 'Café con leche · Sol'." },
              visualization: { type: "string", enum: WIDGET_VISUALIZATIONS },
              field: queryProperties.field,
              aggregation: queryProperties.aggregation,
              secondaryField: {
                type: "string",
                enum: [...NUMERIC_FIELDS, EVENT_COUNT_FIELD],
                description:
                  "Solo para un KPI: segunda cifra que se muestra junto a la principal con los mismos filtros. Usala cuando pidan ventas Y cantidad de un producto: field 'subtotal' (plata) + secondaryField 'quantity' (unidades). Omitila en el resto de los KPIs, p. ej. ventas totales.",
              },
              secondaryAggregation: { ...queryProperties.aggregation, description: "Cómo agregar secondaryField (por defecto 'sum')." },
              groupBy: queryProperties.groupBy,
              filters: {
                type: "object",
                properties: {
                  branch: queryProperties.filters.properties.branch,
                  descriptionContains: queryProperties.filters.properties.descriptionContains,
                  paymentMethod: queryProperties.filters.properties.paymentMethod,
                },
              },
            },
            required: ["name", "visualization", "field", "aggregation"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "list_tickets",
        description: `Lista hasta ${LIST_TICKETS_MAX_LIMIT} tickets recientes del negocio, opcionalmente filtrados por estado. Cada ticket trae fecha, sucursal, puerto, estado, total y, si es factura electrónica, customerName/customerId/documentNumber. Para preguntas puntuales o listados, no para totales.`,
        inputSchema: {
          json: {
            type: "object",
            properties: {
              status: { type: "string", enum: TICKET_STATUSES },
              customerContains: {
                type: "string",
                description: "Solo las facturas cuyo cliente contiene este texto (sin distinguir mayúsculas ni tildes), buscando en todo el historial y no solo en lo reciente (opcional).",
              },
              limit: {
                type: "number",
                description: `Máximo de tickets a devolver (por defecto ${LIST_TICKETS_DEFAULT_LIMIT}, tope ${LIST_TICKETS_MAX_LIMIT}).`,
              },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: "list_matters",
        description:
          "Lista avisos (matters) del Advisor del negocio: anomalías de venta, robot offline, captura en cero, cola needs_review, fallos de parseo. Por defecto solo abiertos (new/seen). Cada aviso trae id, detector, severidad, sucursal, título, detail, expected/actual. Para el detalle de uno usá explain_matter.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              status: {
                type: "array",
                items: { type: "string", enum: ["new", "seen", "dismissed", "resolved"] },
                description: "Estados a incluir (opcional; por defecto new y seen).",
              },
              days: { type: "number", description: "Ventana en días hacia atrás (por defecto 14, tope 90)." },
              limit: { type: "number", description: "Máximo de avisos a devolver (por defecto 10, tope 10)." },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: "explain_matter",
        description:
          "Explica un aviso concreto por su matterId público (el id que manda la UI al tocar Preguntar). Devuelve título, detail, evidence, expected/actual y chequeos sugeridos. No inventes causas operativas.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              matterId: { type: "string", description: "Id público del aviso (base64url)." },
            },
            required: ["matterId"],
          },
        },
      },
    },
    analyticsToolSpec(),
  ];
}

/**
 * Igual validación que `widgets/createHandler.ts` contra la lista blanca de
 * `widgets/fields.ts` — el input de esta herramienta lo arma el modelo, no
 * un usuario, pero el mismo principio aplica: nunca confiar un nombre de
 * campo directo, siempre revalidar antes de generar SQL.
 */
async function parseQueryInput(
  input: unknown,
  tenantId: string,
  ctx: ToolContext,
): Promise<{ field: string; aggregation: string; groupBy?: string; filters?: WidgetFilters; branchLabel?: string }> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const field = typeof raw.field === "string" ? raw.field : "";
  if (!isValidMetricField(field)) {
    throw new Error(`campo inválido: "${field}". Válidos: ${[...NUMERIC_FIELDS, EVENT_COUNT_FIELD].join(", ")}`);
  }

  const aggregation = typeof raw.aggregation === "string" ? raw.aggregation : "";
  if (!isValidAggregation(aggregation)) {
    throw new Error(`agregación inválida: "${aggregation}". Válidas: ${AGGREGATIONS.join(", ")}`);
  }

  let groupBy: string | undefined;
  if (raw.groupBy !== undefined) {
    if (typeof raw.groupBy !== "string" || !isValidGroupByField(raw.groupBy)) {
      throw new Error(`groupBy inválido: "${String(raw.groupBy)}". Válidos: ${[...CATEGORICAL_FIELDS, ...TEMPORAL_FIELDS].join(", ")}`);
    }
    groupBy = raw.groupBy;
  }
  if (isItemLevelGroupBy(groupBy) && isTicketLevelField(field)) {
    throw new Error(`no se puede agrupar "${field}" (un valor por ticket) por "${groupBy}" (un valor por ítem) — usá "subtotal"`);
  }

  let filters: WidgetFilters | undefined;
  let branchLabel: string | undefined;
  if (raw.filters !== undefined) {
    if (!raw.filters || typeof raw.filters !== "object" || Array.isArray(raw.filters)) throw new Error("filters inválido, se esperaba un objeto");
    const f = raw.filters as Record<string, unknown>;
    filters = {};
    for (const key of ["dateFrom", "dateTo"] as const) {
      if (f[key] !== undefined && typeof f[key] !== "string") throw new Error(key + " inválida, se esperaba una fecha");
      if (typeof f[key] === "string") filters[key] = f[key];
    }
    const dateError = dateFilterError(filters);
    if (dateError) throw new Error(dateError);
    if (f.port !== undefined) {
      if (typeof f.port !== "string" || !f.port.trim()) throw new Error("port inválido");
      filters.port = f.port;
    }
    if (f.status !== undefined) {
      if (typeof f.status !== "string" || !TICKET_STATUSES.includes(f.status as TicketStatus)) throw new Error("status inválido");
      filters.status = f.status as TicketStatus;
    }
    if (f.branch !== undefined) {
      if (typeof f.branch !== "string" || !f.branch.trim()) throw new Error("branch inválido, se esperaba el nombre de una sucursal");
      await branchNames(tenantId, ctx);
      const match = resolveBranch(f.branch, ctx.branchAliases ?? new Map());
      filters.agentId = match.agentId;
      branchLabel = match.label;
    }
    if (f.paymentMethod !== undefined) {
      const method = resolvePaymentMethodFilter(f.paymentMethod);
      if (!method) throw new Error(`paymentMethod inválido: "${String(f.paymentMethod)}". Válidos: ${PAYMENT_METHODS.join(", ")}`);
      filters.paymentMethod = method;
    }
    if (f.customerContains !== undefined) {
      if (typeof f.customerContains !== "string" || !f.customerContains.trim()) throw new Error("customerContains inválido, se esperaba parte del nombre del cliente");
      filters.customerContains = f.customerContains.trim().slice(0, MAX_DESCRIPTION_FILTER_LENGTH);
    }
    if (f.descriptionContains !== undefined && (typeof f.descriptionContains !== "string" || !f.descriptionContains.trim())) throw new Error("descriptionContains inválido");
    if (typeof f.descriptionContains === "string" && f.descriptionContains.trim()) {
      filters.descriptionContains = f.descriptionContains.trim().slice(0, MAX_DESCRIPTION_FILTER_LENGTH);
    }
  }

  return { field, aggregation, groupBy, filters, branchLabel };
}

async function runWidgetQueryTool(input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  const { field, aggregation, groupBy, filters, branchLabel } = await parseQueryInput(input, tenantId, ctx);

  const widget: WidgetRecord = {
    tenantId,
    widgetId: "assistant-query",
    name: "assistant query",
    visualization: groupBy ? "bar" : "kpi",
    createdAt: new Date().toISOString(),
    metric: { field, aggregation: aggregation as WidgetAggregation },
    groupBy,
    filters,
  };

  const query = buildWidgetQuery(widget, ASSISTANT_MAX_GROUPS, ctx.timeZone);
  const maxWaitMs = ctx.deadline === undefined ? undefined : Math.max(1_000, ctx.deadline - Date.now());
  const data = await runAthenaQuery(query.sql, query.params, process.env.ATHENA_WORKGROUP!, maxWaitMs);
  // Qué se calculó de verdad, para que el modelo rotule la columna con la métrica real
  // y no la confunda con la que pidió el usuario (p. ej. "total del ticket" → subtotal).
  // El agentId es interno: al modelo se le devuelve el nombre de la sucursal consultada.
  const { agentId: _agentId, ...visibleFilters } = filters ?? {};
  const metaFilters = { ...visibleFilters, ...(branchLabel ? { branch: branchLabel } : {}) };
  // Un filtro por medio de pago sin coincidencias llega como [{value: null}] o []: eso es una
  // respuesta (no hay ventas así), no un fallo a "arreglar" consultando sin el filtro. Se dice
  // explícito para que el modelo no lo reemplace por el total de otra consulta.
  const noSalesNote =
    filters?.paymentMethod && data.every((row) => !row.value)
      ? `No hay ventas pagadas con ${filters.paymentMethod} en este periodo (cero). Respondé eso; no vuelvas a consultar sin el filtro de medio de pago.`
      : undefined;
  // Mismo antipatrón con producto: vacío ≠ "consultar el negocio entero". match "none" obliga
  // a decir que no hay coincidencias y prohíbe la reconsulta ciega sin descriptionContains.
  const noProductMatch = filters?.descriptionContains && data.every((row) => !row.value);
  const noProductNote = noProductMatch
    ? `No hay coincidencias de producto para "${filters.descriptionContains}". ` +
      `Decí que no hay ventas de ese producto; NO vuelvas a consultar sin descriptionContains ni sustituyas con el total del negocio.`
    : undefined;
  // Sin dateFrom/dateTo Athena acota particiones a ~1 año: hay que decir la ventana, no "desde siempre".
  const coverage = undatedQueryCoverage(filters);
  const coverageNote = coverage
    ? `Cobertura limitada: desde ${coverage.coverageFrom} (lookbackYears=${coverage.lookbackYears}). ` +
      `Decí esa ventana; NUNCA presentes estas cifras como total histórico absoluto o "desde siempre".`
    : undefined;
  // "hour"/"day" dan una fila por cada fecha (y hora): cientos de filas que el modelo terminaba
  // sumando y ordenando de cabeza, con errores (en una prueba real su tabla "por hora" sumaba 72%
  // del total real). Se le dice en el propio resultado qué usar en cambio.
  const rowsPerDateNote =
    (groupBy === "hour" && data.length > 24) || (groupBy === "day" && data.length > 31)
      ? `Son ${data.length} filas, una por cada fecha${groupBy === "hour" ? " y hora" : ""}. NO las sumes, ordenes ni agrupes vos: los totales los calcula la herramienta. ` +
        `Para horas pico o "a qué hora se vende más" consultá de nuevo con groupBy "hourOfDay" (hora del día, todos los días juntos); ` +
        `para "qué día de la semana se vende más", con groupBy "weekday". Usá estas filas solo para mostrar la evolución en el tiempo.`
      : undefined;
  // Total de TODOS los grupos, calculado acá: el modelo sumaba las filas de cabeza y se equivocaba
  // (en una prueba real dijo "1,02 mil millones" cuando el total era 932 M). Solo cuando los grupos
  // se reparten el total sin solaparse; con el tope de grupos alcanzado se pide el total sin agrupar.
  const groupsSummary = await groupsTotalSummary({ widget, data, field, aggregation, groupBy, timeZone: ctx.timeZone, maxWaitMs, filters });
  // Una sola `note` visible: producto vacío > medio de pago vacío > hour/day > cobertura
  // (coverageFrom/lookbackYears viajan siempre en el payload cuando aplican).
  const primaryNote = noProductNote ?? noSalesNote ?? rowsPerDateNote ?? coverageNote;
  const meta = {
    metric: field,
    aggregation,
    ...(groupBy ? { groupBy } : {}),
    ...(Object.keys(metaFilters).length ? { filters: metaFilters } : {}),
    ...groupsSummary,
    ...(noProductMatch ? { match: "none" as const } : {}),
    ...(coverage ? { coverageFrom: coverage.coverageFrom, lookbackYears: coverage.lookbackYears } : {}),
    ...(primaryNote ? { note: primaryNote } : {}),
  };
  if (groupBy === "description") return { ...meta, data: data.map((row) => ({ ...row, volume: extractProductVolume(row.label) })) };
  if (groupBy !== "agent") return { ...meta, data };

  // Por sucursal: Athena devuelve el agentId (UUID) — se traduce al nombre del local.
  const names = await branchNames(tenantId, ctx);
  return {
    ...meta,
    data: data.map((row) => ({
      ...row,
      label: !row.label || row.label === "(sin dato)" ? "Sin sucursal asignada" : (names.get(row.label) ?? row.label),
    })),
  };
}

/**
 * `groupsTotal` = suma de todos los grupos; `groupCount` = cuántos grupos hay. Si el tope recortó la
 * lista, `groupsTruncated` es true y el total sale de una consulta sin agrupar (el de las filas
 * mostradas sería parcial). No aplica a promedios/máx/mín ni a conteos de tickets por producto
 * (un ticket cuenta en cada uno de sus productos, así que los grupos se solapan).
 */
async function groupsTotalSummary(args: {
  widget: WidgetRecord;
  data: WidgetDataPoint[];
  field: string;
  aggregation: string;
  groupBy: string | undefined;
  timeZone: string | undefined;
  maxWaitMs: number | undefined;
  filters: WidgetFilters | undefined;
}): Promise<{ groupsTotal?: number; groupCount?: number; groupsTruncated?: boolean }> {
  const { widget, data, field, aggregation, groupBy, timeZone, maxWaitMs, filters } = args;
  if (!groupBy) return {};
  const isEventCount = field === EVENT_COUNT_FIELD;
  const additive = isEventCount
    ? !isItemLevelGroupBy(groupBy) && !filters?.descriptionContains
    : aggregation === "sum";
  if (!additive) return {};

  const byLabel = isTemporalGroupByField(groupBy) || isTimeOfDayGroupBy(groupBy);
  const cap = byLabel ? MAX_TIME_POINTS : ASSISTANT_MAX_GROUPS;
  const truncated = data.length >= cap;
  if (!truncated) {
    const total = data.reduce((sum, row) => sum + (row.value ?? 0), 0);
    return { groupsTotal: Math.round(total * 100) / 100, groupCount: data.length };
  }
  try {
    const whole = buildWidgetQuery({ ...widget, groupBy: undefined, visualization: "kpi" }, ASSISTANT_MAX_GROUPS, timeZone);
    const [row] = await runAthenaQuery(whole.sql, whole.params, process.env.ATHENA_WORKGROUP!, maxWaitMs);
    return { groupsTruncated: true, groupCount: data.length, ...(row?.value != null ? { groupsTotal: row.value } : {}) };
  } catch (err) {
    console.error("[assistant] no se pudo calcular el total sin agrupar:", err);
    return { groupsTruncated: true, groupCount: data.length };
  }
}

/** Mismo query que `read/handler.ts`, recortado a lo que le sirve al modelo (sin items, para no inflar tokens). */
async function listTicketsTool(input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const status = typeof raw.status === "string" && TICKET_STATUSES.includes(raw.status as TicketStatus) ? (raw.status as TicketStatus) : undefined;
  const limit =
    typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit > 0
      ? Math.min(raw.limit, LIST_TICKETS_MAX_LIMIT)
      : LIST_TICKETS_DEFAULT_LIMIT;

  const customerContains =
    typeof raw.customerContains === "string" && raw.customerContains.trim() ? normalizeSearchText(raw.customerContains.trim()) : undefined;

  const queryPage = (startKey?: Record<string, unknown>, pageLimit?: number) =>
    ddb.send(
      new QueryCommand({
        TableName: TICKETS_TABLE,
        ...(status ? { IndexName: "status-index" } : {}),
        KeyConditionExpression: status ? "gsi1pk = :gsi1pk" : "pk = :pk",
        ExpressionAttributeValues: status ? { ":gsi1pk": `TENANT#${tenantId}#STATUS#${status}` } : { ":pk": `TENANT#${tenantId}` },
        ScanIndexForward: false,
        ...(pageLimit ? { Limit: pageLimit } : {}),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

  // Se pide una fila de más para saber si el listado quedó cortado: sin ese
  // aviso el modelo tomaba los `limit` más recientes como "todo lo que hay" y
  // contestaba "sin datos" para los períodos anteriores.
  let items: TicketRecord[];
  let truncated = false;
  if (!customerContains) {
    items = ((await queryPage(undefined, limit + 1)).Items as TicketRecord[] | undefined) ?? [];
  } else {
    // Dynamo no filtra por cliente antes del Limit: se recorre el historial por
    // páginas (más recientes primero) hasta juntar `limit` coincidencias.
    items = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < CUSTOMER_SEARCH_MAX_PAGES && items.length <= limit; page++) {
      const res = await queryPage(startKey);
      for (const t of (res.Items as TicketRecord[] | undefined) ?? []) {
        if (t.customerName && normalizeSearchText(t.customerName).includes(customerContains)) items.push(t);
        if (items.length > limit) break;
      }
      startKey = res.LastEvaluatedKey;
      if (!startKey) break;
    }
    // Sin coincidencias de más, pero el recorrido se rindió antes de terminar el historial.
    if (startKey && items.length <= limit) truncated = true;
  }
  if (items.length > limit) {
    truncated = true;
    items = items.slice(0, limit);
  }

  const names = await branchNames(tenantId, ctx);
  const tickets = items.map((t) => ({
    ticketId: t.ticketId,
    capturedAt: t.capturedAt,
    status: t.status,
    branch: t.agentId ? names.get(t.agentId) : undefined,
    port: t.port,
    total: t.total,
    // Solo las facturas electrónicas traen estos datos; en el resto quedan ausentes.
    customerName: t.customerName,
    customerId: t.customerId,
    documentNumber: t.documentNumber,
    docType: t.docType,
    paymentMethod: t.paymentMethod,
  }));

  return {
    tickets,
    count: tickets.length,
    ...(truncated
      ? {
          truncated: true,
          note:
            `Lista INCOMPLETA: solo son los ${tickets.length} más recientes y hay más. No afirmes que un período o cliente "no tiene datos" por lo que no aparece aquí, ni armes totales o resúmenes por semana/mes con esta lista. ` +
            `Para totales, conteos o períodos consultá run_widget_query (con el filtro customerContains si es un cliente).`,
        }
      : {}),
  };
}

/**
 * `kpi` = un solo número, `trend` = serie por día, `ranking` = por categoría.
 * Se deduce de la consulta (no lo elige el modelo) para que el cliente sepa
 * qué gráfica dibujar sin depender de que el modelo lo etiquete bien.
 */
export type ReportSectionKind = "kpi" | "trend" | "ranking";
export type ReportSection = {
  kind: ReportSectionKind;
  heading: string;
  field: string;
  aggregation: string;
  groupBy?: string;
  filters?: Record<string, unknown>;
  data: WidgetDataPoint[];
  /** Solo en `kpi` con dateFrom y dateTo: el mismo cálculo en el periodo anterior de igual duración. */
  previous?: number | null;
};
export type Report = { title: string; generatedAt: string; sections: ReportSection[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Periodo inmediatamente anterior y de igual duración; null si el rango no es de fechas válidas. */
function previousPeriod(dateFrom: unknown, dateTo: unknown): { dateFrom: string; dateTo: string } | null {
  if (typeof dateFrom !== "string" || typeof dateTo !== "string" || !ISO_DATE.test(dateFrom) || !ISO_DATE.test(dateTo)) return null;
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const days = Math.round((to - from) / DAY_MS) + 1;
  const prevTo = from - DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { dateFrom: iso(prevTo - (days - 1) * DAY_MS), dateTo: iso(prevTo) };
}

/**
 * Las tablas del reporte salen de las mismas consultas validadas que usa
 * `run_widget_query`; el modelo solo elige título, secciones y filtros, nunca
 * escribe cifras. El reporte completo va al cliente en `report`; al modelo
 * solo le vuelven los datos para que redacte el resumen.
 */
async function buildReportTool(input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, REPORT_MAX_TITLE_LENGTH) : "";
  if (!title) throw new Error("title inválido (string no vacío)");
  if (!Array.isArray(raw.sections) || raw.sections.length === 0 || raw.sections.length > REPORT_MAX_SECTIONS) {
    throw new Error(`sections inválido: se esperaban entre 1 y ${REPORT_MAX_SECTIONS} secciones`);
  }

  const skipped: string[] = [];
  const built = await Promise.all(
    raw.sections.map(async (item, i): Promise<ReportSection | null> => {
      const section = (item ?? {}) as Record<string, unknown>;
      const heading = typeof section.heading === "string" ? section.heading.trim().slice(0, REPORT_MAX_TITLE_LENGTH) : "";
      if (!heading) throw new Error(`sections[${i}].heading inválido`);
      try {
        const { data } = (await runWidgetQueryTool(section, tenantId, ctx)) as { data: ReportSection["data"] };
        const groupBy = typeof section.groupBy === "string" ? section.groupBy : undefined;
        const filters = section.filters && typeof section.filters === "object" ? (section.filters as Record<string, unknown>) : undefined;
        const kind: ReportSectionKind = !groupBy ? "kpi" : groupBy === "day" || groupBy === "hour" ? "trend" : "ranking";

        let previous: number | null | undefined;
        const prevRange = kind === "kpi" ? previousPeriod(filters?.dateFrom, filters?.dateTo) : null;
        if (prevRange) {
          // Si la comparación falla, el reporte sigue sin ella en vez de caerse.
          try {
            const prev = (await runWidgetQueryTool({ ...section, filters: { ...filters, ...prevRange } }, tenantId, ctx)) as {
              data: ReportSection["data"];
            };
            previous = prev.data[0]?.value ?? null;
          } catch (err) {
            console.error("[assistant] fallo la comparación con el periodo anterior:", err);
          }
        }

        return {
          kind,
          heading,
          field: section.field as string,
          aggregation: section.aggregation as string,
          groupBy,
          filters,
          data,
          previous,
        };
      } catch (err) {
        // Athena encolada no es un error del pedido: el reporte sale sin esa sección en vez de caerse entero.
        if (err instanceof AthenaTimeoutError) {
          console.error(`[assistant] sección sin datos por timeout: "${heading}"`);
          skipped.push(heading);
          return null;
        }
        throw new Error(`sections[${i}] ("${heading}"): ${err instanceof Error ? err.message : "error desconocido"}`);
      }
    }),
  );
  const sections = built.filter((section): section is ReportSection => section !== null);
  if (sections.length === 0) throw new Error("ninguna sección alcanzó a calcularse: Athena está lenta, probá de nuevo en un momento");

  ctx.report = { title, generatedAt: new Date().toISOString(), sections };
  return {
    ok: true,
    title,
    sections: sections.map((s) => ({ heading: s.heading, data: s.data, previous: s.previous })),
    ...(skipped.length > 0
      ? { skippedSections: skipped, note: `Estas secciones NO están en el reporte por demora del sistema: ${skipped.join(", ")}. Avisale al usuario cuáles faltan y que puede pedirlas de nuevo.` }
      : {}),
  };
}

/**
 * Widget que el asistente propone para el dashboard. El servidor lo valida y lo
 * prueba con una consulta real, pero lo crea el cliente por la ruta normal
 * (`POST /widgets`), que vuelve a validarlo y refresca el tablero.
 */
export type WidgetDraft = {
  name: string;
  visualization: WidgetVisualization;
  metric: { field: string; aggregation: string };
  secondaryMetric?: { field: string; aggregation: string };
  groupBy?: string;
  filters?: { agentId?: string; descriptionContains?: string; paymentMethod?: string };
};

const WIDGET_CLAIM_PATTERN = /(?<![\p{L}])(cre[eé]|cread[oa]s?|agreg[uü]?[eé]|a[nñ]ad[ií]|acabo de (crear|agregar|a[nñ]adir)|ya tengo (ese|este|el) widget)(?![\p{L}])/iu;
const WIDGET_NOUN_PATTERN = /(?<![\p{L}])(widget|gr[aá]fic[ao]|kpi|tarjeta)(?![\p{L}])/iu;

/** ¿El texto afirma haber creado un widget/gráfica? Sirve para detectar un éxito inventado. */
export function claimsWidgetCreated(text: string): boolean {
  return WIDGET_CLAIM_PATTERN.test(text) && WIDGET_NOUN_PATTERN.test(text);
}

const WIDGET_NOT_CREATED_NOTICE =
  "[Sistema] En este turno NO llamaste a create_widget con éxito, así que ningún widget se creó. Si el usuario pidió crear uno, llamá a create_widget ahora (revisá antes list_widgets). Si no podés crearlo, decilo con claridad. No afirmes que lo creaste.";
const WIDGET_NOT_CREATED_FALLBACK =
  "No pude crear el widget: no se llegó a registrar en tu dashboard. Pedímelo de nuevo, por favor, y lo intento otra vez.";

const WIDGET_VISUALIZATIONS: WidgetVisualization[] = ["kpi", "bar", "line", "donut"];
const WIDGET_NAME_MAX_LENGTH = 100;

async function createWidgetTool(input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, WIDGET_NAME_MAX_LENGTH) : "";
  if (!name) throw new Error("name inválido (string no vacío)");
  if (typeof raw.visualization !== "string" || !WIDGET_VISUALIZATIONS.includes(raw.visualization as WidgetVisualization)) {
    throw new Error(`visualization inválida. Válidas: ${WIDGET_VISUALIZATIONS.join(", ")}`);
  }
  const visualization = raw.visualization as WidgetVisualization;

  const { field, aggregation, groupBy, filters, branchLabel } = await parseQueryInput(raw, tenantId, ctx);
  // Mismas reglas que widgets/createHandler.ts: si no se cumplen, el cliente no podría crear el widget.
  if (visualization === "kpi" && groupBy) throw new Error("un widget kpi no admite groupBy: omitilo o elegí bar/line/donut");
  if (visualization !== "kpi" && !groupBy) throw new Error(`un widget ${visualization} necesita groupBy`);
  if (visualization === "line" && !TEMPORAL_FIELDS.includes(groupBy as never)) throw new Error(`un widget line necesita groupBy temporal: ${TEMPORAL_FIELDS.join(", ")}`);
  if (visualization !== "line" && groupBy && TEMPORAL_FIELDS.includes(groupBy as never)) throw new Error("groupBy temporal solo sirve para widgets line");
  if (filters?.dateFrom || filters?.dateTo || filters?.port || filters?.status) {
    throw new Error("los widgets del dashboard solo admiten los filtros branch, descriptionContains y paymentMethod (el rango de fechas lo elige el usuario en el tablero)");
  }

  // Consulta de prueba: valida la combinación de campos y deja ver si el filtro
  // encontró algo, en vez de crear un widget que nace vacío.
  const preview = (await runWidgetQueryTool(raw, tenantId, ctx)) as { data: WidgetDataPoint[] };

  let secondaryMetric: WidgetDraft["secondaryMetric"];
  let secondaryPreview: WidgetDataPoint[] | undefined;
  if (raw.secondaryField !== undefined) {
    if (visualization !== "kpi") throw new Error("secondaryField solo sirve para un widget kpi");
    const secondaryRaw = { ...raw, field: raw.secondaryField, aggregation: raw.secondaryAggregation ?? "sum" };
    const parsed = await parseQueryInput(secondaryRaw, tenantId, ctx);
    secondaryMetric = { field: parsed.field, aggregation: parsed.field === EVENT_COUNT_FIELD ? "count" : parsed.aggregation };
    secondaryPreview = ((await runWidgetQueryTool(secondaryRaw, tenantId, ctx)) as { data: WidgetDataPoint[] }).data;
  }

  const draftFilters: WidgetDraft["filters"] = {
    ...(filters?.agentId ? { agentId: filters.agentId } : {}),
    ...(filters?.descriptionContains ? { descriptionContains: filters.descriptionContains } : {}),
    ...(filters?.paymentMethod ? { paymentMethod: filters.paymentMethod } : {}),
  };
  ctx.widget = {
    name,
    visualization,
    metric: { field, aggregation: field === EVENT_COUNT_FIELD ? "count" : aggregation },
    ...(secondaryMetric ? { secondaryMetric } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(Object.keys(draftFilters).length ? { filters: draftFilters } : {}),
  };
  return {
    ok: true,
    name,
    ...(branchLabel ? { branch: branchLabel } : {}),
    ...(filters?.descriptionContains ? { descriptionContains: filters.descriptionContains } : {}),
    ...(filters?.paymentMethod ? { paymentMethod: filters.paymentMethod } : {}),
    preview: preview.data,
    ...(secondaryPreview ? { secondaryPreview } : {}),
  };
}

type ToolContext = {
  /** Qué widgets ve esta persona (vista propia o compartidos) — para list_widgets. */
  widgetScope?: { userId?: string; ownView: boolean };
  /** Instante (ms epoch) hasta el que las consultas a Athena pueden esperar. */
  deadline?: number;
  /** Moneda de la ficha del negocio (para formatear montos en los análisis calculados por el servidor). */
  currency?: string;
  widget?: WidgetDraft;
  report?: Report;
  timeZone?: string;
  branches?: Promise<Map<string, string>>;
  /** agentId -> nombres con los que un usuario puede referirse a la sucursal (se llena junto con `branches`). */
  branchAliases?: Map<string, { label: string; names: string[] }>;
};

function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Traduce el nombre de sucursal que dijo el usuario al agentId. Primero
 * coincidencia exacta (sin tildes ni mayúsculas) con el nombre mostrado, el
 * nombre del robot o la etiqueta de la ubicación; si no hay, la que lo
 * contenga ("sol" → "TPV Sol"). Si no es única, devuelve un error con las
 * opciones para que el modelo le pregunte al usuario en vez de adivinar.
 */
export function resolveBranch(query: string, aliases: Map<string, { label: string; names: string[] }>): { agentId: string; label: string } {
  const available = [...aliases.values()].map((entry) => entry.label).join(", ");
  if (aliases.size === 0) throw new Error("no hay sucursales registradas para filtrar por branch");
  const q = normalizeName(query);
  const pick = (matches: (names: string[]) => boolean) =>
    [...aliases.entries()].filter(([, entry]) => matches(entry.names.map(normalizeName)));
  let found = pick((names) => names.includes(q));
  if (found.length === 0) found = pick((names) => names.some((name) => name.includes(q)));
  if (found.length === 0) throw new Error(`no existe la sucursal "${query}". Sucursales disponibles: ${available}`);
  if (found.length > 1) {
    throw new Error(`"${query}" coincide con varias sucursales: ${found.map(([, entry]) => entry.label).join(", ")}. Pedile al usuario que elija una.`);
  }
  const [agentId, entry] = found[0];
  return { agentId, label: entry.label };
}

/**
 * agentId -> nombre de la sucursal. El dashboard traduce los UUID de
 * `groupBy: "agent"` en el navegador, pero el asistente solo ve lo que
 * devuelve Athena: sin esto el modelo no tenía forma de nombrar una sucursal
 * y terminaba agrupando por `port` ("TPV-CAJA1"). Usa la etiqueta de la
 * ubicación del robot (el local) y, si no tiene, el nombre del robot; si dos
 * robots comparten etiqueta se desambigua con el nombre del robot.
 * Si la lectura falla, el asistente sigue andando (con los ids crudos).
 */
async function loadBranchNames(tenantId: string, aliases: NonNullable<ToolContext["branchAliases"]>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: AGENTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
      }),
    );
    const agents = ((result.Items as Array<Partial<AgentRecord>> | undefined) ?? []).filter(
      (agent): agent is AgentRecord => typeof agent.agentId === "string",
    );
    const labelOf = (agent: AgentRecord) => agent.location?.label?.trim() || agent.name;
    const labelCount = new Map<string, number>();
    for (const agent of agents) labelCount.set(labelOf(agent), (labelCount.get(labelOf(agent)) ?? 0) + 1);
    for (const agent of agents) {
      const label = labelOf(agent);
      const display = (labelCount.get(label) ?? 0) > 1 && label !== agent.name ? `${label} (${agent.name})` : label;
      names.set(agent.agentId, display);
      aliases.set(agent.agentId, {
        label: display,
        names: [...new Set([display, agent.name, agent.location?.label?.trim()].filter((n): n is string => !!n))],
      });
    }
  } catch (err) {
    console.error("[assistant] no se pudieron leer las sucursales:", err);
  }
  return names;
}

function branchNames(tenantId: string, ctx: ToolContext): Promise<Map<string, string>> {
  ctx.branchAliases ??= new Map();
  ctx.branches ??= loadBranchNames(tenantId, ctx.branchAliases);
  return ctx.branches;
}

async function callTool(name: string, input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  if (name === "build_report") return buildReportTool(input, tenantId, ctx);
  if (name === "run_widget_query") return runWidgetQueryTool(input, tenantId, ctx);
  if (name === "list_tickets") return listTicketsTool(input, tenantId, ctx);
  if (name === "list_widgets") return listWidgetsTool(input, tenantId, ctx.widgetScope);
  if (name === "create_widget") return createWidgetTool(input, tenantId, ctx);
  if (name === "list_matters") return listMattersTool(input, tenantId);
  if (name === "explain_matter") return explainMatterTool(input, tenantId);
  if (name === "analyze_business") {
    return analyzeBusinessTool(input, tenantId, {
      timeZone: ctx.timeZone,
      currency: ctx.currency,
      deadline: ctx.deadline,
      branchNames: () => branchNames(tenantId, ctx),
      resolveBranch: async (query) => {
        await branchNames(tenantId, ctx);
        return resolveBranch(query, ctx.branchAliases ?? new Map());
      },
    });
  }
  throw new Error(`herramienta desconocida: "${name}"`);
}

type HistoryTurn = { role: "user" | "assistant"; text: string };
type Validation =
  | { ok: true; question: string; history: HistoryTurn[]; timeZone?: string; matterId?: string }
  | { ok: false; error: string };

// Memoria de conversación acotada: el cliente manda los últimos intercambios
// (los mismos que ya muestra en pantalla), el servidor los antepone al
// mensaje nuevo. A propósito NO viajan resultados de herramientas de turnos
// anteriores — cada pregunta nueva vuelve a consultar datos frescos en vez
// de confiar en un número que pudo haber cambiado desde entonces.
const MAX_HISTORY_TURNS = 6;
// Las respuestas del asistente (rol "assistant") pueden ser largas — análisis
// con listas, reportes — y el cliente las reenvía tal cual. Rechazarlas por
// pasar el tope de las preguntas rompía toda la conversación; se recortan.
const MAX_HISTORY_ASSISTANT_TEXT_LENGTH = 2000;

function validateHistory(raw: unknown): { ok: true; history: HistoryTurn[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, history: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "history inválida, se esperaba un array" };
  if (raw.length > MAX_HISTORY_TURNS) {
    return { ok: false, error: `history demasiado larga (máx ${MAX_HISTORY_TURNS} mensajes)` };
  }

  const history: HistoryTurn[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: `history[${i}] inválido` };
    }
    const { role, text } = item as Record<string, unknown>;
    // Bedrock exige que los mensajes alternen empezando por "user" — se
    // valida acá para no dejar que un history mal armado le llegue a la API.
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (role !== expectedRole) {
      return { ok: false, error: `history[${i}].role inválido, se esperaba "${expectedRole}" (debe alternar empezando por "user")` };
    }
    const maxLength = role === "assistant" ? Infinity : MAX_QUESTION_LENGTH;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > maxLength) {
      return { ok: false, error: `history[${i}].text inválido` };
    }
    history.push({ role: role as "user" | "assistant", text: text.trim().slice(0, role === "assistant" ? MAX_HISTORY_ASSISTANT_TEXT_LENGTH : MAX_QUESTION_LENGTH) });
  }
  return { ok: true, history };
}

function validateBody(body: unknown): Validation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  const question = b.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { ok: false, error: "question inválida (string no vacío)" };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `question demasiado larga (máx ${MAX_QUESTION_LENGTH} caracteres)` };
  }

  const historyValidation = validateHistory(b.history);
  if (!historyValidation.ok) {
    return { ok: false, error: historyValidation.error };
  }

  // Opcional: el navegador manda su zona IANA. Una inválida se ignora (UTC) en vez de rechazar la pregunta.
  const timeZone = typeof b.timeZone === "string" && isValidTimeZone(b.timeZone) ? b.timeZone : undefined;

  // Opcional: id público de un aviso (Innova "Preguntar"). Inválido → 400, no se ignora en silencio.
  let matterId: string | undefined;
  if (b.matterId !== undefined) {
    if (typeof b.matterId !== "string" || !internalMatterId(b.matterId.trim())) {
      return { ok: false, error: "matterId inválido" };
    }
    matterId = b.matterId.trim();
  }

  return { ok: true, question: question.trim(), history: historyValidation.history, timeZone, matterId };
}

/**
 * Único registro de auditoría de una pregunta respondida — hasta ahora solo
 * logueábamos errores, nunca una respuesta normal (sección 13 de
 * PROYECTO.md). Una línea JSON por pregunta: sirve para revisar calidad de
 * respuestas, ver qué preguntan de verdad los negocios, y detectar un uso
 * anómalo de un tenant antes de que aparezca en la factura de Bedrock/Athena
 * (complementa al rate limit, que solo frena el caso extremo). Va a
 * CloudWatch Logs sin infraestructura nueva — retención acotada a propósito
 * en el stack (ver `AssistantAskFunction` en el CDK), porque esto guarda
 * contenido real de negocio (montos, productos), no solo metadata técnica.
 *
 * `toolCalls` lleva el input que armó el modelo y, si falló, el error que
 * recibió de vuelta — con solo el nombre de la herramienta (antes
 * `toolsUsed`) no había forma de saber desde este log por qué una
 * respuesta salió sin datos (caso "ventas de octubre" del 2026-10-16:
 * dos consultas fallidas que solo se veían cruzando con los console.error).
 */
type ToolCallLog = { name: string; input: unknown; error?: string };

function logQa(entry: {
  tenantId: string;
  question: string;
  answer: string;
  toolCalls: ToolCallLog[];
  turns: number;
  historyTurns: number;
}): void {
  console.log(JSON.stringify({ event: "assistant_qa", timestamp: new Date().toISOString(), ...entry }));
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) {
    return jsonResponse(403, { error: "no autenticado" });
  }
  const tenantId = tenant.tenantId;
  const userId = resolveUserIdFromEvent(event);
  const widgetScope = { userId, ownView: userViewFor(tenant, userId) !== undefined };

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error });
  }

  // Chequeo barato (una escritura condicional a DynamoDB) antes de gastar
  // en Bedrock/Athena — ver rateLimit.ts para el motivo (este endpoint no
  // tiene api-key, así que el usage plan de API Gateway no lo protege).
  const rateLimit = await checkAssistantRateLimit(tenantId);
  if (!rateLimit.ok) {
    const message =
      rateLimit.reason === "minute"
        ? "Estás preguntando muy rápido, esperá un momento antes de volver a intentar."
        : "Llegaste al límite de preguntas de hoy para el asistente, probá de nuevo mañana.";
    return jsonResponse(429, { error: message });
  }

  // Ficha mínima + zona del negocio (nombre, sucursales). La zona del navegador queda de respaldo.
  const business = await loadAskBusinessContext(tenantId);
  const timeZone = business.timeZone ?? validation.timeZone;
  const zoneOwner: PromptZoneOwner = business.timeZone ? "business" : timeZone ? "user" : "utc";

  const modelId = process.env.BEDROCK_MODEL_ID!;
  const systemPrompt = buildSystemPrompt(new Date(), timeZone, zoneOwner, business);
  const tools = buildTools();
  // Si la UI manda matterId (botón Preguntar), el modelo debe explicar ese aviso
  // con explain_matter: el prefijo no se guarda en el history del cliente.
  const userQuestion = validation.matterId
    ? `[Contexto interno: el usuario se refiere al aviso matterId="${validation.matterId}". Llamá explain_matter con ese matterId antes de responder.]\n${validation.question}`
    : validation.question;
  const messages: Message[] = [
    ...validation.history.map((turn): Message => ({ role: turn.role, content: [{ text: turn.text }] })),
    { role: "user", content: [{ text: userQuestion }] },
  ];
  // Para el log de auditoría al final — qué herramientas se invocaron y con
  // qué input, sin importar si tuvieron éxito (un intento de herramienta
  // inexistente también es una señal útil, ver logQa()).
  const toolCalls: ToolCallLog[] = [];
  let widgetRetried = false;
  const startedAt = Date.now();
  const toolContext: ToolContext = { widgetScope, timeZone, currency: business.profile?.currency, deadline: startedAt + TOOL_DEADLINE_MS };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: systemPrompt }],
          messages,
          toolConfig: { tools },
          // Acotado a propósito (costo/latencia) — sección 10.1 de PROYECTO.md
          // ya mostró lo rápido que un costo "chico" escala sin límites explícitos.
          inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
        }),
        // Si ya no queda margen antes del corte de API Gateway, se corta acá y se contesta con un mensaje claro.
        { abortSignal: AbortSignal.timeout(Math.max(1_000, REQUEST_BUDGET_MS - (Date.now() - startedAt))) },
      );

      const outputMessage = response.output?.message;
      if (!outputMessage) {
        return jsonResponse(502, { error: "el modelo no devolvió respuesta" });
      }
      messages.push(outputMessage);

      if (response.stopReason !== "tool_use") {
        let text = outputMessage.content?.find((block) => typeof block.text === "string")?.text;
        if (!text) {
          return jsonResponse(502, { error: "el modelo no devolvió respuesta" });
        }
        // El modelo a veces copia del historial su "Listo, creé el widget" sin llamar a create_widget.
        // Si afirma haberlo creado y no hay borrador, se le corrige una vez; si insiste, se reemplaza el texto.
        if (!toolContext.widget && claimsWidgetCreated(text)) {
          if (!widgetRetried) {
            widgetRetried = true;
            messages.push({ role: "user", content: [{ text: WIDGET_NOT_CREATED_NOTICE }] });
            continue;
          }
          text = WIDGET_NOT_CREATED_FALLBACK;
        }
        logQa({ tenantId, question: validation.question, answer: text, toolCalls, turns: turn + 1, historyTurns: validation.history.length });
        const widgetPart = toolContext.widget ? { widget: toolContext.widget } : {};
        if (!toolContext.report) return jsonResponse(200, { answer: text, ...widgetPart });
        // Si guardar falla, el reporte igual le llega al cliente (descargable en el momento), solo que no queda en "Reportes".
        let reportId: string | undefined;
        try {
          reportId = (await saveReport(tenantId, text, toolContext.report)).reportId;
        } catch (err) {
          console.error("[assistant] no se pudo guardar el reporte:", err);
        }
        return jsonResponse(200, { answer: text, report: toolContext.report, reportId, ...widgetPart });
      }

      const toolUseBlocks = (outputMessage.content ?? []).filter((block) => block.toolUse);
      const toolResultContent: ContentBlock[] = await Promise.all(
        toolUseBlocks.map(async (block): Promise<ContentBlock> => {
          const toolUse = block.toolUse!;
          const callLog: ToolCallLog = { name: toolUse.name ?? "(sin nombre)", input: toolUse.input };
          toolCalls.push(callLog);
          try {
            const result = await callTool(toolUse.name ?? "", toolUse.input, tenantId, toolContext);
            return {
              toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: result as Record<string, unknown> }] },
            } as ContentBlock;
          } catch (err) {
            console.error(`[assistant] fallo la herramienta "${toolUse.name}":`, err);
            callLog.error = err instanceof Error ? err.message : "error desconocido";
            return {
              toolResult: {
                toolUseId: toolUse.toolUseId,
                content: [{ text: callLog.error }],
                status: "error" as const,
              },
            } as ContentBlock;
          }
        }),
      );

      messages.push({ role: "user", content: toolResultContent });
    }

    return jsonResponse(502, { error: "el asistente no pudo resolver la pregunta, probá reformularla" });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      console.error("[assistant] se agotó el tiempo de la solicitud:", err);
      return jsonResponse(504, { error: "La consulta tardó más de lo esperado. Probá de nuevo en unos segundos." });
    }
    console.error("[assistant] fallo al invocar Bedrock:", err);
    return jsonResponse(502, { error: "no se pudo generar una respuesta, probá de nuevo en unos segundos" });
  }
}
