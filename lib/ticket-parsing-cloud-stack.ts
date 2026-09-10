import * as cdk from "aws-cdk-lib/core";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as athena from "aws-cdk-lib/aws-athena";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
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

    // Agents: PK = TENANT#<id>, SK = AGENT#<agentId> — un robot instalado
    // en una PC del negocio. A diferencia de Tenants (una api-key
    // compartida por todo el negocio, pensada para el onboarding manual
    // original), cada agente tiene su propia api-key — se resuelve por
    // `apiKeyId-index`, mismo patrón que Tenants. Ver `agents/activateHandler.ts`.
    const agentsTable = new dynamodb.TableV2(this, "AgentsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: "apiKeyId-index",
          partitionKey: { name: "apiKeyId", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ActivationCodes: PK = CODE#<code>, global (no anidada bajo el
    // tenant) porque quien canjea un código todavía no sabe a qué tenant
    // pertenece. Se generan 5 por tenant al darlo de alta
    // (`onboard-tenant.ts`) — el tope de 5 robots es estructural: no hay
    // endpoint para generar más. El GSI por tenantId es solo para que el
    // dashboard pueda listar "3 de 5 usados", nunca se usa para el canje.
    const activationCodesTable = new dynamodb.TableV2(this, "ActivationCodesTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: "tenantId-index",
          partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // AssistantUsage: contador de rate limit por tenant para /assistant/ask
    // (sección 13 de PROYECTO.md) — PK = TENANT#<id>#WINDOW#MIN|DAY#<bucket>,
    // sin SK, un item por ventana. TTL propio (no un job de limpieza): cada
    // item expira solo apenas termina su ventana. Ver `assistant/rateLimit.ts`.
    const assistantUsageTable = new dynamodb.TableV2(this, "AssistantUsageTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
    });

    // SignupUsage: rate limit por IP para POST /signup (público, sin
    // api-key ni Cognito) — mismo patrón que AssistantUsage, PK =
    // IP#<ip>#WINDOW#HOUR#<bucket>. Ver `signup/rateLimit.ts`.
    const signupUsageTable = new dynamodb.TableV2(this, "SignupUsageTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
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
    // particiones (tenant/año/mes) a partir del patrón de abajo, sin nada
    // corriendo programado que las descubra — coherente con el resto del
    // sistema, serverless de verdad, sin infraestructura siempre prendida.
    //
    // Sin partición por día a propósito (se sacó 2026-08-09): con
    // proyección sintética, Athena no sabe qué particiones existen de
    // verdad — ante una query sin filtro de partición que la acote, hace un
    // LIST a S3 por CADA combinación posible del rango declarado para ver
    // si hay algo ahí. Con año+mes+día eso eran 2 años × 12 meses × 31 días
    // ≈ 744 LIST por query (la inmensa mayoría a carpetas vacías, dado el
    // volumen real de tickets) — eso fue lo que disparó el costo de S3 a
    // principios de agosto (~2.3M requests en 9 días, ver PROYECTO.md
    // sección 10.1).
    // Sacando `day`, el rango baja a 2 × 12 = 24 combinaciones por query.
    // El dato del día no se pierde — sigue en la columna `capturedat` de
    // cada fila, así que un filtro por fecha exacta sigue funcionando, solo
    // que ya no poda carpetas por día, lee el contenido del mes entero
    // (volumen bajo, no importa).
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
          "storage.location.template": `s3://${analyticsBucket.bucketName}/tenant=\${tenant}/year=\${year}/month=\${month}/`,
        },
        partitionKeys: [
          { name: "tenant", type: "string" },
          { name: "year", type: "string" },
          { name: "month", type: "string" },
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

    // ---- Cognito: login real del negocio para el dashboard -------------
    //
    // Hasta acá, `innoapp-web-user-client` iba a tener que leer con la
    // api-key COMPARTIDA del tenant — exponer eso en el bundle JS de un
    // navegador es inseguro (cualquiera con devtools la ve y pega a la API
    // a nombre del negocio). Todo lo que antes exigía esa api-key para
    // LECTURAS/acciones humanas (`GET /tickets`, `/widgets`,
    // `/agents`, `/activation-codes`, crear/borrar widgets) ahora exige un
    // usuario logueado. `POST /tickets` (el agente sube) y
    // `POST /agents/activate` (el código es la credencial) no cambian —
    // esos son máquina-a-máquina, Cognito no aplica ahí.
    //
    // `custom:tenantId` es el único vínculo entre "quién sos" y "qué
    // tenant es tuyo" — lo setea `onboard-tenant.ts` vía
    // `AdminCreateUserCommand` (API de administrador), el usuario final no
    // tiene forma de tocarlo ni de pedir uno ajeno. Alta manual a
    // propósito (`selfSignUpEnabled: false`) — mismo patrón artesanal que
    // el resto del onboarding (api-keys, códigos de activación).
    const userPool = new cognito.UserPool(this, "DashboardUserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      customAttributes: {
        tenantId: new cognito.StringAttribute({ mutable: false }),
      },
    });

    // Sin secreto: corre en el navegador, no hay dónde guardar un secreto
    // de cliente de forma segura. `userPassword` alcanza para un login con
    // email+contraseña — el refresh token queda habilitado igual, CDK lo
    // permite por default en todo `UserPoolClient` sin que haga falta
    // pedirlo acá.
    const userPoolClient = userPool.addClient("DashboardWebClient", {
      authFlows: { userPassword: true },
      generateSecret: false,
    });

    const dashboardAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "DashboardAuthorizer", {
      cognitoUserPools: [userPool],
    });

    // ---- API Gateway: se crea acá (antes que los Lambdas) porque el de
    // activación necesita saber a qué usage plan asociar la api-key de
    // cada agente nuevo -------------------------------------------------

    const api = new apigateway.RestApi(this, "TicketIngestApi", {
      description: "Ingesta (POST, api-key) y consulta (GET, login) de tickets de print-capture-agent, multi-tenant.",
      deployOptions: { throttlingRateLimit: 50, throttlingBurstLimit: 20 },
      // Necesario para que innoapp-web-user-client (un navegador) pueda
      // llamar a la API directo — antes solo la llamaban el agente y
      // scripts, nunca algo corriendo en un origin distinto.
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });

    // `defaultCorsPreflightOptions` de arriba solo cubre el preflight
    // (OPTIONS) y las respuestas que arma cada Lambda a mano (ver
    // `shared/http.ts`). Cualquier respuesta que NO pase por ese código —
    // un token vencido/inválido rechazado por el authorizer de Cognito
    // (401/403), o un Lambda que explota antes de llegar a un `return`
    // (502/500, justo lo que pasó con `WidgetsDataFunction` la primera vez
    // que Athena tardó de más) — sale directo de API Gateway sin el header
    // CORS, y el navegador la bloquea igual mostrando "Failed to fetch" en
    // vez del error real.
    for (const responseType of [
      apigateway.ResponseType.UNAUTHORIZED,
      apigateway.ResponseType.ACCESS_DENIED,
      apigateway.ResponseType.DEFAULT_4XX,
      apigateway.ResponseType.DEFAULT_5XX,
    ]) {
      api.addGatewayResponse(`GatewayResponse${responseType.responseType}`, {
        type: responseType,
        responseHeaders: {
          "Access-Control-Allow-Origin": "'*'",
          "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
        },
      });
    }

    // Nombre fijo, no el id autogenerado del recurso — `AgentsActivateFunction`
    // necesita identificar este usage plan, pero es UN método de la MISMA
    // api (`/agents/activate`), así que pasarle `usagePlan.usagePlanId`
    // (un token de CloudFormation) como env var o en su IAM policy crea un
    // ciclo real: Deployment → Method → Lambda → UsagePlan → Stage →
    // Deployment. Con el nombre (un string literal, no un token) el
    // Lambda lo resuelve en runtime vía `GetUsagePlansCommand` — ver
    // `agents/activateHandler.ts`.
    const usagePlanName = "ticket-parsing-cloud-default";
    const usagePlan = api.addUsagePlan("DefaultUsagePlan", {
      name: usagePlanName,
      throttle: { rateLimit: 10, burstLimit: 5 },
      quota: { limit: 10_000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ---- Lambdas -----------------------------------------------------

    const sharedBundling = { externalModules: ["@aws-sdk/*"] };
    const nodeRuntime = lambda.Runtime.NODEJS_20_X;

    // Pre-Authentication trigger — corta el login de un tenant bloqueado
    // (`scripts/set-tenant-status.ts`) antes de que Cognito le entregue una
    // sesión. Ver `tenants/preAuthHandler.ts` para el detalle y la
    // limitación conocida (no corre en REFRESH_TOKEN_AUTH).
    const preAuthFn = new nodejs.NodejsFunction(this, "PreAuthenticationFunction", {
      entry: "src/tenants/preAuthHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { TENANTS_TABLE: tenantsTable.tableName },
    });
    tenantsTable.grantReadData(preAuthFn);
    userPool.addTrigger(cognito.UserPoolOperation.PRE_AUTHENTICATION, preAuthFn);

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

    // Usado por ParserFunction (fallback de parseo) y AssistantAskFunction
    // (chat de datos, sección 13 de PROYECTO.md) — mismo modelo, mismos
    // permisos, factorizado acá para no duplicar el ARN del inference
    // profile ni el entitlement de Marketplace en dos lugares.
    const grantBedrockInvoke = (fn: nodejs.NodejsFunction) => {
      // Se necesita permiso sobre el inference profile (el recurso que de
      // hecho se invoca, sí es de esta cuenta) Y sobre el foundation model
      // base en cada región a la que el profile "us." puede despachar (esas
      // sí son un recurso compartido de la cuenta de servicio de Bedrock,
      // sin account ID en el ARN) — si falta cualquiera de los dos, Bedrock
      // rechaza la invocación según a qué región termine ruteando.
      fn.addToRolePolicy(
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
      // aws-marketplace:Subscribe ..." bajo ráfagas de llamadas seguidas. Son
      // acciones de entitlement a nivel de cuenta, no de un recurso puntual
      // — de ahí el "*".
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
          resources: ["*"],
        }),
      );
    };

    // Usado por WidgetsDataFunction y AssistantAskFunction (herramienta
    // `run_widget_query`, sección 13 de PROYECTO.md) — ambos corren la misma
    // consulta de Athena contra `ticket_items`, factorizado para no duplicar
    // el bloque de permisos en dos lugares.
    const grantAnalyticsQueryAccess = (fn: nodejs.NodejsFunction) => {
      // Athena ejecuta la consulta con las credenciales de quien la dispara
      // (este Lambda), no con un rol propio — así que acá van los permisos
      // que en RDS estarían implícitos en la conexión: leer el catálogo de
      // Glue, leer los datos fuente en S3, y escribir/leer en el bucket de
      // resultados de Athena (lo exige el servicio, no es opcional).
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:GetWorkGroup"],
          resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${athenaWorkGroupName}`],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["glue:GetTable", "glue:GetDatabase", "glue:GetPartitions"],
          resources: [
            `arn:aws:glue:${this.region}:${this.account}:catalog`,
            `arn:aws:glue:${this.region}:${this.account}:database/${analyticsDatabaseName}`,
            `arn:aws:glue:${this.region}:${this.account}:table/${analyticsDatabaseName}/${analyticsTableName}`,
          ],
        }),
      );
      analyticsBucket.grantRead(fn);
      athenaResultsBucket.grantReadWrite(fn);
    };

    const ingestFn = new nodejs.NodejsFunction(this, "IngestFunction", {
      entry: "src/ingest/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TICKETS_TABLE: ticketsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        AGENTS_TABLE: agentsTable.tableName,
        RAW_BUCKET: rawTicketsBucket.bucketName,
      },
    });

    const parserFn = new nodejs.NodejsFunction(this, "ParserFunction", {
      entry: "src/parser/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      // Con el fallback de Bedrock, un batch de 10 tickets que fallan el
      // parseo determinístico puede terminar haciendo hasta 10 invocaciones
      // secuenciales al modelo. Y los tickets-imagen (`rawKind: "escpos"`
      // raster) además reconstruyen el bitmap y mandan varias franjas PNG a
      // Bedrock vision — más lento y con más uso de memoria.
      timeout: cdk.Duration.seconds(120),
      memorySize: 1024,
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
      // Sin TENANTS_TABLE: el tenant sale del claim `custom:tenantId` del
      // JWT de Cognito (ya verificado por el authorizer), no de una
      // consulta por api-key — ver el comentario sobre Cognito más arriba.
      environment: { TICKETS_TABLE: ticketsTable.tableName },
    });

    // ---- Widgets: motor de gráficos configurables por el usuario -------
    //
    // Create/List/Delete solo tocan DynamoDB (Widgets) — el mismo perfil
    // de permisos que el resto de la API. Data es el único que necesita
    // Athena/Glue/S3, así que queda separado para no darle esos permisos
    // de más a los otros tres (principio de menor privilegio). Ninguno
    // necesita TENANTS_TABLE: el tenant sale del JWT de Cognito.

    const widgetsEnv = { WIDGETS_TABLE: widgetsTable.tableName };

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
      // Devuelve una lista blanca estática — no toca ninguna tabla.
      environment: {},
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

    grantBedrockInvoke(parserFn);

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
    // Solo ingest y parser siguen resolviendo tenant por api-key (agente
    // máquina-a-máquina) — el resto lee el tenant del JWT de Cognito, sin
    // tocar esta tabla.
    tenantsTable.grantReadData(ingestFn);
    tenantsTable.grantReadData(parserFn);
    widgetsTable.grantWriteData(widgetsCreateFn);
    widgetsTable.grantReadData(widgetsListFn);
    widgetsTable.grantWriteData(widgetsDeleteFn); // DeleteItem cae bajo permisos de escritura
    widgetsTable.grantReadData(widgetsDataFn);
    grantAnalyticsQueryAccess(widgetsDataFn);

    // ---- Agentes: activación por código de un solo uso -----------------
    //
    // /agents/activate es público (sin api-key) porque el código ES la
    // credencial — un agente todavía no tiene ninguna api-key antes de
    // canjearlo. /agents y /activation-codes sí exigen la api-key del
    // tenant (mismo mecanismo que /tickets y /widgets) — son para que el
    // dashboard liste sus robots y sus códigos, no para que un agente los
    // use.

    const activateFn = new nodejs.NodejsFunction(this, "AgentsActivateFunction", {
      entry: "src/agents/activateHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(15),
      environment: {
        AGENTS_TABLE: agentsTable.tableName,
        ACTIVATION_CODES_TABLE: activationCodesTable.tableName,
        USAGE_PLAN_NAME: usagePlanName,
      },
    });

    const agentsListFn = new nodejs.NodejsFunction(this, "AgentsListFunction", {
      entry: "src/agents/listHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { AGENTS_TABLE: agentsTable.tableName },
    });

    const agentsCodesFn = new nodejs.NodejsFunction(this, "AgentsCodesFunction", {
      entry: "src/agents/codesHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { ACTIVATION_CODES_TABLE: activationCodesTable.tableName },
    });

    const agentsHeartbeatFn = new nodejs.NodejsFunction(this, "AgentsHeartbeatFunction", {
      entry: "src/agents/heartbeatHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { AGENTS_TABLE: agentsTable.tableName },
    });

    const agentsUpdateLocationFn = new nodejs.NodejsFunction(this, "AgentsUpdateLocationFunction", {
      entry: "src/agents/updateLocationHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { AGENTS_TABLE: agentsTable.tableName },
    });

    // Acciones de plano de control de API Gateway (no son sobre un recurso
    // de negocio como una tabla, son sobre la API misma) — el formato de
    // recurso de IAM de API Gateway es "método HTTP + path", no un ARN de
    // recurso convencional. `/usageplans/*/keys` en vez del id puntual del
    // usage plan a propósito — ver el comentario sobre `usagePlanName` más
    // arriba, referenciar el id acá metería el mismo ciclo que se evitó
    // con el nombre.
    activateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["apigateway:GET"],
        resources: [`arn:aws:apigateway:${this.region}::/usageplans`],
      }),
    );
    activateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["apigateway:POST"],
        resources: [
          `arn:aws:apigateway:${this.region}::/apikeys`,
          `arn:aws:apigateway:${this.region}::/usageplans/*/keys`,
        ],
      }),
    );

    // ---- Registro de tenants (self-service) -----------------------------
    //
    // POST /signup (sección 12 de PROYECTO.md, punto 1) — reemplaza a correr
    // `onboard-tenant.ts` a mano: crea el tenant, sus 5 códigos de
    // activación y el usuario de Cognito, todo con la contraseña que la
    // persona elige en el formulario. A diferencia del script, NO crea la
    // api-key compartida del tenant — es legacy (fallback solo para agentes
    // no activados por código), un tenant nuevo nunca la necesita porque
    // todos sus agentes se activan por código desde el vamos.

    const signupFn = new nodejs.NodejsFunction(this, "SignupFunction", {
      entry: "src/signup/handler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(15),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        TENANTS_TABLE: tenantsTable.tableName,
        ACTIVATION_CODES_TABLE: activationCodesTable.tableName,
        SIGNUP_USAGE_TABLE: signupUsageTable.tableName,
      },
    });
    tenantsTable.grantWriteData(signupFn);
    activationCodesTable.grantWriteData(signupFn);
    signupUsageTable.grantReadWriteData(signupFn);
    signupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminDeleteUser"],
        resources: [userPool.userPoolArn],
      }),
    );

    // ---- Perfil y onboarding del negocio -----------------------------
    // GET /me expone únicamente metadatos públicos del tenant. PATCH
    // persiste el recorrido y puede crear el dashboard inicial de forma
    // transaccional e idempotente.
    const meGetFn = new nodejs.NodejsFunction(this, "MeGetFunction", {
      entry: "src/me/getHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: { TENANTS_TABLE: tenantsTable.tableName },
    });
    const onboardingUpdateFn = new nodejs.NodejsFunction(this, "OnboardingUpdateFunction", {
      entry: "src/me/updateOnboardingHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
        AGENTS_TABLE: agentsTable.tableName,
        WIDGETS_TABLE: widgetsTable.tableName,
      },
    });
    tenantsTable.grantReadData(meGetFn);
    tenantsTable.grantReadWriteData(onboardingUpdateFn);
    agentsTable.grantReadData(onboardingUpdateFn);
    widgetsTable.grantWriteData(onboardingUpdateFn);

    // ---- Asistente de datos (chat) --------------------------------------
    //
    // Fase 2 (PROYECTO.md sección 13): además del circuito Cognito → Lambda
    // → Bedrock de la Fase 1, el modelo ahora tiene tool-use sobre dos
    // herramientas acotadas — `run_widget_query` (misma consulta whitelisted
    // que usan los widgets, nunca SQL libre del modelo) y `list_tickets`
    // (mismo query que `read/handler.ts`, recortado). Mismo principio que
    // el resto de la API: el tenant nunca sale del modelo, siempre del JWT.

    // Este Lambda loguea pregunta+respuesta de cada consulta al asistente
    // (`assistant/askHandler.ts:logQa`) — a diferencia del resto de la API,
    // esos logs llevan contenido real de negocio (montos, productos), no
    // solo metadata técnica. El resto de los Lambdas se queda con la
    // retención default (indefinida) porque solo loguean errores; acá se
    // acota a propósito. Se crea el LogGroup a mano (en vez de la prop
    // `logRetention`, que arma un Lambda custom-resource propio por detrás
    // solo para setear esto) para no sumar un recurso extra al stack.
    const assistantAskLogGroup = new logs.LogGroup(this, "AssistantAskLogGroup", {
      // Nombre explícito, no el autogenerado por CDK — sin esto queda un
      // nombre ilegible en vez de seguir la convención `/aws/lambda/...`
      // que usa el resto de los Lambdas de la API.
      logGroupName: "/aws/lambda/ticket-parsing-cloud-assistant-ask",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const assistantAskFn = new nodejs.NodejsFunction(this, "AssistantAskFunction", {
      entry: "src/assistant/askHandler.ts",
      runtime: nodeRuntime,
      bundling: sharedBundling,
      // Con tool-use, una pregunta típica dispara 2 llamadas a Bedrock más
      // una consulta a Athena/DynamoDB en el medio — más margen que
      // ParserFunction porque acá se suman ambas latencias.
      timeout: cdk.Duration.seconds(60),
      environment: {
        BEDROCK_MODEL_ID: bedrockModelId,
        TICKETS_TABLE: ticketsTable.tableName,
        ATHENA_WORKGROUP: athenaWorkGroupName,
        ASSISTANT_USAGE_TABLE: assistantUsageTable.tableName,
      },
      logGroup: assistantAskLogGroup,
    });
    grantBedrockInvoke(assistantAskFn);
    grantAnalyticsQueryAccess(assistantAskFn);
    ticketsTable.grantReadData(assistantAskFn);
    assistantUsageTable.grantReadWriteData(assistantAskFn);

    agentsTable.grantReadData(ingestFn);
    agentsTable.grantReadWriteData(activateFn);
    activationCodesTable.grantReadWriteData(activateFn);
    agentsTable.grantReadData(agentsListFn);
    activationCodesTable.grantReadData(agentsCodesFn);
    agentsTable.grantReadWriteData(agentsHeartbeatFn);
    agentsTable.grantReadWriteData(agentsUpdateLocationFn);

    // ---- API Gateway: rutas ---------------------------------------------

    // Opciones de método compartidas por todo lo que usa el dashboard (una
    // persona logueada) — Cognito, no api-key.
    const dashboardAuth = { authorizer: dashboardAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO };

    const tickets = api.root.addResource("tickets");
    // El agente sube con SU api-key (o la del tenant, fallback legacy) —
    // ver ingest/handler.ts y la sección 9.3 de PROYECTO.md.
    tickets.addMethod("POST", new apigateway.LambdaIntegration(ingestFn), {
      apiKeyRequired: true,
    });
    tickets.addMethod("GET", new apigateway.LambdaIntegration(readFn), dashboardAuth);

    // /widgets, /widgets/{widgetId}, /widgets/{widgetId}/data, /widgets/fields
    const widgets = api.root.addResource("widgets");
    widgets.addMethod("POST", new apigateway.LambdaIntegration(widgetsCreateFn), dashboardAuth);
    widgets.addMethod("GET", new apigateway.LambdaIntegration(widgetsListFn), dashboardAuth);

    const widgetsFields = widgets.addResource("fields");
    widgetsFields.addMethod("GET", new apigateway.LambdaIntegration(widgetsFieldsFn), dashboardAuth);

    const widgetById = widgets.addResource("{widgetId}");
    widgetById.addMethod("DELETE", new apigateway.LambdaIntegration(widgetsDeleteFn), dashboardAuth);

    const widgetData = widgetById.addResource("data");
    widgetData.addMethod("GET", new apigateway.LambdaIntegration(widgetsDataFn), dashboardAuth);

    // /agents, /agents/activate, /activation-codes
    const agents = api.root.addResource("agents");
    agents.addMethod("GET", new apigateway.LambdaIntegration(agentsListFn), dashboardAuth);

    // El código de activación ES la credencial — sin api-key, sin Cognito,
    // público. Ver agents/activateHandler.ts.
    const agentsActivate = agents.addResource("activate");
    agentsActivate.addMethod("POST", new apigateway.LambdaIntegration(activateFn), { apiKeyRequired: false });

    const agentsHeartbeat = agents.addResource("heartbeat");
    agentsHeartbeat.addMethod("POST", new apigateway.LambdaIntegration(agentsHeartbeatFn), { apiKeyRequired: true });

    const agentById = agents.addResource("{agentId}");
    const agentLocation = agentById.addResource("location");
    agentLocation.addMethod("PATCH", new apigateway.LambdaIntegration(agentsUpdateLocationFn), dashboardAuth);

    const activationCodes = api.root.addResource("activation-codes");
    activationCodes.addMethod("GET", new apigateway.LambdaIntegration(agentsCodesFn), dashboardAuth);

    // Público — la persona todavía no tiene ninguna credencial, es
    // literalmente cómo consigue la primera. Ver "Registro de tenants" más arriba.
    const signup = api.root.addResource("signup");
    signup.addMethod("POST", new apigateway.LambdaIntegration(signupFn), { apiKeyRequired: false });

    const me = api.root.addResource("me");
    me.addMethod("GET", new apigateway.LambdaIntegration(meGetFn), dashboardAuth);
    me.addResource("onboarding").addMethod("PATCH", new apigateway.LambdaIntegration(onboardingUpdateFn), dashboardAuth);

    // /assistant/ask — dashboard humano logueado, no máquina (igual que
    // /tickets GET y /widgets). Ver "Asistente de datos (chat)" más arriba.
    const assistant = api.root.addResource("assistant");
    assistant.addResource("ask").addMethod("POST", new apigateway.LambdaIntegration(assistantAskFn), dashboardAuth);

    // ---- Outputs -------------------------------------------------------

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "UsagePlanId", { value: usagePlan.usagePlanId });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "TicketsTableName", { value: ticketsTable.tableName });
    new cdk.CfnOutput(this, "TenantsTableName", { value: tenantsTable.tableName });
    new cdk.CfnOutput(this, "WidgetsTableName", { value: widgetsTable.tableName });
    new cdk.CfnOutput(this, "AgentsTableName", { value: agentsTable.tableName });
    new cdk.CfnOutput(this, "ActivationCodesTableName", { value: activationCodesTable.tableName });
    new cdk.CfnOutput(this, "AssistantUsageTableName", { value: assistantUsageTable.tableName });
    new cdk.CfnOutput(this, "RawTicketsBucketName", { value: rawTicketsBucket.bucketName });
    new cdk.CfnOutput(this, "AnalyticsBucketName", { value: analyticsBucket.bucketName });
    new cdk.CfnOutput(this, "AnalyticsDatabaseName", { value: analyticsDatabaseName });
    new cdk.CfnOutput(this, "AnalyticsTableName", { value: analyticsTableName });
    new cdk.CfnOutput(this, "AthenaWorkGroupName", { value: athenaWorkGroupName });
  }
}
