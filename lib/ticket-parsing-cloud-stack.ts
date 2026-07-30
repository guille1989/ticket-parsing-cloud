import * as cdk from "aws-cdk-lib/core";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as athena from "aws-cdk-lib/aws-athena";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as glue from "aws-cdk-lib/aws-glue";
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

    // Widgets: PK = TENANT#<id>, SK = WIDGET#<widgetId> — es config del
    // dashboard (qué campo/agregación/agrupación eligió el usuario), no
    // datos de negocio, por eso vive acá y no en la capa de analítica.
    // Un `Query` con `begins_with(sk, "WIDGET#")` alcanza para listar los
    // de un tenant, no hace falta un GSI.
    const widgetsTable = new dynamodb.TableV2(this, "WidgetsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    });

    // ---- Analítica: copia aplanada en S3 para consultar con Athena -----
    //
    // DynamoDB sigue siendo la fuente de verdad operacional (escritura
    // idempotente, el Stream que dispara todo, lookups rápidos por ticket).
    // Esto es un espejo de solo lectura, una fila por ítem (no por ticket),
    // para poder correr SQL tipo `SUM(subtotal) WHERE description = 'X'`
    // cruzando todos los tickets — algo que DynamoDB no hace bien con
    // `items` anidado dentro de un solo registro. Lo escribe
    // `parser/handler.ts` como paso best-effort, después de guardar en
    // DynamoDB — ver `analytics/writeAnalyticsRows.ts`.

    const analyticsBucket = new s3.Bucket(this, "AnalyticsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Bucket de resultados de consultas — Athena lo exige, no es opcional.
    // Los resultados son descartables (se pueden volver a generar
    // corriendo la consulta de nuevo), por eso la expiración corta.
    const athenaResultsBucket = new s3.Bucket(this, "AthenaResultsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    const analyticsDatabaseName = "ticket_analytics";
    const analyticsTableName = "ticket_items";

    const analyticsDatabase = new glue.CfnDatabase(this, "AnalyticsDatabase", {
      catalogId: this.account,
      databaseInput: { name: analyticsDatabaseName },
    });

    // Partition projection en vez de un Glue Crawler: Athena calcula las
    // particiones (tenant/año/mes/día) a partir del patrón de abajo, sin
    // nada corriendo programado que las descubra — coherente con el resto
    // del sistema, serverless de verdad, sin infraestructura siempre
    // prendida.
    const analyticsTable = new glue.CfnTable(this, "AnalyticsTable", {
      catalogId: this.account,
      databaseName: analyticsDatabaseName,
      tableInput: {
        name: analyticsTableName,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          EXTERNAL: "TRUE",
          "projection.enabled": "true",
          "projection.tenant.type": "injected",
          "projection.year.type": "integer",
          "projection.year.range": "2024,2035",
          "projection.month.type": "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type": "integer",
          "projection.day.range": "1,31",
          "projection.day.digits": "2",
          "storage.location.template": `s3://${analyticsBucket.bucketName}/tenant=\${tenant}/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: [
          { name: "tenant", type: "string" },
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
        storageDescriptor: {
          location: `s3://${analyticsBucket.bucketName}/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: { serializationLibrary: "org.openx.data.jsonserde.JsonSerDe" },
          columns: [
            { name: "tenantid", type: "string" },
            { name: "ticketid", type: "string" },
            { name: "capturedat", type: "string" },
            { name: "port", type: "string" },
            { name: "status", type: "string" },
            { name: "parsedby", type: "string" },
            { name: "description", type: "string" },
            { name: "quantity", type: "double" },
            { name: "unitprice", type: "double" },
            { name: "subtotal", type: "double" },
            { name: "voided", type: "boolean" },
            { name: "discount", type: "double" },
            { name: "tip", type: "double" },
            { name: "total", type: "double" },
          ],
        },
      },
    });
    analyticsTable.addDependency(analyticsDatabase);

    // Sin esto, cada consulta ad-hoc en la consola de Athena obliga a
    // configurar a mano dónde guardar resultados antes de poder correrla.
    const athenaWorkGroupName = "ticket-analytics";
    new athena.CfnWorkGroup(this, "AnalyticsWorkGroup", {
      name: athenaWorkGroupName,
      workGroupConfiguration: {
        resultConfiguration: { outputLocation: `s3://${athenaResultsBucket.bucketName}/query-results/` },
      },
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
        ANALYTICS_BUCKET: analyticsBucket.bucketName,
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

    // ---- Widgets: motor de gráficos configurables por el usuario -------
    //
    // Create/List/Delete solo tocan DynamoDB (Widgets/Tenants) — el mismo
    // perfil de permisos que el resto de la API. Data es el único que
    // necesita Athena/Glue/S3, así que queda separado para no darle esos
    // permisos de más a los otros tres (principio de menor privilegio).

    const widgetsEnv = { WIDGETS_TABLE: widgetsTable.tableName, TENANTS_TABLE: tenantsTable.tableName };

    const widgetsCreateFn = new nodejs.NodejsFunction(this, "WidgetsCreateFunction", {
      entry: "src/widgets/createHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: widgetsEnv,
    });

    const widgetsListFn = new nodejs.NodejsFunction(this, "WidgetsListFunction", {
      entry: "src/widgets/listHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: widgetsEnv,
    });

    const widgetsDeleteFn = new nodejs.NodejsFunction(this, "WidgetsDeleteFunction", {
      entry: "src/widgets/deleteHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: widgetsEnv,
    });

    const widgetsFieldsFn = new nodejs.NodejsFunction(this, "WidgetsFieldsFunction", {
      entry: "src/widgets/fieldsHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { TENANTS_TABLE: tenantsTable.tableName },
    });

    const widgetsDataFn = new nodejs.NodejsFunction(this, "WidgetsDataFunction", {
      entry: "src/widgets/dataHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      // Athena se sondea desde acá adentro (start -> poll -> resultados) —
      // ver `widgets/athenaQuery.ts`. Un poco más generoso que el resto por
      // las dudas, aunque a este volumen de datos suele responder en 1-3s.
      timeout: cdk.Duration.seconds(30),
      environment: {
        WIDGETS_TABLE: widgetsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        ATHENA_WORKGROUP: athenaWorkGroupName,
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
    analyticsBucket.grantWrite(parserFn);
    ticketsTable.grantWriteData(ingestFn);
    ticketsTable.grantReadWriteData(parserFn);
    ticketsTable.grantReadData(readFn);
    tenantsTable.grantReadData(ingestFn);
    tenantsTable.grantReadData(parserFn);
    tenantsTable.grantReadData(readFn);
    tenantsTable.grantReadData(widgetsCreateFn);
    tenantsTable.grantReadData(widgetsListFn);
    tenantsTable.grantReadData(widgetsDeleteFn);
    tenantsTable.grantReadData(widgetsFieldsFn);
    tenantsTable.grantReadData(widgetsDataFn);
    widgetsTable.grantWriteData(widgetsCreateFn);
    widgetsTable.grantReadData(widgetsListFn);
    widgetsTable.grantWriteData(widgetsDeleteFn); // DeleteItem cae bajo permisos de escritura
    widgetsTable.grantReadData(widgetsDataFn);

    // Athena ejecuta la consulta con las credenciales de quien la dispara
    // (este Lambda), no con un rol propio — así que acá van los permisos
    // que en RDS estarían implícitos en la conexión: leer el catálogo de
    // Glue, leer los datos fuente en S3, y escribir/leer en el bucket de
    // resultados de Athena (lo exige el servicio, no es opcional).
    widgetsDataFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${athenaWorkGroupName}`],
      }),
    );
    widgetsDataFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["glue:GetTable", "glue:GetDatabase", "glue:GetPartitions"],
        resources: [
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/${analyticsDatabaseName}`,
          `arn:aws:glue:${this.region}:${this.account}:table/${analyticsDatabaseName}/${analyticsTableName}`,
        ],
      }),
    );
    analyticsBucket.grantRead(widgetsDataFn);
    athenaResultsBucket.grantReadWrite(widgetsDataFn);

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

    // /widgets, /widgets/{widgetId}, /widgets/{widgetId}/data, /widgets/fields
    const widgets = api.root.addResource("widgets");
    widgets.addMethod("POST", new apigateway.LambdaIntegration(widgetsCreateFn), { apiKeyRequired: true });
    widgets.addMethod("GET", new apigateway.LambdaIntegration(widgetsListFn), { apiKeyRequired: true });

    const widgetsFields = widgets.addResource("fields");
    widgetsFields.addMethod("GET", new apigateway.LambdaIntegration(widgetsFieldsFn), { apiKeyRequired: true });

    const widgetById = widgets.addResource("{widgetId}");
    widgetById.addMethod("DELETE", new apigateway.LambdaIntegration(widgetsDeleteFn), { apiKeyRequired: true });

    const widgetData = widgetById.addResource("data");
    widgetData.addMethod("GET", new apigateway.LambdaIntegration(widgetsDataFn), { apiKeyRequired: true });

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
    new cdk.CfnOutput(this, "WidgetsTableName", { value: widgetsTable.tableName });
    new cdk.CfnOutput(this, "RawTicketsBucketName", { value: rawTicketsBucket.bucketName });
    new cdk.CfnOutput(this, "AnalyticsBucketName", { value: analyticsBucket.bucketName });
    new cdk.CfnOutput(this, "AnalyticsDatabaseName", { value: analyticsDatabaseName });
    new cdk.CfnOutput(this, "AnalyticsTableName", { value: analyticsTableName });
    new cdk.CfnOutput(this, "AthenaWorkGroupName", { value: athenaWorkGroupName });
  }
}
