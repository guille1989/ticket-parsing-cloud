/*
 * Reprocesa un ticket que ya existe (típicamente uno en `status: "failed"`)
 * con la lógica de parseo ACTUAL — útil después de arreglar un bug de
 * parser/prompt, para recuperar ventas reales sin depender de que el
 * agente las vuelva a subir. Llama a la misma función que usa el Lambda
 * (`reprocessTicket`), así que hace exactamente lo mismo: determinístico →
 * fallback de texto/imagen con Bedrock → coherencia → actualiza el ticket.
 * Corre localmente contra los recursos reales (Dynamo/S3/Bedrock) — no
 * hace falta desplegar el Lambda para probar un fix de prompt/parser.
 *
 * OJO doble conteo: si ese mismo contenido ya se subió de nuevo por otro
 * lado (ej. una prueba manual con `etapa-a-ocr.ts`) y ese otro ticket
 * quedó bien parseado, reprocesar este ticket original crea una SEGUNDA
 * venta "buena" para la misma transacción física. El script no lo detecta
 * solo — revisar a mano antes de reprocesar un ticket viejo.
 *
 * Uso:
 *   npm run reparse-ticket -- <tenantId> <ticketId>
 */

// Los módulos que se importan más abajo leen esto en su nivel de módulo
// (ver `shared/dynamo.ts`) — por eso se setea ANTES del import dinámico,
// no alcanza con setearlo en `main()` si el import fuera estático.
process.env.TICKETS_TABLE ??= "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
process.env.TENANTS_TABLE ??= "TicketParsingCloudStack-TenantsTableB701DC57-1WW7ZMLRMWYTV";
process.env.RAW_BUCKET ??= "ticketparsingcloudstack-rawticketsbucket6ab163e9-gozelnd9h2h9";
process.env.ANALYTICS_BUCKET ??= "ticketparsingcloudstack-analyticsbucket39eaaeea-sw6jw1e3882n";
process.env.BEDROCK_MODEL_ID ??= "us.anthropic.claude-haiku-4-5-20251001-v1:0";

async function main(): Promise<void> {
  const [tenantId, ticketId] = process.argv.slice(2);
  if (!tenantId || !ticketId) {
    console.error("uso: npm run reparse-ticket -- <tenantId> <ticketId>");
    process.exit(1);
  }

  const { GetCommand, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const { reprocessTicket } = await import("../src/parser/handler.js");
  const { ddb, TICKETS_TABLE } = await import("../src/shared/dynamo.js");
  type TicketRecord = import("../src/shared/types.js").TicketRecord;
  type ParseJobMessage = import("../src/shared/types.js").ParseJobMessage;

  // Se busca por ticketId porque no sabemos `capturedAt` de antemano (es
  // parte de la sort key) — un scan filtrado es aceptable acá, esto es una
  // herramienta manual de uso ocasional, no un path caliente.
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TICKETS_TABLE,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "ticketId = :ticketId",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":ticketId": ticketId },
    }),
  );
  const item = Items?.[0] as TicketRecord | undefined;
  if (!item) {
    console.error(`no se encontró el ticket ${ticketId} para el tenant ${tenantId}`);
    process.exit(1);
  }

  console.log(
    "antes:",
    JSON.stringify({ status: item.status, failReason: item.failReason, total: item.total, items: item.items }, null, 2),
  );

  const message: ParseJobMessage = {
    tenantId: item.tenantId,
    ticketId: item.ticketId,
    capturedAt: item.capturedAt,
    rawS3Key: item.rawS3Key,
    port: item.port,
    rawKind: item.rawKind,
  };

  await reprocessTicket(message);

  const { Item: after } = await ddb.send(
    new GetCommand({ TableName: TICKETS_TABLE, Key: { pk: `TENANT#${tenantId}`, sk: `TICKET#${item.capturedAt}#${ticketId}` } }),
  );
  console.log(
    "\ndespués:",
    JSON.stringify(
      {
        status: after?.status,
        parsedBy: after?.parsedBy,
        failReason: after?.failReason,
        total: after?.total,
        tax: after?.tax,
        items: after?.items,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
