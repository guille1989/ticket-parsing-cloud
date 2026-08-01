import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";

import { TicketParsingCloudStack } from "../lib/ticket-parsing-cloud-stack";

test("el stack sintetiza con las piezas clave del pipeline multi-tenant", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::DynamoDB::GlobalTable", 5); // Tickets + Tenants + Widgets + Agents + ActivationCodes
  template.resourceCountIs("AWS::SQS::Queue", 1); // solo la DLQ del parseo — el trigger es el Stream, no una cola
  template.resourceCountIs("AWS::Lambda::Function", 11); // ingest + parser + read + 5 de widgets + 3 de agents (activate/list/codes)
  template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1); // parser suscripto al Stream de Tickets
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);

  // El agente sube tickets con SU api-key (o la del tenant, fallback legacy).
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "POST",
    ApiKeyRequired: true,
  });
  // El código de activación ES la credencial — el único POST público de
  // toda la API (ver agents/activateHandler.ts).
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "POST",
    ApiKeyRequired: false,
  });
  // Todo lo que usa el dashboard (lecturas + crear/borrar widgets) exige
  // un usuario de Cognito logueado, no una api-key — ver el comentario
  // sobre `userPool` en el stack.
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "GET",
    AuthorizationType: "COGNITO_USER_POOLS",
  });
});

test("la tabla Tickets tiene el Stream habilitado, único disparador del parseo", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  // WidgetsTable también tiene sort key "sk" (ver ticket-parsing-cloud-stack.ts),
  // así que "tiene sk" ya no alcanza para identificar sin ambigüedad a
  // Tickets — se busca directo por quién tiene el Stream habilitado, que
  // es único de esa tabla.
  const tables = template.findResources("AWS::DynamoDB::GlobalTable");
  const ticketsTable = Object.values(tables).find((t: any) => t.Properties?.StreamSpecification);
  expect(ticketsTable?.Properties?.StreamSpecification).toEqual(
    expect.objectContaining({ StreamViewType: "NEW_IMAGE" }),
  );
});

// Regresión puntual: si alguien vuelve a agregar `apiKeyRequired: true` a
// una ruta GET del dashboard (por copiar/pegar el patrón viejo de
// /tickets), este test lo detecta — ninguna lectura humana debería volver
// a aceptar la api-key compartida del tenant.
test("ningún método GET del dashboard quedó con auth por api-key en vez de Cognito", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  const methods = template.findResources("AWS::ApiGateway::Method");
  const getMethods = Object.values(methods).filter((m: any) => m.Properties?.HttpMethod === "GET");

  expect(getMethods.length).toBeGreaterThan(0);
  getMethods.forEach((m: any) => {
    expect(m.Properties?.AuthorizationType).toBe("COGNITO_USER_POOLS");
    expect(m.Properties?.ApiKeyRequired).not.toBe(true);
  });
});
