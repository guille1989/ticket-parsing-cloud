import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

type Item = Record<string, any>;

/**
 * DynamoDB en memoria con lo justo para probar el ciclo de vida de los asuntos: Get, Put,
 * Query (por prefijo o por rango de SK) y Update con condición de igualdad sobre el estado.
 * No intenta ser un emulador general: si el código usa otra expresión, el fake falla ruidoso.
 */
export function createFakeDynamo() {
  const items = new Map<string, Item>();
  const id = (pk: string, sk: string) => `${pk}|${sk}`;

  const conditionFailed = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

  async function send(command: unknown): Promise<any> {
    if (command instanceof GetCommand) {
      const { pk, sk } = command.input.Key as Item;
      return { Item: items.get(id(pk, sk)) };
    }

    if (command instanceof PutCommand) {
      const item = command.input.Item as Item;
      if (Object.values(item).some((value) => value === undefined)) throw new Error("DynamoDB rechaza valores undefined");
      items.set(id(item.pk, item.sk), structuredClone(item));
      return {};
    }

    if (command instanceof QueryCommand) {
      const { ExpressionAttributeValues: values = {}, KeyConditionExpression: condition = "", ScanIndexForward = true } = command.input;
      let rows = [...items.values()].filter((item) => item.pk === values[":pk"]);
      if (condition.includes("begins_with(sk, :prefix)")) rows = rows.filter((item) => item.sk.startsWith(values[":prefix"]));
      else if (condition.includes("sk BETWEEN :since AND :until")) rows = rows.filter((item) => item.sk >= values[":since"] && item.sk <= values[":until"]);
      else if (/sk\s*(>=|<)/.test(condition)) throw new Error("DynamoDB no admite dos condiciones sobre el SK: usar BETWEEN");
      else throw new Error(`condición de Query no soportada por el fake: ${condition}`);
      rows.sort((a, b) => (a.sk < b.sk ? -1 : 1));
      if (!ScanIndexForward) rows.reverse();
      return { Items: rows.map((row) => structuredClone(row)) };
    }

    if (command instanceof UpdateCommand) {
      const { Key, UpdateExpression = "", ConditionExpression = "", ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {}, ReturnValues } = command.input;
      const current = items.get(id(Key!.pk, Key!.sk));
      if (ConditionExpression.includes("attribute_exists(pk)") && !current) throw conditionFailed();
      if (ConditionExpression.includes("#status = :expected") && current?.status !== values[":expected"]) throw conditionFailed();
      if (!current) throw new Error("Update sin condición sobre un item inexistente: el fake no lo soporta");

      for (const assignment of UpdateExpression.replace(/^SET /, "").split(", ")) {
        const [left, right] = assignment.split(" = ");
        current[names[left] ?? left] = values[right];
      }
      return ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(current) } : {};
    }

    throw new Error(`comando no soportado por el fake: ${(command as object)?.constructor?.name}`);
  }

  return { send, items, get: (pk: string, sk: string) => items.get(id(pk, sk)) };
}
