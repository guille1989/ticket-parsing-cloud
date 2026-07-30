import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";

import { TicketParsingCloudStack } from "../lib/ticket-parsing-cloud-stack";

test("el stack sintetiza con las piezas clave del pipeline multi-tenant", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::DynamoDB::GlobalTable", 3); // Tickets + Tenants + Widgets
  template.resourceCountIs("AWS::SQS::Queue", 1); // solo la DLQ del parseo — el trigger es el Stream, no una cola
  template.resourceCountIs("AWS::Lambda::Function", 8); // ingest + parser + read + 5 de widgets (create/list/delete/fields/data)
  template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1); // parser suscripto al Stream de Tickets

  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "POST",
    ApiKeyRequired: true,
  });
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "GET",
    ApiKeyRequired: true,
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
