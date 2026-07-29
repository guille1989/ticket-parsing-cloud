import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";

import { TicketParsingCloudStack } from "../lib/ticket-parsing-cloud-stack";

test("el stack sintetiza con las piezas clave del pipeline multi-tenant", () => {
  const app = new cdk.App();
  const stack = new TicketParsingCloudStack(app, "TestStack");
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::DynamoDB::GlobalTable", 2);
  template.resourceCountIs("AWS::SQS::Queue", 1); // solo la DLQ del parseo — el trigger es el Stream, no una cola
  template.resourceCountIs("AWS::Lambda::Function", 3); // ingest + parser + read
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

  const tables = template.findResources("AWS::DynamoDB::GlobalTable");
  const ticketsTable = Object.values(tables).find((t: any) =>
    t.Properties?.KeySchema?.some((k: any) => k.AttributeName === "sk"),
  );
  expect(ticketsTable?.Properties?.StreamSpecification).toEqual(
    expect.objectContaining({ StreamViewType: "NEW_IMAGE" }),
  );
});
