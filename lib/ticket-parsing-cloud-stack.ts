import * as cdk from "aws-cdk-lib/core";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * Todo el sistema es serverless a propósito: el tráfico real (unos pocos
 * negocios, cientos de tickets por día cada uno) es bajo y en horario
 * comercial — no tiene sentido pagar por infraestructura siempre prendida.
 *
 * Flujo: API Gateway (auth por API key, una por tenant) → Lambda ingest
 * (guarda crudo en S3, escribe el ticket "pending" en DynamoDB con una
 * escritura condicional para que reintentos con el mismo ticketId no
 * dupliquen nada, responde rápido sin esperar el parseo) → el Stream de la
 * tabla Tickets dispara el Lambda parser automáticamente apenas ese ticket
 * queda escrito (resuelve qué parser usa el tenant, parsea, actualiza
 * DynamoDB) → DLQ si falla de forma persistente.
 *
 * Deliberadamente NO se usa una cola SQS intermedia para disparar el
 * parseo: si el ingest mandara el mensaje a SQS como paso separado después
 * de escribir en DynamoDB, un fallo justo entre esos dos pasos dejaría el
 * ticket en "pending" para siempre, sin nada que lo reintente del lado
 * servidor. Con el Stream, el disparo del parseo es una consecuencia
 * directa y garantizada de la escritura en DynamoDB — no hay paso
 * intermedio que pueda fallar por separado.
 */
export class TicketParsingCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- Almacenamiento -----------------------------------------------

    const rawTicketsBucket = new s3.Bucket(this, "RawTicketsBucket", {
      lifecycleRules: [{ transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) }] }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const ticketsTable = new dynamodb.TableV2(this, "TicketsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: "status-index",
          partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
        },
      ],
      // Dispara el parseo: el Lambda parser se suscribe a este stream en
      // vez de depender de que `ingest` mande un mensaje a SQS aparte.
      dynamoStream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    const tenantsTable = new dynamodb.TableV2(this, "TenantsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: "apiKeyId-index",
          partitionKey: { name: "apiKeyId", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---- Destino de fallos del parseo ------------------------------------

    // Ya no es la DLQ de una cola SQS — es el "onFailure" del event source
    // mapping del Stream: acá caen los batches que el parser no pudo
    // procesar después de agotar los reintentos, para inspeccionar a mano.
    const parseDlq = new sqs.Queue(this, "ParseDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(14),
    });

    // ---- Lambdas -----------------------------------------------------

    const sharedBundling = { externalModules: ["@aws-sdk/*"] };
    const nodeRuntime = lambda.Runtime.NODEJS_20_X;

    /**
     * Segundo intento de parseo cuando el parser determinístico del tenant
     * no reconoce el formato — ver `parser/handler.ts` y
     * `parsing/bedrockFallback.ts`. Habilitado a mano en Model Access de
     * Bedrock (us-east-1) antes de este deploy; no hay forma de pedir ese
     * acceso por CDK.
     *
     * Este modelo no admite invocación on-demand por su model ID base —
     * Bedrock lo rechaza con "Invocation of model ID ... with on-demand
     * throughput isn't supported" y pide el inference profile en su lugar.
     * El profile "us." puede despachar a us-east-1/us-east-2/us-west-2, así
     * que el permiso de IAM de abajo cubre el profile y las tres regiones.
     */
    const bedrockBaseModelId = "anthropic.claude-haiku-4-5-20251001-v1:0";
    const bedrockModelId = `us.${bedrockBaseModelId}`;

    const ingestFn = new nodejs.NodejsFunction(this, "IngestFunction", {
      entry: "src/ingest/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TICKETS_TABLE: ticketsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        RAW_BUCKET: rawTicketsBucket.bucketName,
      },
    });

    const parserFn = new nodejs.NodejsFunction(this, "ParserFunction", {
      entry: "src/parser/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      // Con el fallback de Bedrock, un batch de 10 tickets que fallan el
      // parseo determinístico puede terminar haciendo hasta 10 invocaciones
      // secuenciales al modelo — 20s se quedaba corto para ese caso.
      timeout: cdk.Duration.seconds(60),
      environment: {
        TICKETS_TABLE: ticketsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        RAW_BUCKET: rawTicketsBucket.bucketName,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
    });

    const readFn = new nodejs.NodejsFunction(this, "ReadFunction", {
      entry: "src/read/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TICKETS_TABLE: ticketsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
      },
    });

    // TableV2 (Global Tables) todavía no expone `grantStreamRead` como la
    // `Table` clásica, así que se le dan los permisos de lectura del stream
    // a mano — son los mismos que ese helper generaría.
    parserFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"],
        resources: [ticketsTable.tableStreamArn!],
      }),
    );

    // Se necesita permiso sobre el inference profile (el recurso que de
    // hecho se invoca, sí es de esta cuenta) Y sobre el foundation model
    // base en cada región a la que el profile "us." puede despachar (esas
    // sí son un recurso compartido de la cuenta de servicio de Bedrock, sin
    // account ID en el ARN) — si falta cualquiera de los dos, Bedrock
    // rechaza la invocación según a qué región termine ruteando.
    parserFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${bedrockModelId}`,
          `arn:aws:bedrock:us-east-1::foundation-model/${bedrockBaseModelId}`,
          `arn:aws:bedrock:us-east-2::foundation-model/${bedrockBaseModelId}`,
          `arn:aws:bedrock:us-west-2::foundation-model/${bedrockBaseModelId}`,
        ],
      }),
    );

    // Los modelos de Anthropic en Bedrock se distribuyen vía una
    // suscripción de AWS Marketplace por detrás — sin esto, InvokeModel
    // rechaza con "AccessDeniedException: ... aws-marketplace:ViewSubscriptions,
    // aws-marketplace:Subscribe ..." bajo ráfagas de llamadas seguidas
    // (se vio recién al mandar varios tickets juntos). Son acciones de
    // entitlement a nivel de cuenta, no de un recurso puntual — de ahí el "*".
    parserFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
        resources: ["*"],
      }),
    );

    new lambda.EventSourceMapping(this, "ParserStreamSource", {
      target: parserFn,
      eventSourceArn: ticketsTable.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 5,
      // El handler filtra por eventName/status — más simple y robusto que
      // depender de la sintaxis de filtros de event source, y a este
      // volumen la invocación de más no cuesta nada.
      onFailure: new destinations.SqsDestination(parseDlq),
      reportBatchItemFailures: true,
    });

    rawTicketsBucket.grantWrite(ingestFn);
    rawTicketsBucket.grantRead(parserFn);
    ticketsTable.grantWriteData(ingestFn);
    ticketsTable.grantReadWriteData(parserFn);
    ticketsTable.grantReadData(readFn);
    tenantsTable.grantReadData(ingestFn);
    tenantsTable.grantReadData(parserFn);
    tenantsTable.grantReadData(readFn);

    // ---- API Gateway: una API key por tenant --------------------------

    const api = new apigateway.RestApi(this, "TicketIngestApi", {
      description: "Ingesta (POST) y consulta (GET) de tickets de print-capture-agent, uno por tenant vía API key.",
      deployOptions: { throttlingRateLimit: 50, throttlingBurstLimit: 20 },
    });

    const tickets = api.root.addResource("tickets");
    tickets.addMethod("POST", new apigateway.LambdaIntegration(ingestFn), {
      apiKeyRequired: true,
    });
    tickets.addMethod("GET", new apigateway.LambdaIntegration(readFn), {
      apiKeyRequired: true,
    });

    const usagePlan = api.addUsagePlan("DefaultUsagePlan", {
      throttle: { rateLimit: 10, burstLimit: 5 },
      quota: { limit: 10_000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ---- Outputs -------------------------------------------------------

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "UsagePlanId", { value: usagePlan.usagePlanId });
    new cdk.CfnOutput(this, "TicketsTableName", { value: ticketsTable.tableName });
    new cdk.CfnOutput(this, "TenantsTableName", { value: tenantsTable.tableName });
    new cdk.CfnOutput(this, "RawTicketsBucketName", { value: rawTicketsBucket.bucketName });
  }
}
