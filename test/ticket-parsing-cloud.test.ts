import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";

import { TicketParsingCloudStack } from "../lib/ticket-parsing-cloud-stack";

test("el stack sintetiza con las piezas clave del pipeline multi-tenant", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::DynamoDB::GlobalTable", 8); // Tickets + Tenants + Widgets + Agents + ActivationCodes + Reports + AssistantUsage + SignupUsage
  template.resourceCountIs("AWS::SQS::Queue", 2); // DLQ del parseo + DLQ de la sincronización analítica — el trigger es el Stream, no una cola
  template.resourceCountIs("AWS::Lambda::Function", 24); // pipeline + reportes guardados (3) + + dashboard + agentes + auth + perfil/onboarding + revisión de tickets + imagen de ticket
  template.resourceCountIs("AWS::Lambda::EventSourceMapping", 2); // parser + sincronización analítica, ambos suscriptos al Stream de Tickets
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);

  // El agente sube tickets con SU api-key (o la del tenant, fallback legacy).
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "POST",
    ApiKeyRequired: true,
  });
  // Los dos POST públicos de la API: el código de activación ES la
  // credencial (agents/activateHandler.ts) y el registro de un tenant
  // nuevo, que todavía no tiene ninguna (signup/handler.ts).
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
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "PATCH",
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

test("cada ruta Cognito puede verificar el estado actual del tenant con GetItem", () => {
  const stack = new TicketParsingCloudStack(new cdk.App(), "TenantAccessStack");
  const template = Template.fromStack(stack);
  const resources = template.toJSON().Resources as Record<string, any>;
  const tenantTableId = Object.keys(resources).find((id) => id.startsWith("TenantsTable") && resources[id].Type === "AWS::DynamoDB::GlobalTable");
  expect(tenantTableId).toBeDefined();

  const humanMethods = Object.values(resources).filter((resource) =>
    resource.Type === "AWS::ApiGateway::Method" && resource.Properties?.AuthorizationType === "COGNITO_USER_POOLS",
  );
  expect(humanMethods).toHaveLength(17);
  for (const method of humanMethods) {
    const uriParts = method.Properties.Integration.Uri["Fn::Join"][1];
    const functionId = uriParts.find((part: any) => part?.["Fn::GetAtt"]?.[1] === "Arn")?.["Fn::GetAtt"][0];
    expect(functionId).toBeDefined();
    const fn = resources[functionId];
    expect(fn.Properties.Environment.Variables.TENANTS_TABLE).toEqual({ Ref: tenantTableId });

    const roleId = fn.Properties.Role["Fn::GetAtt"][0];
    const policies = Object.values(resources).filter((resource) =>
      resource.Type === "AWS::IAM::Policy" && resource.Properties.Roles?.some((role: any) => role.Ref === roleId),
    );
    const canReadTenant = policies.some((policy) => policy.Properties.PolicyDocument.Statement.some((statement: any) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      const targets = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      return statement.Effect === "Allow" && actions.includes("dynamodb:GetItem") &&
        targets.some((target: any) => target?.["Fn::GetAtt"]?.[0] === tenantTableId && target["Fn::GetAtt"][1] === "Arn");
    }));
    expect({ functionId, canReadTenant }).toEqual({ functionId, canReadTenant: true });
  }
});

// La analítica tiene un único escritor recuperable: el consumidor del Stream.
test("la sincronización analítica sigue el Stream con filtro de tickets, reintentos y DLQ con alarma", () => {
  const template = Template.fromStack(new TicketParsingCloudStack(new cdk.App(), "TestStack"));

  const mappings = Object.values(template.findResources("AWS::Lambda::EventSourceMapping")) as any[];
  const sync = mappings.find((m) => m.Properties.FilterCriteria);
  expect(sync).toBeDefined();
  expect(sync.Properties.FilterCriteria.Filters).toEqual([
    { Pattern: JSON.stringify({ dynamodb: { Keys: { sk: { S: [{ prefix: "TICKET#" }] } } } }) },
  ]);
  expect(sync.Properties).toMatchObject({
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    MaximumRetryAttempts: 10,
    MaximumRecordAgeInSeconds: 21600,
    StartingPosition: "LATEST",
  });
  expect(sync.Properties.DestinationConfig.OnFailure.Destination).toBeDefined();

  // Alarma: cualquier mensaje en la DLQ significa estadísticas pendientes de recuperar.
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    MetricName: "ApproximateNumberOfMessagesVisible",
    Namespace: "AWS/SQS",
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
  });
});

test("solo el consumidor de sincronización escribe en el bucket de analítica (ni el parser ni la revisión)", () => {
  const template = Template.fromStack(new TicketParsingCloudStack(new cdk.App(), "TestStack"));
  const functions = template.findResources("AWS::Lambda::Function");
  const withAnalyticsEnv = Object.entries(functions)
    .filter(([, fn]: [string, any]) => fn.Properties?.Environment?.Variables?.ANALYTICS_BUCKET)
    .map(([id]) => id);

  // Lectura para Athena (widgets/asistente) también inyecta el bucket; lo que no puede
  // tener es el parser ni la revisión.
  expect(withAnalyticsEnv.some((id) => id.startsWith("ParserFunction"))).toBe(false);
  expect(withAnalyticsEnv.some((id) => id.startsWith("ReviewFunction"))).toBe(false);
  expect(withAnalyticsEnv.some((id) => id.startsWith("AnalyticsSyncFunction"))).toBe(true);
});
